import {
  ApplicationCommandBeginOutcome,
  ApplicationCommandConflictReason,
  ApplicationCommandFailureKind,
  type ApplicationCommandLedgerBeginRequest,
  type ApplicationCommandLedgerBeginResult,
  type ApplicationCommandLedgerCompleteRequest,
  type ApplicationCommandLedgerFailRequest,
  type ApplicationCommandLedgerListScopeRequest,
  type ApplicationCommandLedgerReadByCommandIdRequest,
  type ApplicationCommandLedgerReadByIdempotencyKeyRequest,
  type ApplicationCommandLedgerRecord,
  ApplicationCommandLedgerStatus,
} from '@features/application-command-ledger/contracts';
import { and, asc, eq } from 'drizzle-orm';

import { applicationCommandLedger } from './internalStorageSchema';

import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

type AppCommandRecord = ApplicationCommandLedgerRecord<string>;
type AppCommandBeginRequest = ApplicationCommandLedgerBeginRequest<string>;
type AppCommandBeginResult = ApplicationCommandLedgerBeginResult<string>;

export function handleApplicationCommandLedgerOp(
  ops: ApplicationCommandLedgerWorkerOps,
  op: string,
  payload: unknown
): unknown {
  switch (op) {
    case 'appCommandLedger.begin':
      return ops.begin(payload as AppCommandBeginRequest);
    case 'appCommandLedger.markCompleted':
      ops.markCompleted(payload as ApplicationCommandLedgerCompleteRequest);
      return null;
    case 'appCommandLedger.markFailed':
      ops.markFailed(payload as ApplicationCommandLedgerFailRequest);
      return null;
    case 'appCommandLedger.getByCommandId':
      return ops.getByCommandId(payload as ApplicationCommandLedgerReadByCommandIdRequest);
    case 'appCommandLedger.getByIdempotencyKey':
      return ops.getByIdempotencyKey(
        payload as ApplicationCommandLedgerReadByIdempotencyKeyRequest
      );
    case 'appCommandLedger.listByScope':
      return ops.listByScope(payload as ApplicationCommandLedgerListScopeRequest);
    default:
      throw new Error(`Unknown internal-storage op: ${op}`);
  }
}

export class ApplicationCommandLedgerWorkerOps {
  constructor(private readonly getOrm: () => BetterSQLite3Database) {}

  begin(input: AppCommandBeginRequest): AppCommandBeginResult {
    assertValidBeginTiming(input);
    const orm = this.getOrm();
    return orm.transaction((): AppCommandBeginResult => {
      const currentByCommand = this.readByCommandId(input);
      if (currentByCommand) {
        return this.beginExistingCommand(currentByCommand, input);
      }

      const currentByIdempotencyKey = this.readByIdempotencyKey(input);
      if (currentByIdempotencyKey) {
        return this.beginExistingIdempotencyKey(currentByIdempotencyKey, input);
      }

      const created: AppCommandRecord = {
        namespace: input.namespace,
        scopeKey: input.scopeKey,
        commandId: input.commandId,
        idempotencyKey: input.idempotencyKey,
        operation: input.operation,
        payloadHash: input.payloadHash,
        status: ApplicationCommandLedgerStatus.Started,
        failureKind: null,
        retryable: false,
        attemptCount: 1,
        resultHash: null,
        resultJson: null,
        metadataJson: input.metadataJson,
        startedAt: input.nowIso,
        updatedAt: input.nowIso,
        completedAt: null,
        lastError: null,
      };
      orm.insert(applicationCommandLedger).values(created).run();
      return { outcome: ApplicationCommandBeginOutcome.Started, record: created };
    });
  }

  markCompleted(input: ApplicationCommandLedgerCompleteRequest): void {
    const orm = this.getOrm();
    orm.transaction(() => {
      const current = this.readByCommandId(input);
      if (!current) {
        throw new Error(`Application command ledger entry not found: ${input.commandId}`);
      }
      if (current.status === ApplicationCommandLedgerStatus.Completed) {
        if (current.resultHash === input.resultHash && current.resultJson === input.resultJson) {
          return;
        }
        throw new Error(
          `Application command completion conflicts with stored result: ${input.commandId}`
        );
      }
      assertAttemptMatches(current, input.attemptCount);
      if (!canFinalize(current.status)) {
        throw new Error(
          `Application command cannot be completed from status ${current.status}: ${input.commandId}`
        );
      }
      this.replaceRow({
        ...current,
        status: ApplicationCommandLedgerStatus.Completed,
        failureKind: null,
        retryable: false,
        resultHash: input.resultHash,
        resultJson: input.resultJson,
        updatedAt: input.completedAtIso,
        completedAt: input.completedAtIso,
        lastError: null,
      });
    });
  }

