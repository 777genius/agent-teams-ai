import {
  ApplicationCommandBeginOutcome,
  type ApplicationCommandErrorClassification,
  ApplicationCommandFailureKind,
  type ApplicationCommandIdentity,
  type ApplicationCommandLedgerBeginResult,
  ApplicationCommandLedgerErrorCode,
  type ApplicationCommandLedgerRecord,
  ApplicationCommandRunOutcome,
} from '../../contracts';
import { type ApplicationCommandJsonValue, stableJsonStringify } from '../domain/stableJson';

import type { ApplicationCommandHasher, ApplicationCommandLedgerStore } from './ports';

const STORED_RESULT_VERSION_KEY = '__applicationCommandResultVersion';
const STORED_RESULT_VERSION = 1;
const DEFAULT_STARTED_STALE_AFTER_MS = 60_000;

export type ApplicationCommandResult = ApplicationCommandJsonValue | undefined;

export interface ApplicationCommandRunnerOptions {
  ledger: ApplicationCommandLedgerStore;
  hasher: ApplicationCommandHasher;
  clock?: () => Date;
  stringifyError?: (error: unknown) => string;
  startedStaleAfterMs?: number;
}

export type ApplicationCommandReconciliation<TResult extends ApplicationCommandResult> =
  | { outcome: 'applied'; result: TResult }
  | { outcome: 'not_applied'; message?: string }
  | { outcome: 'unknown'; message?: string };

export interface ApplicationCommandRunInput<
  TOperation extends string = string,
  TResult extends ApplicationCommandResult = ApplicationCommandResult,
> extends ApplicationCommandIdentity<TOperation> {
  payload: ApplicationCommandJsonValue;
  metadata?: ApplicationCommandJsonValue;
  payloadHash?: string;
  startedStaleAfterMs?: number;
  classifyError(error: unknown): ApplicationCommandErrorClassification;
  reconcile?(
    record: ApplicationCommandLedgerRecord<TOperation>
  ): Promise<ApplicationCommandReconciliation<TResult>>;
}

export interface ApplicationCommandRunResult<
  TResult extends ApplicationCommandResult,
  TOperation extends string = string,
> {
  outcome: ApplicationCommandRunOutcome;
  result: TResult;
  record: ApplicationCommandLedgerRecord<TOperation>;
}

export class ApplicationCommandLedgerError extends Error {
  readonly cause: unknown;

  constructor(
    readonly code: ApplicationCommandLedgerErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {},
    cause?: unknown
  ) {
    super(message);
    this.name = 'ApplicationCommandLedgerError';
    this.cause = cause;
  }
}

export class ApplicationCommandRunner {
  private readonly ledger: ApplicationCommandLedgerStore;
  private readonly hasher: ApplicationCommandHasher;
  private readonly clock: () => Date;
  private readonly stringifyError: (error: unknown) => string;
  private readonly startedStaleAfterMs: number;

  constructor(options: ApplicationCommandRunnerOptions) {
    this.ledger = options.ledger;
    this.hasher = options.hasher;
    this.clock = options.clock ?? (() => new Date());
    this.stringifyError = options.stringifyError ?? stringifyError;
    this.startedStaleAfterMs = options.startedStaleAfterMs ?? DEFAULT_STARTED_STALE_AFTER_MS;
    validatePositiveInteger('startedStaleAfterMs', this.startedStaleAfterMs);
  }

  async run<TResult extends ApplicationCommandResult, TOperation extends string = string>(
    input: ApplicationCommandRunInput<TOperation, TResult>,
    execute: (record: ApplicationCommandLedgerRecord<TOperation>) => Promise<TResult>
  ): Promise<ApplicationCommandRunResult<TResult, TOperation>> {
    return this.runAttempt(input, execute, false);
  }

