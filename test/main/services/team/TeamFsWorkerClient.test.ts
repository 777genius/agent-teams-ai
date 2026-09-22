import * as path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => {
  const skipResponsesForOps = new Set<string>();
  const throwPostMessageForOps = new Set<string>();
  const workers: Array<{
    messages: unknown[];
    handlers: Map<string, (value: unknown) => void>;
    postMessage: (message: unknown) => void;
    on: (event: string, handler: (value: unknown) => void) => void;
    terminate: ReturnType<typeof vi.fn>;
  }> = [];
  const createMockWorker = vi.fn().mockImplementation(() => {
    const worker = {
      messages: [] as unknown[],
      handlers: new Map<string, (value: unknown) => void>(),
      postMessage(message: unknown) {
        const request = message as { id: string; op: string };
        if (throwPostMessageForOps.has(request.op)) {
          throw new Error(`post failed for ${request.op}`);
        }
        worker.messages.push(message);
        if (skipResponsesForOps.has(request.op)) return;
        queueMicrotask(() => {
          const handler = worker.handlers.get('message');
          if (!handler) return;
          handler({
            id: request.id,
            ok: true,
            result: request.op === 'listTeams' || request.op === 'getAllTasks' ? [] : null,
            diag: { op: request.op, totalMs: 0 },
          });
        });
      },
      on(event: string, handler: (value: unknown) => void) {
        worker.handlers.set(event, handler);
      },
      terminate: vi.fn(async () => undefined),
    };
    workers.push(worker);
    return worker;
  });
  return {
    workers,
    createMockWorker,
    skipResponsesForOps,
    throwPostMessageForOps,
  };
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
  default: {
    Worker: hoisted.createMockWorker,
  },
}));

