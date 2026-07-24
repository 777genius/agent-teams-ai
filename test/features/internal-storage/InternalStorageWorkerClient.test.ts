import { parseMemberId, parseTeamId } from '@shared/contracts/hosted';
import { afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  interface MockWorker {
    messages: Array<{ id: string; op: string; payload: unknown }>;
    handlers: Map<string, (value: unknown) => void>;
    postMessage: (message: unknown) => void;
    on: (event: string, handler: (value: unknown) => void) => void;
    terminate: ReturnType<typeof vi.fn>;
  }

  const workers: MockWorker[] = [];
  const createMockWorker = vi.fn().mockImplementation(() => {
    const worker: MockWorker = {
      messages: [],
      handlers: new Map(),
      postMessage(message: unknown) {
        worker.messages.push(message as MockWorker['messages'][number]);
      },
      on(event: string, handler: (value: unknown) => void) {
        worker.handlers.set(event, handler);
      },
      terminate: vi.fn(async () => undefined),
    };
    workers.push(worker);
    return worker;
  });

  return { createMockWorker, workers };
});

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(() => true),
  };
});

vi.mock('node:worker_threads', () => ({
  Worker: hoisted.createMockWorker,
  default: { Worker: hoisted.createMockWorker },
}));

function respond(worker: (typeof hoisted.workers)[number], index: number, result: unknown): void {
  worker.handlers.get('message')?.({
    id: worker.messages[index].id,
    ok: true,
    result,
  });
}

describe('InternalStorageWorkerClient', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.clearAllMocks();
    vi.resetModules();
    hoisted.workers.length = 0;
  });

  it('gives a default-timeout request its full budget after a long queued wait', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T00:00:00.000Z'));
    const { InternalStorageWorkerClient } =
      await import('@features/internal-storage/main/infrastructure/InternalStorageWorkerClient');
    const client = new InternalStorageWorkerClient({ databasePath: '/tmp/internal-storage.db' });

    const onlineBackup = client.coordinationBackupSqliteOnline({
      backupRunId: 'backup-1',
      deadlineAtMs: Date.now() + 30_000,
      busyRetryMs: 10,
      pagesPerStep: 64,
    });
    const queuedPing = client.ping();
    const queuedPingError = queuedPing.catch((error: unknown) => error as Error);
    const worker = hoisted.workers[0];

    expect(worker.messages.map(({ op }) => op)).toEqual(['coordinationBackup.sqlite.online']);

    await vi.advanceTimersByTimeAsync(19_999);
    respond(worker, 0, { status: 'completed' });
    await expect(onlineBackup).resolves.toEqual({ status: 'completed' });
    expect(worker.messages.map(({ op }) => op)).toEqual([
      'coordinationBackup.sqlite.online',
      'ping',
    ]);

    await vi.advanceTimersByTimeAsync(19_999);
    expect(worker.terminate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(queuedPingError).resolves.toMatchObject({
      message: 'internal-storage worker call timeout after 39999ms (ping)',
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('keeps a queued online-backup timeout anchored to deadlineAtMs plus two seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-23T00:00:00.000Z'));
    const { InternalStorageWorkerClient } =
      await import('@features/internal-storage/main/infrastructure/InternalStorageWorkerClient');
    const client = new InternalStorageWorkerClient({ databasePath: '/tmp/internal-storage.db' });
    const activePing = client.ping();
    const deadlineAtMs = Date.now() + 5_000;

    const onlineBackup = client.coordinationBackupSqliteOnline({
      backupRunId: 'backup-2',
      deadlineAtMs,
      busyRetryMs: 10,
      pagesPerStep: 64,
    });
    const onlineBackupError = onlineBackup.catch((error: unknown) => error as Error);
    const worker = hoisted.workers[0];

    expect(worker.messages.map(({ op }) => op)).toEqual(['ping']);

    await vi.advanceTimersByTimeAsync(6_000);
    respond(worker, 0, { backend: 'sqlite' });
    await expect(activePing).resolves.toEqual({ backend: 'sqlite' });
    expect(worker.messages.map(({ op }) => op)).toEqual([
      'ping',
      'coordinationBackup.sqlite.online',
    ]);

    await vi.advanceTimersByTimeAsync(999);
    expect(worker.terminate).not.toHaveBeenCalled();

    await vi.advanceTimersByTimeAsync(1);
    await expect(onlineBackupError).resolves.toMatchObject({
      message:
        'internal-storage worker call timeout after 7000ms (coordinationBackup.sqlite.online)',
    });
    expect(worker.terminate).toHaveBeenCalledOnce();
  });

  it('serializes dispatch and rejects active and queued requests on worker failure', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const { InternalStorageWorkerClient } =
      await import('@features/internal-storage/main/infrastructure/InternalStorageWorkerClient');
    const client = new InternalStorageWorkerClient({ databasePath: '/tmp/internal-storage.db' });

    const active = client.ping();
    const queued = client.loadStallJournalEntries('team-a');
    const activeError = active.catch((error: unknown) => error as Error);
    const queuedError = queued.catch((error: unknown) => error as Error);
    const worker = hoisted.workers[0];

    expect(worker.messages.map(({ op }) => op)).toEqual(['ping']);

    const failure = new Error('test worker failure');
    worker.handlers.get('error')?.(failure);

    await expect(activeError).resolves.toBe(failure);
    await expect(queuedError).resolves.toBe(failure);
    expect(worker.messages.map(({ op }) => op)).toEqual(['ping']);
    consoleError.mockRestore();
  });

  it('round-trips TeamRoster operations through the typed worker protocol', async () => {
    const { InternalStorageWorkerClient } =
      await import('@features/internal-storage/main/infrastructure/InternalStorageWorkerClient');
    const client = new InternalStorageWorkerClient({ databasePath: '/tmp/internal-storage.db' });
    const teamId = parseTeamId(`team_${'a'.repeat(32)}`);
    const roster = {
      schemaVersion: 1 as const,
      teamId,
      rosterGeneration: 1,
      adoptionFingerprint: `sha256:${'b'.repeat(64)}`,
      adoptedAt: '2026-07-23T10:00:00.000Z',
      members: [
        {
          ordinal: 0,
          memberId: parseMemberId(`member_${'c'.repeat(32)}`),
          legacyMemberKey: 'builder',
          memberRevision: 1,
          state: 'active' as const,
          providerId: 'codex' as const,
          model: null,
          role: null,
          workflow: null,
          isolation: null,
        },
      ],
    };

    const get = client.getTeamRoster(teamId);
    const worker = hoisted.workers[0];
    expect(worker.messages[0]).toMatchObject({
      op: 'teamRoster.get',
      payload: { teamId },
    });
    respond(worker, 0, roster);
    await expect(get).resolves.toEqual(roster);

    const adopt = client.adoptTeamRoster(roster);
    expect(worker.messages[1]).toMatchObject({
      op: 'teamRoster.adopt',
      payload: { roster },
    });
    respond(worker, 1, { outcome: 'created', roster });
    await expect(adopt).resolves.toEqual({ outcome: 'created', roster });
  });
});
