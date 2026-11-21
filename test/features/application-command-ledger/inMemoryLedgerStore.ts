import {
  ApplicationCommandBeginOutcome,
  ApplicationCommandConflictReason,
  ApplicationCommandFailureKind,
  type ApplicationCommandLedgerBeginRequest,
  type ApplicationCommandLedgerBeginResult,
  type ApplicationCommandLedgerCompleteRequest,
  ApplicationCommandLedgerErrorCode,
  type ApplicationCommandLedgerFailRequest,
  type ApplicationCommandLedgerListScopeRequest,
  type ApplicationCommandLedgerReadByCommandIdRequest,
  type ApplicationCommandLedgerReadByIdempotencyKeyRequest,
  type ApplicationCommandLedgerRecord,
  ApplicationCommandLedgerStatus,
} from '@features/application-command-ledger/contracts';
import {
  ApplicationCommandLedgerError,
  type ApplicationCommandLedgerStore,
} from '@features/application-command-ledger/core/application';

/** An in-memory ledger store with the semantics of the durable one, for tests. */
export function fixedClock(): () => Date {
  return () => new Date('2026-07-09T10:00:00.000Z');
}

function key(input: { namespace: string; scopeKey: string; commandId: string }): string {
  return `${input.namespace}\0${input.scopeKey}\0${input.commandId}`;
}

function idempotencyKey(input: {
  namespace: string;
  scopeKey: string;
  idempotencyKey: string;
}): string {
  return `${input.namespace}\0${input.scopeKey}\0${input.idempotencyKey}`;
}

function statusForFailure(
  failureKind: ApplicationCommandFailureKind
): ApplicationCommandLedgerStatus {
  if (failureKind === ApplicationCommandFailureKind.Retryable) {
    return ApplicationCommandLedgerStatus.FailedRetryable;
  }
  if (failureKind === ApplicationCommandFailureKind.Terminal) {
    return ApplicationCommandLedgerStatus.FailedTerminal;
  }
  return ApplicationCommandLedgerStatus.UnknownAfterTimeout;
}

export class InMemoryLedgerStore implements ApplicationCommandLedgerStore {
  private records = new Map<string, ApplicationCommandLedgerRecord<string>>();
  markCompletedError: Error | null = null;
  markFailedError: Error | null = null;

  seed(record: ApplicationCommandLedgerRecord<string>): void {
    this.records.set(key(record), record);
  }

  begin<TOperation extends string>(
    request: ApplicationCommandLedgerBeginRequest<TOperation>
  ): Promise<ApplicationCommandLedgerBeginResult<TOperation>> {
    const existing = this.records.get(key(request));
    if (existing) {
      return Promise.resolve(
        this.beginExisting(existing as ApplicationCommandLedgerRecord<TOperation>, request)
      );
    }
    const existingByIdempotencyKey = [...this.records.values()].find(
      (record) => idempotencyKey(record) === idempotencyKey(request)
    );
    if (existingByIdempotencyKey) {
      return Promise.resolve(
        this.beginExisting(
          existingByIdempotencyKey as ApplicationCommandLedgerRecord<TOperation>,
          request,
          false
        )
      );
    }
    const created: ApplicationCommandLedgerRecord<TOperation> = {
      ...request,
      status: ApplicationCommandLedgerStatus.Started,
      failureKind: null,
      retryable: false,
      attemptCount: 1,
      resultHash: null,
      resultJson: null,
      startedAt: request.nowIso,
      updatedAt: request.nowIso,
      completedAt: null,
      lastError: null,
    };
    this.records.set(key(created), created);
    return Promise.resolve({ outcome: ApplicationCommandBeginOutcome.Started, record: created });
  }

  markCompleted(request: ApplicationCommandLedgerCompleteRequest): Promise<void> {
    if (this.markCompletedError) {
      return Promise.reject(this.markCompletedError);
    }
    const current = this.requireRecord(request);
    this.assertAttempt(current, request.attemptCount);
    this.records.set(key(current), {
      ...current,
      status: ApplicationCommandLedgerStatus.Completed,
      resultHash: request.resultHash,
      resultJson: request.resultJson,
      completedAt: request.completedAtIso,
      updatedAt: request.completedAtIso,
    });
    return Promise.resolve();
  }

  markFailed(request: ApplicationCommandLedgerFailRequest): Promise<void> {
    if (this.markFailedError) {
      return Promise.reject(this.markFailedError);
    }
    const current = this.requireRecord(request);
    this.assertAttempt(current, request.attemptCount);
    this.records.set(key(current), {
      ...current,
      status: statusForFailure(request.failureKind),
      failureKind: request.failureKind,
      retryable: request.failureKind === ApplicationCommandFailureKind.Retryable,
      completedAt:
        request.failureKind === ApplicationCommandFailureKind.UnknownAfterTimeout
          ? null
          : request.completedAtIso,
      updatedAt: request.completedAtIso,
      lastError: request.errorMessage,
    });
    return Promise.resolve();
  }