  private async runAttempt<TResult extends ApplicationCommandResult, TOperation extends string>(
    input: ApplicationCommandRunInput<TOperation, TResult>,
    execute: (record: ApplicationCommandLedgerRecord<TOperation>) => Promise<TResult>,
    retriedAfterReconciliation: boolean
  ): Promise<ApplicationCommandRunResult<TResult, TOperation>> {
    this.validateInput(input);
    const payloadJson = this.stringifyInput('payload', input.payload);
    const computedPayloadHash = this.hasher.hashString(payloadJson);
    if (input.payloadHash !== undefined && input.payloadHash !== computedPayloadHash) {
      throw new ApplicationCommandLedgerError(
        ApplicationCommandLedgerErrorCode.InvalidInput,
        'Application command payloadHash does not match the canonical payload',
        { field: 'payloadHash', expectedHash: computedPayloadHash }
      );
    }
    const payloadHash = input.payloadHash ?? computedPayloadHash;
    const nowIso = this.clock().toISOString();
    const startedStaleAfterMs = input.startedStaleAfterMs ?? this.startedStaleAfterMs;
    validatePositiveInteger('startedStaleAfterMs', startedStaleAfterMs);
    const metadataJson =
      input.metadata === undefined ? null : this.stringifyInput('metadata', input.metadata);

    let begin: ApplicationCommandLedgerBeginResult<TOperation>;
    try {
      begin = await this.ledger.begin({
        namespace: input.namespace,
        scopeKey: input.scopeKey,
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        payloadHash,
        metadataJson,
        nowIso,
        startedStaleAfterMs,
      });
    } catch (error) {
      throw this.storeError('begin', 'Application command could not be started', input, error);
    }

    if (begin.outcome === ApplicationCommandBeginOutcome.DuplicateCompleted) {
      return {
        outcome: ApplicationCommandRunOutcome.Replayed,
        result: this.replayResult<TResult, TOperation>(begin.record),
        record: begin.record,
      };
    }

    if (
      begin.outcome !== ApplicationCommandBeginOutcome.Started &&
      begin.outcome !== ApplicationCommandBeginOutcome.RetryStarted
    ) {
      if (begin.outcome === ApplicationCommandBeginOutcome.UnknownAfterTimeout && input.reconcile) {
        return this.reconcileUnknown(input, execute, begin.record, retriedAfterReconciliation);
      }
      throw this.toBeginError(begin);
    }

    const activeIdentity = {
      namespace: begin.record.namespace,
      scopeKey: begin.record.scopeKey,
      commandId: begin.record.commandId,
      attemptCount: begin.record.attemptCount,
    };

    let result: TResult;
    try {
      result = await execute(begin.record);
    } catch (error) {
      const classification = this.classifyExecutionError(input, error);
      await this.persistFailure(activeIdentity, classification, error, 'execute');
      throw error;
    }

    let resultJson: string;
    try {
      resultJson = serializeResult(result);
    } catch (error) {
      await this.persistFailure(
        activeIdentity,
        {
          failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout,
          message: `Application command completed but result serialization failed: ${this.describeError(error)}`,
        },
        error,
        'serialize_result'
      );
      throw error;
    }

    await this.markCompleted(activeIdentity, resultJson);

    const record = await this.readCommittedRecord<TOperation>(activeIdentity);
    return {
      outcome:
        begin.outcome === ApplicationCommandBeginOutcome.RetryStarted
          ? ApplicationCommandRunOutcome.Retried
          : ApplicationCommandRunOutcome.Executed,
      result,
      record,
    };
  }

  private async reconcileUnknown<
    TResult extends ApplicationCommandResult,
    TOperation extends string,
  >(
    input: ApplicationCommandRunInput<TOperation, TResult>,
    execute: (record: ApplicationCommandLedgerRecord<TOperation>) => Promise<TResult>,
    record: ApplicationCommandLedgerRecord<TOperation>,
    retriedAfterReconciliation: boolean
  ): Promise<ApplicationCommandRunResult<TResult, TOperation>> {
    if (retriedAfterReconciliation || !input.reconcile) {
      throw this.toBeginError({
        outcome: ApplicationCommandBeginOutcome.UnknownAfterTimeout,
        record,
      });
    }

    let reconciliation: ApplicationCommandReconciliation<TResult>;
    try {
      reconciliation = await input.reconcile(record);
    } catch (error) {
      throw new ApplicationCommandLedgerError(
        ApplicationCommandLedgerErrorCode.UnknownOutcome,
        'Application command reconciliation failed',
        { ...commandDetails(record), status: record.status },
        error
      );
    }

    if (reconciliation.outcome === 'unknown') {
      throw new ApplicationCommandLedgerError(
        ApplicationCommandLedgerErrorCode.UnknownOutcome,
        reconciliation.message ??
          'Application command outcome remains unknown after reconciliation',
        { ...commandDetails(record), status: record.status }
      );
    }

    const activeIdentity = {
      namespace: record.namespace,
      scopeKey: record.scopeKey,
      commandId: record.commandId,
      attemptCount: record.attemptCount,
    };

    if (reconciliation.outcome === 'applied') {
      const resultJson = this.stringifyResultOrThrow(reconciliation.result);
      await this.markCompleted(activeIdentity, resultJson);
      return {
        outcome: ApplicationCommandRunOutcome.Reconciled,
        result: reconciliation.result,
        record: await this.readCommittedRecord<TOperation>(activeIdentity),
      };
    }

    await this.persistFailure(
      activeIdentity,
      {
        failureKind: ApplicationCommandFailureKind.Retryable,
        message:
          reconciliation.message ?? 'Reconciliation proved the command side effect was not applied',
      },
      new Error(reconciliation.message ?? 'Command side effect not applied'),
      'reconcile_not_applied'
    );
    return this.runAttempt(input, execute, true);
  }

