import * as fs from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  ApplicationCommandBeginOutcome,
  ApplicationCommandConflictReason,
  ApplicationCommandFailureKind,
  type ApplicationCommandLedgerBeginRequest,
  ApplicationCommandLedgerStatus,
} from '@features/application-command-ledger/contracts';
import { InternalStorageApplicationCommandLedgerStore } from '@features/application-command-ledger/main';
import { InternalStorageWorkerCore } from '@features/internal-storage/main/infrastructure/worker/InternalStorageWorkerCore';
import Database from 'better-sqlite3-node';
import { afterEach, describe, expect, it } from 'vitest';

import { InProcessGateway } from '../../internal-storage/helpers/InProcessGateway';

describe('InternalStorageApplicationCommandLedgerStore', () => {
  let tmpDir: string | null = null;
  const cores: InternalStorageWorkerCore[] = [];

  afterEach(async () => {
    for (const core of cores.splice(0)) {
      core.close();
    }
    if (tmpDir) {
      await fs.rm(tmpDir, { recursive: true, force: true });
      tmpDir = null;
    }
  });

  it('stores completed command results and returns duplicate-completed on replay', async () => {
    const store = await makeStore();

    const begin = await store.begin(makeBeginRequest());
    expect(begin.outcome).toBe(ApplicationCommandBeginOutcome.Started);
    await store.markCompleted({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      attemptCount: 1,
      resultHash: 'hash:result',
      resultJson: '{"ok":true}',
      completedAtIso: '2026-07-09T10:01:00.000Z',
    });

    const replay = await store.begin(makeBeginRequest({ nowIso: '2026-07-09T10:02:00.000Z' }));
    expect(replay.outcome).toBe(ApplicationCommandBeginOutcome.DuplicateCompleted);
    if (replay.outcome !== ApplicationCommandBeginOutcome.DuplicateCompleted) {
      throw new Error(`unexpected begin outcome: ${replay.outcome}`);
    }
    expect(replay.record.resultJson).toBe('{"ok":true}');
    expect(replay.record.status).toBe(ApplicationCommandLedgerStatus.Completed);
  });

  it('replays idempotency key reuse by a different command id when payload matches', async () => {
    const store = await makeStore();

    await store.begin(makeBeginRequest());
    await store.markCompleted({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      attemptCount: 1,
      resultHash: 'hash:result',
      resultJson: '{"ok":true}',
      completedAtIso: '2026-07-09T10:01:00.000Z',
    });

    const replay = await store.begin(
      makeBeginRequest({ commandId: 'cmd-2', nowIso: '2026-07-09T10:02:00.000Z' })
    );

    expect(replay).toMatchObject({
      outcome: ApplicationCommandBeginOutcome.DuplicateCompleted,
      record: {
        commandId: 'cmd-1',
        idempotencyKey: 'idem-1',
        resultJson: '{"ok":true}',
      },
    });
  });

  it('rejects idempotency key reuse when payload changes', async () => {
    const store = await makeStore();

    await store.begin(makeBeginRequest());
    const conflict = await store.begin(
      makeBeginRequest({ commandId: 'cmd-2', payloadHash: 'hash:payload-2' })
    );

    expect(conflict).toMatchObject({
      outcome: ApplicationCommandBeginOutcome.Conflict,
      reason: ApplicationCommandConflictReason.PayloadHashMismatch,
    });
  });

  it('restarts retryable failures and increments attempts without changing command identity', async () => {
    const store = await makeStore();

    await store.begin(makeBeginRequest());
    await store.markFailed({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      attemptCount: 1,
      failureKind: ApplicationCommandFailureKind.Retryable,
      errorMessage: 'temporary',
      completedAtIso: '2026-07-09T10:01:00.000Z',
    });

    const retry = await store.begin(makeBeginRequest({ nowIso: '2026-07-09T10:02:00.000Z' }));

    expect(retry.outcome).toBe(ApplicationCommandBeginOutcome.RetryStarted);
    if (retry.outcome !== ApplicationCommandBeginOutcome.RetryStarted) {
      throw new Error(`unexpected begin outcome: ${retry.outcome}`);
    }
    expect(retry.record.attemptCount).toBe(2);
    expect(retry.record.status).toBe(ApplicationCommandLedgerStatus.Started);
  });

  it('blocks unknown outcomes until reconciliation', async () => {
    const store = await makeStore();

    await store.begin(makeBeginRequest());
    await store.markFailed({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      attemptCount: 1,
      failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout,
      errorMessage: 'timeout',
      completedAtIso: '2026-07-09T10:01:00.000Z',
    });

    const blocked = await store.begin(makeBeginRequest({ nowIso: '2026-07-09T10:02:00.000Z' }));

    expect(blocked.outcome).toBe(ApplicationCommandBeginOutcome.UnknownAfterTimeout);
    if (blocked.outcome !== ApplicationCommandBeginOutcome.UnknownAfterTimeout) {
      throw new Error(`unexpected begin outcome: ${blocked.outcome}`);
    }
    expect(blocked.record.completedAt).toBeNull();
  });

  it('reconciles an unknown outcome to completed and replays the result', async () => {
    const store = await makeStore();

    await store.begin(makeBeginRequest());
    await store.markFailed({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      attemptCount: 1,
      failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout,
      errorMessage: 'timeout',
      completedAtIso: '2026-07-09T10:01:00.000Z',
    });
    await store.markCompleted({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      attemptCount: 1,
      resultHash: 'hash:result',
      resultJson: '{"ok":true}',
      completedAtIso: '2026-07-09T10:02:00.000Z',
    });

    await expect(store.begin(makeBeginRequest())).resolves.toMatchObject({
      outcome: ApplicationCommandBeginOutcome.DuplicateCompleted,
      record: { status: ApplicationCommandLedgerStatus.Completed, resultJson: '{"ok":true}' },
    });
  });

  it('reconciles an unknown outcome to retryable and starts a new attempt', async () => {
    const store = await makeStore();

    await store.begin(makeBeginRequest());
    await store.markFailed({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      attemptCount: 1,
      failureKind: ApplicationCommandFailureKind.UnknownAfterTimeout,
      errorMessage: 'timeout',
      completedAtIso: '2026-07-09T10:01:00.000Z',
    });
    await store.markFailed({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      attemptCount: 1,
      failureKind: ApplicationCommandFailureKind.Retryable,
      errorMessage: 'destination not changed',
      completedAtIso: '2026-07-09T10:02:00.000Z',
    });

    await expect(store.begin(makeBeginRequest())).resolves.toMatchObject({
      outcome: ApplicationCommandBeginOutcome.RetryStarted,
      record: { status: ApplicationCommandLedgerStatus.Started, attemptCount: 2 },
    });
  });

  it('moves a stale started attempt to unknown before any retry', async () => {
    const store = await makeStore();

    await store.begin(makeBeginRequest());
    const stale = await store.begin(
      makeBeginRequest({
        nowIso: '2026-07-09T10:01:00.000Z',
        startedStaleAfterMs: 60_000,
      })
    );

    expect(stale).toMatchObject({
      outcome: ApplicationCommandBeginOutcome.UnknownAfterTimeout,
      record: {
        status: ApplicationCommandLedgerStatus.UnknownAfterTimeout,
        attemptCount: 1,
      },
    });
  });

  it('rejects completion from a fenced attempt after a retry starts', async () => {
    const store = await makeStore();

    await store.begin(makeBeginRequest());
    await store.markFailed({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
      attemptCount: 1,
      failureKind: ApplicationCommandFailureKind.Retryable,
      errorMessage: 'not applied',
      completedAtIso: '2026-07-09T10:01:00.000Z',
    });
    await store.begin(makeBeginRequest({ nowIso: '2026-07-09T10:02:00.000Z' }));

    await expect(
      Promise.resolve().then(() =>
        store.markCompleted({
          namespace: 'task-board',
          scopeKey: 'team-a',
          commandId: 'cmd-1',
          attemptCount: 1,
          resultHash: 'hash:stale',
          resultJson: '{"stale":true}',
          completedAtIso: '2026-07-09T10:03:00.000Z',
        })
      )
    ).rejects.toThrow('attempt is stale');
  });

  async function makeStore(): Promise<InternalStorageApplicationCommandLedgerStore> {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'app-command-ledger-'));
    const core = new InternalStorageWorkerCore({
      databasePath: path.join(tmpDir, 'storage', 'app.db'),
      createDatabase: (file) => new Database(file),
    });
    cores.push(core);
    return new InternalStorageApplicationCommandLedgerStore(new InProcessGateway(core));
  }
});

function makeBeginRequest(
  overrides: Partial<ApplicationCommandLedgerBeginRequest<string>> = {}
): ApplicationCommandLedgerBeginRequest<string> {
  return {
    namespace: 'task-board',
    scopeKey: 'team-a',
    commandId: 'cmd-1',
    idempotencyKey: 'idem-1',
    operation: 'task.create',
    payloadHash: 'hash:payload',
    metadataJson: null,
    nowIso: '2026-07-09T10:00:00.000Z',
    startedStaleAfterMs: 60_000,
    ...overrides,
  };
}