  getByCommandId<TOperation extends string>(
    request: ApplicationCommandLedgerReadByCommandIdRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation> | null> {
    return Promise.resolve(
      (this.records.get(key(request)) as ApplicationCommandLedgerRecord<TOperation>) ?? null
    );
  }

  getByIdempotencyKey<TOperation extends string>(
    request: ApplicationCommandLedgerReadByIdempotencyKeyRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation> | null> {
    return Promise.resolve(
      ([...this.records.values()].find(
        (record) => idempotencyKey(record) === idempotencyKey(request)
      ) as ApplicationCommandLedgerRecord<TOperation> | undefined) ?? null
    );
  }

  listByScope<TOperation extends string>(
    request: ApplicationCommandLedgerListScopeRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation>[]> {
    return Promise.resolve(
      [...this.records.values()].filter(
        (record) => record.namespace === request.namespace && record.scopeKey === request.scopeKey
      ) as ApplicationCommandLedgerRecord<TOperation>[]
    );
  }

  private beginExisting<TOperation extends string>(
    existing: ApplicationCommandLedgerRecord<TOperation>,
    request: ApplicationCommandLedgerBeginRequest<TOperation>,
    requireSameIdempotencyKey = true
  ): ApplicationCommandLedgerBeginResult<TOperation> {
    if (requireSameIdempotencyKey && existing.idempotencyKey !== request.idempotencyKey) {
      return {
        outcome: ApplicationCommandBeginOutcome.Conflict,
        reason: ApplicationCommandConflictReason.CommandIdReused,
        existing,
        requested: request,
      };
    }
    if (existing.operation !== request.operation) {
      return {
        outcome: ApplicationCommandBeginOutcome.Conflict,
        reason: ApplicationCommandConflictReason.OperationMismatch,
        existing,
        requested: request,
      };
    }
    if (existing.payloadHash !== request.payloadHash) {
      return {
        outcome: ApplicationCommandBeginOutcome.Conflict,
        reason: ApplicationCommandConflictReason.PayloadHashMismatch,
        existing,
        requested: request,
      };
    }
    if (existing.status === ApplicationCommandLedgerStatus.Completed) {
      return { outcome: ApplicationCommandBeginOutcome.DuplicateCompleted, record: existing };
    }
    if (existing.status === ApplicationCommandLedgerStatus.Started) {
      if (
        Date.parse(request.nowIso) - Date.parse(existing.updatedAt) >=
        request.startedStaleAfterMs
      ) {
        const unknown: ApplicationCommandLedgerRecord<TOperation> = {
          ...existing,
          status: ApplicationCommandLedgerStatus.UnknownAfterTimeout,
          failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout,
          updatedAt: request.nowIso,
          lastError: 'stale started attempt',
        };
        this.records.set(key(unknown), unknown);
        return { outcome: ApplicationCommandBeginOutcome.UnknownAfterTimeout, record: unknown };
      }
      return { outcome: ApplicationCommandBeginOutcome.AlreadyStarted, record: existing };
    }
    if (existing.status === ApplicationCommandLedgerStatus.FailedTerminal) {
      return { outcome: ApplicationCommandBeginOutcome.FailedTerminal, record: existing };
    }
    if (existing.status === ApplicationCommandLedgerStatus.UnknownAfterTimeout) {
      return { outcome: ApplicationCommandBeginOutcome.UnknownAfterTimeout, record: existing };
    }
    const retry: ApplicationCommandLedgerRecord<TOperation> = {
      ...existing,
      status: ApplicationCommandLedgerStatus.Started,
      failureKind: null,
      retryable: false,
      attemptCount: existing.attemptCount + 1,
      updatedAt: request.nowIso,
      completedAt: null,
      lastError: null,
    };
    this.records.set(key(retry), retry);
    return { outcome: ApplicationCommandBeginOutcome.RetryStarted, record: retry };
  }

  private requireRecord(input: {
    namespace: string;
    scopeKey: string;
    commandId: string;
  }): ApplicationCommandLedgerRecord<string> {
    const record = this.records.get(key(input));
    if (!record) {
      throw new ApplicationCommandLedgerError(
        ApplicationCommandLedgerErrorCode.RecordNotFound,
        'record not found'
      );
    }
    return record;
  }

  private assertAttempt(
    record: ApplicationCommandLedgerRecord<string>,
    attemptCount: number
  ): void {
    if (record.attemptCount !== attemptCount) {
      throw new Error('attempt is stale');
    }
  }
}