  markFailed(input: ApplicationCommandLedgerFailRequest): void {
    const orm = this.getOrm();
    orm.transaction(() => {
      const current = this.readByCommandId(input);
      if (!current) {
        throw new Error(`Application command ledger entry not found: ${input.commandId}`);
      }
      assertAttemptMatches(current, input.attemptCount);
      const nextStatus = statusForFailure(input.failureKind);
      if (
        current.status === nextStatus &&
        current.failureKind === input.failureKind &&
        current.lastError === input.errorMessage
      ) {
        return;
      }
      if (!canFinalize(current.status)) {
        throw new Error(
          `Application command cannot be failed from status ${current.status}: ${input.commandId}`
        );
      }
      this.replaceRow({
        ...current,
        status: nextStatus,
        failureKind: input.failureKind,
        retryable: input.failureKind === ApplicationCommandFailureKind.Retryable,
        resultHash: null,
        resultJson: null,
        updatedAt: input.completedAtIso,
        completedAt:
          input.failureKind === ApplicationCommandFailureKind.UnknownAfterTimeout
            ? null
            : input.completedAtIso,
        lastError: input.errorMessage,
      });
    });
  }

  getByCommandId(input: ApplicationCommandLedgerReadByCommandIdRequest): AppCommandRecord | null {
    return this.readByCommandId(input);
  }

  getByIdempotencyKey(
    input: ApplicationCommandLedgerReadByIdempotencyKeyRequest
  ): AppCommandRecord | null {
    return this.readByIdempotencyKey(input);
  }

  listByScope(input: ApplicationCommandLedgerListScopeRequest): AppCommandRecord[] {
    return this.getOrm()
      .select()
      .from(applicationCommandLedger)
      .where(
        and(
          eq(applicationCommandLedger.namespace, input.namespace),
          eq(applicationCommandLedger.scopeKey, input.scopeKey)
        )
      )
      .orderBy(asc(applicationCommandLedger.updatedAt), asc(applicationCommandLedger.commandId))
      .all() as AppCommandRecord[];
  }

  private beginExistingCommand(
    current: AppCommandRecord,
    input: AppCommandBeginRequest
  ): AppCommandBeginResult {
    const conflict =
      current.idempotencyKey !== input.idempotencyKey
        ? ApplicationCommandConflictReason.CommandIdReused
        : this.findSemanticConflict(current, input);
    if (conflict) {
      return {
        outcome: ApplicationCommandBeginOutcome.Conflict,
        reason: conflict,
        existing: current,
        requested: input,
      };
    }

    return this.beginExistingMatchingCommand(current, input);
  }

  private beginExistingIdempotencyKey(
    current: AppCommandRecord,
    input: AppCommandBeginRequest
  ): AppCommandBeginResult {
    const conflict = this.findSemanticConflict(current, input);
    if (conflict) {
      return {
        outcome: ApplicationCommandBeginOutcome.Conflict,
        reason: conflict,
        existing: current,
        requested: input,
      };
    }

    return this.beginExistingMatchingCommand(current, input);
  }

  private beginExistingMatchingCommand(
    current: AppCommandRecord,
    input: AppCommandBeginRequest
  ): AppCommandBeginResult {
    switch (current.status) {
      case ApplicationCommandLedgerStatus.Started:
        if (isStartedStale(current, input)) {
          const next: AppCommandRecord = {
            ...current,
            status: ApplicationCommandLedgerStatus.UnknownAfterTimeout,
            failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout,
            retryable: false,
            updatedAt: input.nowIso,
            completedAt: null,
            lastError: `Started attempt ${current.attemptCount} exceeded ${input.startedStaleAfterMs}ms and requires reconciliation`,
          };
          this.replaceRow(next);
          return {
            outcome: ApplicationCommandBeginOutcome.UnknownAfterTimeout,
            record: next,
          };
        }
        return { outcome: ApplicationCommandBeginOutcome.AlreadyStarted, record: current };
      case ApplicationCommandLedgerStatus.Completed:
        return { outcome: ApplicationCommandBeginOutcome.DuplicateCompleted, record: current };
      case ApplicationCommandLedgerStatus.FailedRetryable:
        return this.restartRetryable(current, input);
      case ApplicationCommandLedgerStatus.FailedTerminal:
        return { outcome: ApplicationCommandBeginOutcome.FailedTerminal, record: current };
      case ApplicationCommandLedgerStatus.UnknownAfterTimeout:
        return { outcome: ApplicationCommandBeginOutcome.UnknownAfterTimeout, record: current };
      default:
        return {
          outcome: ApplicationCommandBeginOutcome.Conflict,
          reason: ApplicationCommandConflictReason.OperationMismatch,
          existing: current,
          requested: input,
        };
    }
  }

