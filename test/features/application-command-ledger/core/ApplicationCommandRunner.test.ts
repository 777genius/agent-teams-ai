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
  ApplicationCommandRunOutcome,
} from '@features/application-command-ledger/contracts';
import {
  type ApplicationCommandHasher,
  ApplicationCommandLedgerError,
  type ApplicationCommandLedgerStore,
  type ApplicationCommandRunInput,
  ApplicationCommandRunner,
} from '@features/application-command-ledger/core/application';
import { stableJsonStringify } from '@features/application-command-ledger/core/domain';
import { describe, expect, it } from 'vitest';

enum TestOperation {
  CreateTask = 'task.create',
}

const hasher: ApplicationCommandHasher = {
  hashJson: (value) => `hash:${stableJsonStringify(value)}`,
  hashString: (value) => `hash:${value}`,
};

function makeInput(
  overrides: Partial<ApplicationCommandRunInput<TestOperation>> = {}
): ApplicationCommandRunInput<TestOperation> {
  return {
    namespace: 'task-board',
    scopeKey: 'team-a',
    commandId: 'cmd-1',
    idempotencyKey: 'idem-1',
    operation: TestOperation.CreateTask,
    payload: { title: 'Task A' },
    classifyError: () => ({ failureKind: ApplicationCommandFailureKind.Terminal }),
    ...overrides,
  };
}

describe('ApplicationCommandRunner', () => {
  it('executes a fresh command and replays a completed duplicate without re-executing', async () => {
    const store = new InMemoryLedgerStore();
    const runner = new ApplicationCommandRunner({
      ledger: store,
      hasher,
      clock: fixedClock(),
    });
    let executions = 0;

    const first = await runner.run(makeInput(), async () => {
      executions += 1;
      return { ok: true, id: 'task-1' };
    });
    const second = await runner.run(makeInput(), async () => {
      executions += 1;
      return { ok: false };
    });

    expect(first.outcome).toBe(ApplicationCommandRunOutcome.Executed);
    expect(second.outcome).toBe(ApplicationCommandRunOutcome.Replayed);
    expect(second.result).toEqual({ ok: true, id: 'task-1' });
    expect(executions).toBe(1);
  });

  it('blocks same command id with a different payload hash', async () => {
    const runner = new ApplicationCommandRunner({
      ledger: new InMemoryLedgerStore(),
      hasher,
      clock: fixedClock(),
    });

    await runner.run(makeInput(), async () => ({ ok: true }));

    await expect(
      runner.run(makeInput({ payload: { title: 'Changed' } }), async () => ({ ok: true }))
    ).rejects.toMatchObject({
      code: ApplicationCommandLedgerErrorCode.Conflict,
      details: { reason: ApplicationCommandConflictReason.PayloadHashMismatch },
    });
  });

  it('retries a command after retryable failure and increments attempt count', async () => {
    const store = new InMemoryLedgerStore();
    const runner = new ApplicationCommandRunner({
      ledger: store,
      hasher,
      clock: fixedClock(),
    });
    const retryableInput = makeInput({
      classifyError: () => ({ failureKind: ApplicationCommandFailureKind.Retryable }),
    });

    await expect(
      runner.run(retryableInput, async () => {
        throw new Error('temporary');
      })
    ).rejects.toThrow('temporary');

    const second = await runner.run(retryableInput, async () => ({ ok: true }));

    expect(second.outcome).toBe(ApplicationCommandRunOutcome.Retried);
    expect(second.record.attemptCount).toBe(2);
    expect(second.record.status).toBe(ApplicationCommandLedgerStatus.Completed);
  });

  it('blocks retry after unknown outcome until reconciliation', async () => {
    const store = new InMemoryLedgerStore();
    const runner = new ApplicationCommandRunner({
      ledger: store,
      hasher,
      clock: fixedClock(),
    });
    const input = makeInput({
      classifyError: () => ({ failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout }),
    });

    await expect(
      runner.run(input, async () => {
        throw new Error('timeout');
      })
    ).rejects.toThrow('timeout');

    await expect(runner.run(input, async () => ({ ok: true }))).rejects.toMatchObject({
      code: ApplicationCommandLedgerErrorCode.UnknownOutcome,
    });
  });

  it('blocks duplicate execution while the command is already started', async () => {
    const store = new InMemoryLedgerStore();
    store.seed({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      idempotencyKey: 'idem-1',
      operation: TestOperation.CreateTask,
      payloadHash: hasher.hashJson({ title: 'Task A' }),
      status: ApplicationCommandLedgerStatus.Started,
      failureKind: null,
      retryable: false,
      attemptCount: 1,
      resultHash: null,
      resultJson: null,
      metadataJson: null,
      startedAt: '2026-07-09T10:00:00.000Z',
      updatedAt: '2026-07-09T10:00:00.000Z',
      completedAt: null,
      lastError: null,
    });
    const runner = new ApplicationCommandRunner({
      ledger: store,
      hasher,
      clock: fixedClock(),
    });
    let executions = 0;

    await expect(
      runner.run(makeInput(), async () => {
        executions += 1;
        return { ok: true };
      })
    ).rejects.toMatchObject({ code: ApplicationCommandLedgerErrorCode.AlreadyStarted });
    expect(executions).toBe(0);
  });
});

