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

  it('rejects idempotency key reuse by a different command id', async () => {
    const store = await makeStore();

    await store.begin(makeBeginRequest());
    const conflict = await store.begin(
      makeBeginRequest({ commandId: 'cmd-2', payloadHash: 'hash:payload-2' })
    );

    expect(conflict).toMatchObject({
      outcome: ApplicationCommandBeginOutcome.Conflict,
      reason: ApplicationCommandConflictReason.IdempotencyKeyReused,
    });
  });

  it('restarts retryable failures and increments attempts without changing command identity', async () => {
    const store = await makeStore();

    await store.begin(makeBeginRequest());
    await store.markFailed({
      namespace: 'task-board',
      scopeKey: 'team-a',
      commandId: 'cmd-1',
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
    ...overrides,
  };
}
