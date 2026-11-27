import {
  ApplicationCommandConflictReason,
  ApplicationCommandFailureKind,
  ApplicationCommandLedgerErrorCode,
  ApplicationCommandLedgerStatus,
  ApplicationCommandRunOutcome,
} from '@features/application-command-ledger/contracts';
import {
  type ApplicationCommandHasher,
  type ApplicationCommandRunInput,
  ApplicationCommandRunner,
} from '@features/application-command-ledger/core/application';
import { stableJsonStringify } from '@features/application-command-ledger/core/domain';
import { describe, expect, it } from 'vitest';

import { fixedClock, InMemoryLedgerStore } from '../inMemoryLedgerStore';

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

    const first = await runner.run(makeInput(), () => {
      executions += 1;
      return Promise.resolve({ ok: true, id: 'task-1' });
    });
    const second = await runner.run(makeInput(), () => {
      executions += 1;
      return Promise.resolve({ ok: false });
    });

    expect(first.outcome).toBe(ApplicationCommandRunOutcome.Executed);
    expect(second.outcome).toBe(ApplicationCommandRunOutcome.Replayed);
    expect(second.result).toEqual({ ok: true, id: 'task-1' });
    expect(executions).toBe(1);
  });

  it('preserves undefined results when replaying void commands', async () => {
    const runner = new ApplicationCommandRunner({
      ledger: new InMemoryLedgerStore(),
      hasher,
      clock: fixedClock(),
    });
    let executions = 0;

    const first = await runner.run(makeInput(), () => {
      executions += 1;
      return Promise.resolve(undefined);
    });
    const replay = await runner.run(makeInput(), () => {
      executions += 1;
      return Promise.resolve(undefined);
    });

    expect(first.result).toBeUndefined();
    expect(replay.result).toBeUndefined();
    expect(replay.outcome).toBe(ApplicationCommandRunOutcome.Replayed);
    expect(executions).toBe(1);
  });

  it('rejects non-JSON payloads before creating a ledger record', async () => {
    const store = new InMemoryLedgerStore();
    const runner = new ApplicationCommandRunner({ ledger: store, hasher, clock: fixedClock() });
    let executions = 0;

    await expect(
      runner.run(makeInput({ payload: new Map([['title', 'Task A']]) as never }), () => {
        executions += 1;
        return Promise.resolve({ ok: true });
      })
    ).rejects.toMatchObject({
      code: ApplicationCommandLedgerErrorCode.InvalidInput,
      details: { field: 'payload' },
    });

    expect(executions).toBe(0);
    await expect(
      store.getByCommandId({ namespace: 'task-board', scopeKey: 'team-a', commandId: 'cmd-1' })
    ).resolves.toBeNull();
  });

  it('rejects a caller-supplied payload hash that does not match canonical JSON', async () => {
    const store = new InMemoryLedgerStore();
    const runner = new ApplicationCommandRunner({ ledger: store, hasher, clock: fixedClock() });
    let executions = 0;

    await expect(
      runner.run(makeInput({ payloadHash: 'hash:wrong' }), () => {
        executions += 1;
        return Promise.resolve({ ok: true });
      })
    ).rejects.toMatchObject({
      code: ApplicationCommandLedgerErrorCode.InvalidInput,
      details: { field: 'payloadHash' },
    });

    expect(executions).toBe(0);
  });

  it('rejects a completed replay whose stored result hash is invalid', async () => {
    const store = new InMemoryLedgerStore();
    store.seed({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      idempotencyKey: 'idem-1',
      operation: TestOperation.CreateTask,
      payloadHash: hasher.hashJson({ title: 'Task A' }),
      status: ApplicationCommandLedgerStatus.Completed,
      failureKind: null,
      retryable: false,
      attemptCount: 1,
      resultHash: 'hash:tampered',
      resultJson: '{"ok":true}',
      metadataJson: null,
      startedAt: '2026-07-09T10:00:00.000Z',
      updatedAt: '2026-07-09T10:01:00.000Z',
      completedAt: '2026-07-09T10:01:00.000Z',
      lastError: null,
    });
    const runner = new ApplicationCommandRunner({ ledger: store, hasher, clock: fixedClock() });

    await expect(
      runner.run(makeInput(), () => Promise.resolve({ ok: true }))
    ).rejects.toMatchObject({ code: ApplicationCommandLedgerErrorCode.CompletedResultInvalid });
  });

  it('replays a completed command by idempotency key when command id changes', async () => {
    const store = new InMemoryLedgerStore();
    const runner = new ApplicationCommandRunner({
      ledger: store,
      hasher,
      clock: fixedClock(),
    });
    let executions = 0;

    await runner.run(makeInput({ commandId: 'cmd-1' }), () => {
      executions += 1;
      return Promise.resolve({ ok: true, id: 'task-1' });
    });
    const replay = await runner.run(makeInput({ commandId: 'cmd-2' }), () => {
      executions += 1;
      return Promise.resolve({ ok: false });
    });

    expect(replay.outcome).toBe(ApplicationCommandRunOutcome.Replayed);
    expect(replay.record.commandId).toBe('cmd-1');
    expect(replay.result).toEqual({ ok: true, id: 'task-1' });
    expect(executions).toBe(1);
  });

  it('blocks same command id with a different payload hash', async () => {
    const runner = new ApplicationCommandRunner({
      ledger: new InMemoryLedgerStore(),
      hasher,
      clock: fixedClock(),
    });

    await runner.run(makeInput(), () => Promise.resolve({ ok: true }));

    await expect(
      runner.run(makeInput({ payload: { title: 'Changed' } }), () => Promise.resolve({ ok: true }))
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
      runner.run(retryableInput, () => Promise.reject(new Error('temporary')))
    ).rejects.toThrow('temporary');

    const second = await runner.run(retryableInput, () => Promise.resolve({ ok: true }));

    expect(second.outcome).toBe(ApplicationCommandRunOutcome.Retried);
    expect(second.record.attemptCount).toBe(2);
    expect(second.record.status).toBe(ApplicationCommandLedgerStatus.Completed);
  });

  it('retries a retryable command by idempotency key and commits the original record', async () => {
    const store = new InMemoryLedgerStore();
    const runner = new ApplicationCommandRunner({
      ledger: store,
      hasher,
      clock: fixedClock(),
    });

    await expect(
      runner.run(
        makeInput({
          commandId: 'cmd-1',
          classifyError: () => ({ failureKind: ApplicationCommandFailureKind.Retryable }),
        }),
        () => Promise.reject(new Error('temporary'))
      )
    ).rejects.toThrow('temporary');

    const retry = await runner.run(makeInput({ commandId: 'cmd-2' }), () =>
      Promise.resolve({ ok: true })
    );

    expect(retry.outcome).toBe(ApplicationCommandRunOutcome.Retried);
    expect(retry.record.commandId).toBe('cmd-1');
    expect(retry.record.attemptCount).toBe(2);
    expect(retry.record.status).toBe(ApplicationCommandLedgerStatus.Completed);
    await expect(
      store.getByCommandId({ namespace: 'task-board', scopeKey: 'team-a', commandId: 'cmd-2' })
    ).resolves.toBeNull();
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

    await expect(runner.run(input, () => Promise.reject(new Error('timeout')))).rejects.toThrow(
      'timeout'
    );

    await expect(runner.run(input, () => Promise.resolve({ ok: true }))).rejects.toMatchObject({
      code: ApplicationCommandLedgerErrorCode.UnknownOutcome,
    });
  });

  it('reconciles a stale started command as applied without executing it again', async () => {
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
      clock: () => new Date('2026-07-09T10:02:00.000Z'),
    });
    let executions = 0;

    const result = await runner.run(
      makeInput({
        reconcile: () =>
          Promise.resolve({ outcome: 'applied', result: { ok: true, id: 'task-1' } }),
      }),
      () => {
        executions += 1;
        return Promise.resolve({ ok: false, id: 'duplicate' });
      }
    );

    expect(result.outcome).toBe(ApplicationCommandRunOutcome.Reconciled);
    expect(result.result).toEqual({ ok: true, id: 'task-1' });
    expect(executions).toBe(0);
  });

  it('retries once after reconciliation proves the side effect was not applied', async () => {
    const store = new InMemoryLedgerStore();
    store.seed({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      idempotencyKey: 'idem-1',
      operation: TestOperation.CreateTask,
      payloadHash: hasher.hashJson({ title: 'Task A' }),
      status: ApplicationCommandLedgerStatus.UnknownAfterTimeout,
      failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout,
      retryable: false,
      attemptCount: 1,
      resultHash: null,
      resultJson: null,
      metadataJson: null,
      startedAt: '2026-07-09T10:00:00.000Z',
      updatedAt: '2026-07-09T10:01:00.000Z',
      completedAt: null,
      lastError: 'timeout',
    });
    const runner = new ApplicationCommandRunner({ ledger: store, hasher, clock: fixedClock() });
    let executions = 0;

    const result = await runner.run(
      makeInput({ reconcile: () => Promise.resolve({ outcome: 'not_applied' }) }),
      () => {
        executions += 1;
        return Promise.resolve({ ok: true });
      }
    );

    expect(result.outcome).toBe(ApplicationCommandRunOutcome.Retried);
    expect(result.record.attemptCount).toBe(2);
    expect(executions).toBe(1);
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
      runner.run(makeInput(), () => {
        executions += 1;
        return Promise.resolve({ ok: true });
      })
    ).rejects.toMatchObject({ code: ApplicationCommandLedgerErrorCode.AlreadyStarted });
    expect(executions).toBe(0);
  });

  it('reports a completed side effect when ledger completion persistence fails', async () => {
    const store = new InMemoryLedgerStore();
    store.markCompletedError = new Error('worker unavailable');
    const runner = new ApplicationCommandRunner({ ledger: store, hasher, clock: fixedClock() });
    let executions = 0;

    await expect(
      runner.run(makeInput(), () => {
        executions += 1;
        return Promise.resolve({ ok: true });
      })
    ).rejects.toMatchObject({
      code: ApplicationCommandLedgerErrorCode.StoreRejected,
      details: { stage: 'mark_completed', sideEffectCompleted: true },
    });

    expect(executions).toBe(1);
    await expect(
      store.getByCommandId({ namespace: 'task-board', scopeKey: 'team-a', commandId: 'cmd-1' })
    ).resolves.toMatchObject({ status: ApplicationCommandLedgerStatus.Started });
  });

  it('preserves the execution error as cause when failure persistence also fails', async () => {
    const store = new InMemoryLedgerStore();
    store.markFailedError = new Error('worker unavailable');
    const runner = new ApplicationCommandRunner({ ledger: store, hasher, clock: fixedClock() });
    const executionError = new Error('operation failed');

    const rejection = await runner
      .run(makeInput(), () => Promise.reject(executionError))
      .catch((error: unknown) => error);

    expect(rejection).toMatchObject({
      code: ApplicationCommandLedgerErrorCode.StoreRejected,
      cause: executionError,
      details: { stage: 'execute', originalError: 'operation failed' },
    });
  });

  it('marks the outcome unknown when error classification itself fails', async () => {
    const store = new InMemoryLedgerStore();
    const runner = new ApplicationCommandRunner({ ledger: store, hasher, clock: fixedClock() });
    const executionError = new Error('operation failed');

    await expect(
      runner.run(
        makeInput({
          classifyError: () => {
            throw new Error('classifier failed');
          },
        }),
        () => Promise.reject(executionError)
      )
    ).rejects.toBe(executionError);

    await expect(
      store.getByCommandId({ namespace: 'task-board', scopeKey: 'team-a', commandId: 'cmd-1' })
    ).resolves.toMatchObject({
      status: ApplicationCommandLedgerStatus.UnknownAfterTimeout,
      lastError: expect.stringContaining('classifier failed'),
    });
  });
});