describe('TeamFsWorkerClient', () => {
  afterEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    vi.useRealTimers();
    hoisted.workers.length = 0;
    hoisted.skipResponsesForOps.clear();
    hoisted.throwPostMessageForOps.clear();
  });

  it('prewarms the worker without running a scan', async () => {
    const { TeamFsWorkerClient } =
      await import('../../../../src/main/services/team/TeamFsWorkerClient');
    const client = new TeamFsWorkerClient();

    await client.prewarm();

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(1);
    expect(hoisted.workers[0].messages[0]).toMatchObject({
      op: 'warmup',
      payload: {},
    });
  });

  it('includes the packaged main output worker when the client is bundled into chunks', async () => {
    const { buildTeamFsWorkerPathCandidates } =
      await import('../../../../src/main/services/team/TeamFsWorkerClient');
    const baseDir = path.join(
      '/Applications/Agent Teams AI.app/Contents/Resources/app.asar',
      'dist-electron',
      'main',
      'chunks'
    );

    const candidates = buildTeamFsWorkerPathCandidates(baseDir);

    expect(candidates).toContain(path.join(baseDir, 'team-fs-worker.cjs'));
    expect(candidates).toContain(
      path.join(
        '/Applications/Agent Teams AI.app/Contents/Resources/app.asar',
        'dist-electron',
        'main',
        'team-fs-worker.cjs'
      )
    );
  });

  it('does not queue warmup behind an already running worker', async () => {
    const { TeamFsWorkerClient } =
      await import('../../../../src/main/services/team/TeamFsWorkerClient');
    const client = new TeamFsWorkerClient();

    await client.listTeams({
      largeConfigBytes: 8 * 1024,
      configHeadBytes: 4 * 1024,
      maxConfigBytes: 256 * 1024,
      maxMembersMetaBytes: 256 * 1024,
      maxSessionHistoryInSummary: 10,
      maxProjectPathHistoryInSummary: 10,
    });
    await client.prewarm();

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(1);
    expect(hoisted.workers[0].messages[0]).toMatchObject({
      op: 'listTeams',
    });
  });

  it('serializes heavy fs worker scans before posting them to the worker', async () => {
    hoisted.skipResponsesForOps.add('listTeams');
    const { TeamFsWorkerClient } =
      await import('../../../../src/main/services/team/TeamFsWorkerClient');
    const client = new TeamFsWorkerClient();

    const listPromise = client.listTeams({
      largeConfigBytes: 8 * 1024,
      configHeadBytes: 4 * 1024,
      maxConfigBytes: 256 * 1024,
      maxMembersMetaBytes: 256 * 1024,
      maxSessionHistoryInSummary: 10,
      maxProjectPathHistoryInSummary: 10,
    });
    const tasksPromise = client.getAllTasks({
      maxTaskBytes: 256 * 1024,
    });

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(1);
    expect(hoisted.workers[0].messages[0]).toMatchObject({
      op: 'listTeams',
    });

    const listRequest = hoisted.workers[0].messages[0] as { id: string };
    hoisted.workers[0].handlers.get('message')?.({
      id: listRequest.id,
      ok: true,
      result: [{ teamName: 'alpha', displayName: 'Alpha' }],
      diag: { op: 'listTeams', totalMs: 1 },
    });

    await expect(listPromise).resolves.toMatchObject({
      teams: [{ teamName: 'alpha', displayName: 'Alpha' }],
    });
    expect(hoisted.workers[0].messages).toHaveLength(2);
    expect(hoisted.workers[0].messages[1]).toMatchObject({
      op: 'getAllTasks',
    });
    await expect(tasksPromise).resolves.toMatchObject({
      tasks: [],
      diag: { op: 'getAllTasks', totalMs: 0 },
    });
  });

  it('ignores stale worker exit after timeout when a replacement worker owns pending work', async () => {
    vi.useFakeTimers();
    hoisted.skipResponsesForOps.add('warmup');
    hoisted.skipResponsesForOps.add('listTeams');
    const { TeamFsWorkerClient } =
      await import('../../../../src/main/services/team/TeamFsWorkerClient');
    const client = new TeamFsWorkerClient();

    const prewarmResult = client.prewarm().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20_001);
    const prewarmError = await prewarmResult;
    expect(prewarmError).toBeInstanceOf(Error);
    expect((prewarmError as Error).message).toContain('Worker call timeout');
    expect(hoisted.workers).toHaveLength(1);

    const listPromise = client.listTeams({
      largeConfigBytes: 8 * 1024,
      configHeadBytes: 4 * 1024,
      maxConfigBytes: 256 * 1024,
      maxMembersMetaBytes: 256 * 1024,
      maxSessionHistoryInSummary: 10,
      maxProjectPathHistoryInSummary: 10,
    });

    expect(hoisted.workers).toHaveLength(2);
    const staleWorker = hoisted.workers[0];
    const replacementWorker = hoisted.workers[1];
    const listRequest = replacementWorker.messages[0] as { id: string };

    staleWorker.handlers.get('exit')?.(1);
    replacementWorker.handlers.get('message')?.({
      id: listRequest.id,
      ok: true,
      result: [{ teamName: 'fresh-team', displayName: 'Fresh Team' }],
      diag: { op: 'listTeams', totalMs: 1 },
    });

    await expect(listPromise).resolves.toEqual({
      teams: [{ teamName: 'fresh-team', displayName: 'Fresh Team' }],
      diag: { op: 'listTeams', totalMs: 1 },
    });
  });

  it('clears pending state when worker postMessage throws synchronously', async () => {
    vi.useFakeTimers();
    hoisted.throwPostMessageForOps.add('listTeams');
    const { TeamFsWorkerClient } =
      await import('../../../../src/main/services/team/TeamFsWorkerClient');
    const client = new TeamFsWorkerClient();
    const options = {
      largeConfigBytes: 8 * 1024,
      configHeadBytes: 4 * 1024,
      maxConfigBytes: 256 * 1024,
      maxMembersMetaBytes: 256 * 1024,
      maxSessionHistoryInSummary: 10,
      maxProjectPathHistoryInSummary: 10,
    };

    await expect(client.listTeams(options)).rejects.toThrow('post failed for listTeams');
    expect(hoisted.workers).toHaveLength(1);

    hoisted.throwPostMessageForOps.delete('listTeams');
    await vi.advanceTimersByTimeAsync(20_001);
    await expect(client.listTeams(options)).resolves.toMatchObject({
      teams: [],
      diag: { op: 'listTeams', totalMs: 0 },
    });

    expect(hoisted.workers).toHaveLength(1);
    expect(hoisted.workers[0].messages).toHaveLength(1);
  });
});