  private restartRetryable(
    current: AppCommandRecord,
    input: AppCommandBeginRequest
  ): AppCommandBeginResult {
    const next: AppCommandRecord = {
      ...current,
      operation: input.operation,
      payloadHash: input.payloadHash,
      status: ApplicationCommandLedgerStatus.Started,
      failureKind: null,
      retryable: false,
      attemptCount: current.attemptCount + 1,
      resultHash: null,
      resultJson: null,
      metadataJson: input.metadataJson,
      updatedAt: input.nowIso,
      completedAt: null,
      lastError: null,
    };
    this.replaceRow(next);
    return { outcome: ApplicationCommandBeginOutcome.RetryStarted, record: next };
  }

  private findSemanticConflict(
    current: AppCommandRecord,
    input: AppCommandBeginRequest
  ): ApplicationCommandConflictReason | null {
    if (current.operation !== input.operation) {
      return ApplicationCommandConflictReason.OperationMismatch;
    }
    if (current.payloadHash !== input.payloadHash) {
      return ApplicationCommandConflictReason.PayloadHashMismatch;
    }
    return null;
  }

  private readByCommandId(input: {
    namespace: string;
    scopeKey: string;
    commandId: string;
  }): AppCommandRecord | null {
    const rows = this.getOrm()
      .select()
      .from(applicationCommandLedger)
      .where(
        and(
          eq(applicationCommandLedger.namespace, input.namespace),
          eq(applicationCommandLedger.scopeKey, input.scopeKey),
          eq(applicationCommandLedger.commandId, input.commandId)
        )
      )
      .all() as AppCommandRecord[];
    return rows[0] ?? null;
  }

  private readByIdempotencyKey(input: {
    namespace: string;
    scopeKey: string;
    idempotencyKey: string;
  }): AppCommandRecord | null {
    const rows = this.getOrm()
      .select()
      .from(applicationCommandLedger)
      .where(
        and(
          eq(applicationCommandLedger.namespace, input.namespace),
          eq(applicationCommandLedger.scopeKey, input.scopeKey),
          eq(applicationCommandLedger.idempotencyKey, input.idempotencyKey)
        )
      )
      .all() as AppCommandRecord[];
    return rows[0] ?? null;
  }

  private replaceRow(row: AppCommandRecord): void {
    this.getOrm()
      .update(applicationCommandLedger)
      .set({
        idempotencyKey: row.idempotencyKey,
        operation: row.operation,
        payloadHash: row.payloadHash,
        status: row.status,
        failureKind: row.failureKind,
        retryable: row.retryable,
        attemptCount: row.attemptCount,
        resultHash: row.resultHash,
        resultJson: row.resultJson,
        metadataJson: row.metadataJson,
        startedAt: row.startedAt,
        updatedAt: row.updatedAt,
        completedAt: row.completedAt,
        lastError: row.lastError,
      })
      .where(
        and(
          eq(applicationCommandLedger.namespace, row.namespace),
          eq(applicationCommandLedger.scopeKey, row.scopeKey),
          eq(applicationCommandLedger.commandId, row.commandId)
        )
      )
      .run();
  }
}

function canFinalize(status: ApplicationCommandLedgerStatus): boolean {
  return (
    status === ApplicationCommandLedgerStatus.Started ||
    status === ApplicationCommandLedgerStatus.UnknownAfterTimeout
  );
}

function assertAttemptMatches(current: AppCommandRecord, requestedAttemptCount: number): void {
  if (current.attemptCount !== requestedAttemptCount) {
    throw new Error(
      `Application command attempt is stale: ${current.commandId} expected=${current.attemptCount} actual=${requestedAttemptCount}`
    );
  }
}

function assertValidBeginTiming(input: AppCommandBeginRequest): void {
  if (!Number.isSafeInteger(input.startedStaleAfterMs) || input.startedStaleAfterMs <= 0) {
    throw new Error('Application command startedStaleAfterMs must be a positive integer');
  }
  if (!Number.isFinite(Date.parse(input.nowIso))) {
    throw new Error('Application command nowIso must be a valid ISO timestamp');
  }
}

function isStartedStale(current: AppCommandRecord, input: AppCommandBeginRequest): boolean {
  const attemptStartedAtMs = Date.parse(current.updatedAt);
  if (!Number.isFinite(attemptStartedAtMs)) {
    return true;
  }
  return Date.parse(input.nowIso) - attemptStartedAtMs >= input.startedStaleAfterMs;
}

function statusForFailure(
  failureKind: ApplicationCommandFailureKind
): ApplicationCommandLedgerStatus {
  switch (failureKind) {
    case ApplicationCommandFailureKind.Retryable:
      return ApplicationCommandLedgerStatus.FailedRetryable;
    case ApplicationCommandFailureKind.Terminal:
      return ApplicationCommandLedgerStatus.FailedTerminal;
    case ApplicationCommandFailureKind.UnknownAfterTimeout:
      return ApplicationCommandLedgerStatus.UnknownAfterTimeout;
  }
}
