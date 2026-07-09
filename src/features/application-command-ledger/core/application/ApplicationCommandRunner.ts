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
import { stableJsonStringify } from '../domain/stableJson';

import type { ApplicationCommandHasher, ApplicationCommandLedgerStore } from './ports';

export interface ApplicationCommandRunnerOptions {
  ledger: ApplicationCommandLedgerStore;
  hasher: ApplicationCommandHasher;
  clock?: () => Date;
  stringifyError?: (error: unknown) => string;
}

export interface ApplicationCommandRunInput<TOperation extends string = string>
  extends ApplicationCommandIdentity<TOperation> {
  payload: unknown;
  metadata?: unknown;
  payloadHash?: string;
  classifyError(error: unknown): ApplicationCommandErrorClassification;
}

export interface ApplicationCommandRunResult<TResult, TOperation extends string = string> {
  outcome: ApplicationCommandRunOutcome;
  result: TResult;
  record: ApplicationCommandLedgerRecord<TOperation>;
}

export class ApplicationCommandLedgerError extends Error {
  constructor(
    readonly code: ApplicationCommandLedgerErrorCode,
    message: string,
    readonly details: Record<string, unknown> = {}
  ) {
    super(message);
    this.name = 'ApplicationCommandLedgerError';
  }
}

export class ApplicationCommandRunner {
  private readonly ledger: ApplicationCommandLedgerStore;
  private readonly hasher: ApplicationCommandHasher;
  private readonly clock: () => Date;
  private readonly stringifyError: (error: unknown) => string;

  constructor(options: ApplicationCommandRunnerOptions) {
    this.ledger = options.ledger;
    this.hasher = options.hasher;
    this.clock = options.clock ?? (() => new Date());
    this.stringifyError = options.stringifyError ?? stringifyError;
  }

  async run<TResult, TOperation extends string = string>(
    input: ApplicationCommandRunInput<TOperation>,
    execute: () => Promise<TResult>
  ): Promise<ApplicationCommandRunResult<TResult, TOperation>> {
    this.validateIdentity(input);
    const payloadHash = input.payloadHash ?? this.hasher.hashJson(input.payload);
    const nowIso = this.clock().toISOString();
    const begin = await this.ledger.begin({
      namespace: input.namespace,
      scopeKey: input.scopeKey,
      commandId: input.commandId,
      idempotencyKey: input.idempotencyKey,
      operation: input.operation,
      payloadHash,
      metadataJson: input.metadata === undefined ? null : stableJsonStringify(input.metadata),
      nowIso,
    });

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
      throw this.toBeginError(begin);
    }

    let result: TResult;
    try {
      result = await execute();
    } catch (error) {
      const classification = input.classifyError(error);
      await this.ledger.markFailed({
        namespace: input.namespace,
        scopeKey: input.scopeKey,
        commandId: input.commandId,
        failureKind: classification.failureKind,
        errorMessage: classification.message ?? this.stringifyError(error),
        completedAtIso: this.clock().toISOString(),
      });
      throw error;
    }

    let resultJson: string;
    try {
      resultJson = stableJsonStringify(result);
    } catch (error) {
      await this.ledger.markFailed({
        namespace: input.namespace,
        scopeKey: input.scopeKey,
        commandId: input.commandId,
        failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout,
        errorMessage: `Application command completed but result serialization failed: ${this.stringifyError(error)}`,
        completedAtIso: this.clock().toISOString(),
      });
      throw error;
    }

    await this.ledger.markCompleted({
      namespace: input.namespace,
      scopeKey: input.scopeKey,
      commandId: input.commandId,
      resultHash: this.hasher.hashString(resultJson),
      resultJson,
      completedAtIso: this.clock().toISOString(),
    });
    const record = await this.readCommittedRecord<TOperation>(input);
    return {
      outcome:
        begin.outcome === ApplicationCommandBeginOutcome.RetryStarted
          ? ApplicationCommandRunOutcome.Retried
          : ApplicationCommandRunOutcome.Executed,
      result,
      record,
    };
  }

  private async readCommittedRecord<TOperation extends string>(
    input: ApplicationCommandIdentity<TOperation>
  ): Promise<ApplicationCommandLedgerRecord<TOperation>> {
    const record = await this.ledger.getByCommandId<TOperation>({
      namespace: input.namespace,
      scopeKey: input.scopeKey,
      commandId: input.commandId,
    });
    if (!record) {
      throw new ApplicationCommandLedgerError(
        ApplicationCommandLedgerErrorCode.RecordNotFound,
        'Application command ledger record disappeared after completion',
        { namespace: input.namespace, scopeKey: input.scopeKey, commandId: input.commandId }
      );
    }
    return record;
  }

  private replayResult<TResult, TOperation extends string>(
    record: ApplicationCommandLedgerRecord<TOperation>
  ): TResult {
    if (record.resultJson === null) {
      throw new ApplicationCommandLedgerError(
        ApplicationCommandLedgerErrorCode.CompletedResultMissing,
        'Completed application command is missing a stored result',
        {
          namespace: record.namespace,
          scopeKey: record.scopeKey,
          commandId: record.commandId,
        }
      );
    }
    return JSON.parse(record.resultJson) as TResult;
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
      namespace: begin.record.namespace,
      scopeKey: begin.record.scopeKey,
      commandId: begin.record.commandId,
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

  private validateIdentity(input: ApplicationCommandIdentity): void {
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
  }
}

function stringifyError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