  private stringifyResultOrThrow(result: ApplicationCommandResult): string {
    try {
      return serializeResult(result);
    } catch (error) {
      throw new ApplicationCommandLedgerError(
        ApplicationCommandLedgerErrorCode.UnknownOutcome,
        'Reconciled application command result could not be serialized',
        { stage: 'serialize_reconciled_result' },
        error
      );
    }
  }

  private async markCompleted(
    identity: { namespace: string; scopeKey: string; commandId: string; attemptCount: number },
    resultJson: string
  ): Promise<void> {
    try {
      await this.ledger.markCompleted({
        ...identity,
        resultHash: this.hasher.hashString(resultJson),
        resultJson,
        completedAtIso: this.clock().toISOString(),
      });
    } catch (error) {
      throw this.storeError(
        'mark_completed',
        'Application command side effect completed but ledger completion could not be confirmed',
        identity,
        error,
        { sideEffectCompleted: true }
      );
    }
  }

  private classifyExecutionError<TOperation extends string>(
    input: ApplicationCommandRunInput<TOperation>,
    error: unknown
  ): ApplicationCommandErrorClassification {
    try {
      return input.classifyError(error);
    } catch (classificationError) {
      return {
        failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout,
        message: [
          `Application command failed: ${this.describeError(error)}`,
          `Error classification also failed: ${this.describeError(classificationError)}`,
        ].join('. '),
      };
    }
  }

  private async persistFailure(
    identity: { namespace: string; scopeKey: string; commandId: string; attemptCount: number },
    classification: ApplicationCommandErrorClassification,
    originalError: unknown,
    stage: 'execute' | 'serialize_result' | 'reconcile_not_applied'
  ): Promise<void> {
    try {
      await this.ledger.markFailed({
        ...identity,
        failureKind: classification.failureKind,
        errorMessage: classification.message ?? this.describeError(originalError),
        completedAtIso: this.clock().toISOString(),
      });
    } catch (storeFailure) {
      throw new ApplicationCommandLedgerError(
        ApplicationCommandLedgerErrorCode.StoreRejected,
        'Application command failed and its ledger failure could not be persisted',
        {
          ...identity,
          stage,
          originalError: this.describeError(originalError),
          storeError: this.describeError(storeFailure),
        },
        originalError
      );
    }
  }

  private async readCommittedRecord<TOperation extends string>(input: {
    namespace: string;
    scopeKey: string;
    commandId: string;
  }): Promise<ApplicationCommandLedgerRecord<TOperation>> {
    let record: ApplicationCommandLedgerRecord<TOperation> | null;
    try {
      record = await this.ledger.getByCommandId<TOperation>(input);
    } catch (error) {
      throw this.storeError(
        'read_after_complete',
        'Application command completed but its committed ledger record could not be read',
        input,
        error,
        { sideEffectCompleted: true }
      );
    }
    if (!record) {
      throw new ApplicationCommandLedgerError(
        ApplicationCommandLedgerErrorCode.RecordNotFound,
        'Application command ledger record disappeared after completion',
        input
      );
    }
    return record;
  }

  private replayResult<TResult extends ApplicationCommandResult, TOperation extends string>(
    record: ApplicationCommandLedgerRecord<TOperation>
  ): TResult {
    if (record.resultJson === null || record.resultHash === null) {
      throw new ApplicationCommandLedgerError(
        ApplicationCommandLedgerErrorCode.CompletedResultMissing,
        'Completed application command is missing a stored result',
        commandDetails(record)
      );
    }

    const actualResultHash = this.hasher.hashString(record.resultJson);
    if (actualResultHash !== record.resultHash) {
      throw new ApplicationCommandLedgerError(
        ApplicationCommandLedgerErrorCode.CompletedResultInvalid,
        'Completed application command result failed its integrity check',
        { ...commandDetails(record), expectedHash: record.resultHash, actualHash: actualResultHash }
      );
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(record.resultJson) as unknown;
    } catch (error) {
      throw new ApplicationCommandLedgerError(
        ApplicationCommandLedgerErrorCode.CompletedResultInvalid,
        'Completed application command result is not valid JSON',
        commandDetails(record),
        error
      );
    }

    if (!isStoredResultEnvelope(parsed)) {
      return parsed as TResult;
    }
    return (parsed.kind === 'void' ? undefined : parsed.value) as TResult;
  }