function fixedClock(): () => Date {
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

class InMemoryLedgerStore implements ApplicationCommandLedgerStore {
  private records = new Map<string, ApplicationCommandLedgerRecord<string>>();

  seed(record: ApplicationCommandLedgerRecord<string>): void {
    this.records.set(key(record), record);
  }

  async begin<TOperation extends string>(
    request: ApplicationCommandLedgerBeginRequest<TOperation>
  ): Promise<ApplicationCommandLedgerBeginResult<TOperation>> {
    const existing = this.records.get(key(request));
    if (existing) {
      return this.beginExisting(existing as ApplicationCommandLedgerRecord<TOperation>, request);
    }
    const existingByIdempotencyKey = [...this.records.values()].find(
      (record) => idempotencyKey(record) === idempotencyKey(request)
    );
    if (existingByIdempotencyKey) {
      return {
        outcome: ApplicationCommandBeginOutcome.Conflict,
        reason: ApplicationCommandConflictReason.IdempotencyKeyReused,
        existing: existingByIdempotencyKey as ApplicationCommandLedgerRecord<TOperation>,
        requested: request,
      };
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
    return { outcome: ApplicationCommandBeginOutcome.Started, record: created };
  }

  async markCompleted(request: ApplicationCommandLedgerCompleteRequest): Promise<void> {
    const current = this.requireRecord(request);
    this.records.set(key(current), {
      ...current,
      status: ApplicationCommandLedgerStatus.Completed,
      resultHash: request.resultHash,
      resultJson: request.resultJson,
      completedAt: request.completedAtIso,
      updatedAt: request.completedAtIso,
    });
  }

  async markFailed(request: ApplicationCommandLedgerFailRequest): Promise<void> {
    const current = this.requireRecord(request);
    this.records.set(key(current), {
      ...current,
      status:
        request.failureKind === ApplicationCommandFailureKind.Retryable
          ? ApplicationCommandLedgerStatus.FailedRetryable
          : request.failureKind === ApplicationCommandFailureKind.Terminal
            ? ApplicationCommandLedgerStatus.FailedTerminal
            : ApplicationCommandLedgerStatus.UnknownAfterTimeout,
      failureKind: request.failureKind,
      retryable: request.failureKind === ApplicationCommandFailureKind.Retryable,
      completedAt:
        request.failureKind === ApplicationCommandFailureKind.UnknownAfterTimeout
          ? null
          : request.completedAtIso,
      updatedAt: request.completedAtIso,
      lastError: request.errorMessage,
    });
  }

  async getByCommandId<TOperation extends string>(
    request: ApplicationCommandLedgerReadByCommandIdRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation> | null> {
    return (this.records.get(key(request)) as ApplicationCommandLedgerRecord<TOperation>) ?? null;
  }

  async getByIdempotencyKey<TOperation extends string>(
    request: ApplicationCommandLedgerReadByIdempotencyKeyRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation> | null> {
    return (
      ([...this.records.values()].find((record) => idempotencyKey(record) === idempotencyKey(request)) as
        | ApplicationCommandLedgerRecord<TOperation>
        | undefined) ?? null
    );
  }

  async listByScope<TOperation extends string>(
    request: ApplicationCommandLedgerListScopeRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation>[]> {
    return [...this.records.values()].filter(
      (record) => record.namespace === request.namespace && record.scopeKey === request.scopeKey
    ) as ApplicationCommandLedgerRecord<TOperation>[];
  }

  private beginExisting<TOperation extends string>(
    existing: ApplicationCommandLedgerRecord<TOperation>,
    request: ApplicationCommandLedgerBeginRequest<TOperation>
  ): ApplicationCommandLedgerBeginResult<TOperation> {
    if (existing.idempotencyKey !== request.idempotencyKey) {
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
}