  private toBeginError<TOperation extends string>(
    begin: Exclude<
      ApplicationCommandLedgerBeginResult<TOperation>,
      | { outcome: ApplicationCommandBeginOutcome.Started }
      | { outcome: ApplicationCommandBeginOutcome.RetryStarted }
      | { outcome: ApplicationCommandBeginOutcome.DuplicateCompleted }
    >
  ): ApplicationCommandLedgerError {
    if (begin.outcome === ApplicationCommandBeginOutcome.Conflict) {
      return new ApplicationCommandLedgerError(
        ApplicationCommandLedgerErrorCode.Conflict,
        `Application command ledger conflict: ${begin.reason}`,
        {
          reason: begin.reason,
          requested: begin.requested,
          existing: begin.existing,
        }
      );
    }

    const details = {
      ...commandDetails(begin.record),
      status: begin.record.status,
      lastError: begin.record.lastError,
    };

    if (begin.outcome === ApplicationCommandBeginOutcome.AlreadyStarted) {
      return new ApplicationCommandLedgerError(
        ApplicationCommandLedgerErrorCode.AlreadyStarted,
        'Application command is already in progress',
        details
      );
    }

    if (begin.outcome === ApplicationCommandBeginOutcome.FailedTerminal) {
      return new ApplicationCommandLedgerError(
        ApplicationCommandLedgerErrorCode.FailedTerminal,
        'Application command failed terminally and cannot be retried',
        details
      );
    }

    return new ApplicationCommandLedgerError(
      ApplicationCommandLedgerErrorCode.UnknownOutcome,
      'Application command outcome is unknown and must be reconciled before retry',
      details
    );
  }

  private validateInput(input: ApplicationCommandRunInput): void {
    for (const [field, value] of Object.entries({
      namespace: input.namespace,
      scopeKey: input.scopeKey,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      operation: input.operation,
    })) {
      if (typeof value !== 'string' || value.trim().length === 0) {
        throw new ApplicationCommandLedgerError(
          ApplicationCommandLedgerErrorCode.InvalidInput,
          `Application command ${field} must be a non-empty string`,
          { field }
        );
      }
    }
    if (input.payloadHash?.trim().length === 0) {
      throw new ApplicationCommandLedgerError(
        ApplicationCommandLedgerErrorCode.InvalidInput,
        'Application command payloadHash must be a non-empty string when provided',
        { field: 'payloadHash' }
      );
    }
  }

  private stringifyInput(field: 'payload' | 'metadata', value: unknown): string {
    try {
      return stableJsonStringify(value);
    } catch (error) {
      throw new ApplicationCommandLedgerError(
        ApplicationCommandLedgerErrorCode.InvalidInput,
        `Application command ${field} must contain only strict JSON values`,
        { field, error: this.describeError(error) },
        error
      );
    }
  }

  private storeError(
    stage: 'begin' | 'mark_completed' | 'read_after_complete',
    message: string,
    identity: { namespace: string; scopeKey: string; commandId: string },
    error: unknown,
    details: Record<string, unknown> = {}
  ): ApplicationCommandLedgerError {
    return new ApplicationCommandLedgerError(
      ApplicationCommandLedgerErrorCode.StoreRejected,
      message,
      { ...identity, stage, storeError: this.describeError(error), ...details },
      error
    );
  }

  private describeError(error: unknown): string {
    try {
      return this.stringifyError(error);
    } catch {
      return stringifyError(error);
    }
  }
}

function serializeResult(result: ApplicationCommandResult): string {
  if (result === undefined) {
    return stableJsonStringify({
      [STORED_RESULT_VERSION_KEY]: STORED_RESULT_VERSION,
      kind: 'void',
    });
  }
  return stableJsonStringify({
    [STORED_RESULT_VERSION_KEY]: STORED_RESULT_VERSION,
    kind: 'json',
    value: result,
  });
}

function isStoredResultEnvelope(
  value: unknown
): value is { kind: 'void' } | { kind: 'json'; value: ApplicationCommandJsonValue } {
  if (!isRecord(value) || value[STORED_RESULT_VERSION_KEY] !== STORED_RESULT_VERSION) {
    return false;
  }
  return value.kind === 'void' || (value.kind === 'json' && 'value' in value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function commandDetails(input: {
  namespace: string;
  scopeKey: string;
  commandId: string;
}): Record<string, string> {
  return {
    namespace: input.namespace,
    scopeKey: input.scopeKey,
    commandId: input.commandId,
  };
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validatePositiveInteger(field: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new ApplicationCommandLedgerError(
      ApplicationCommandLedgerErrorCode.InvalidInput,
      `Application command ${field} must be a positive integer`,
      { field }
    );
  }
}
