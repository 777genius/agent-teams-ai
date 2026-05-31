import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { afterAll, afterEach, describe, expect, it } from 'vitest';
import { Worker } from 'worker_threads';

import { createPersistedLaunchSummaryProjection } from '../../../../src/main/services/team/TeamLaunchSummaryProjection';

interface WorkerResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  diag?: unknown;
  error?: string;
}

let bundledWorkerPathPromise: Promise<string> | null = null;

async function getWorkerPath(): Promise<string> {
  bundledWorkerPathPromise ??= bundleWorkerForTests();
  return bundledWorkerPathPromise;
}

async function bundleWorkerForTests(): Promise<string> {
  const outDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-fs-worker-bundle-'));
  const outfile = path.join(outDir, 'team-fs-worker.cjs');
  await fs.writeFile(
    outfile,
    [
      "const path = require('node:path');",
      "const { createRequire } = require('node:module');",
      "const requireFromRepo = createRequire(path.join(process.cwd(), 'package.json'));",
      "const { register } = requireFromRepo('tsx/cjs/api');",
      "register({ tsconfigPath: path.join(process.cwd(), 'tsconfig.json') });",
      "require(path.join(process.cwd(), 'src', 'main', 'workers', 'team-fs-worker.ts'));",
      '',
    ].join('\n'),
    'utf8'
  );
  return outfile;
}

function createWorker(workerPath: string): Worker {
  return new Worker(workerPath);
}

function callWorker(
  worker: Worker,
  op: string,
  payload: Record<string, unknown> = {}
): Promise<{ result: unknown; diag?: unknown }> {
  const requestId = `req-${Date.now()}`;
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error('team-fs-worker test timed out'));
    }, 10_000);

    const cleanup = () => {
      clearTimeout(timeout);
      worker.off('message', onMessage);
      worker.off('error', onError);
    };

    const onError = (error: Error) => {
      cleanup();
      reject(error);
    };

    const onMessage = (message: WorkerResponse) => {
      if (!message || message.id !== requestId) {
        return;
      }
      cleanup();
      if (!message.ok) {
        reject(new Error(message.error || 'team-fs-worker returned an unknown error'));
        return;
      }
      resolve({ result: message.result, diag: message.diag });
    };

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.postMessage({ id: requestId, op, payload });
  });
}

async function callListTeams(
  worker: Worker,
  teamsDir: string
): Promise<{
  teams: unknown[];
  diag?: Record<string, unknown>;
}> {
  const { result, diag } = await callWorker(worker, 'listTeams', {
    teamsDir,
    largeConfigBytes: 8 * 1024,
    configHeadBytes: 4 * 1024,
    maxConfigBytes: 256 * 1024,
    maxConfigReadMs: 5_000,
    maxMembersMetaBytes: 256 * 1024,
    maxSessionHistoryInSummary: 10,
    maxProjectPathHistoryInSummary: 10,
    concurrency: 2,
  });
  return {
    teams: Array.isArray(result) ? result : [],
    diag: diag && typeof diag === 'object' ? (diag as Record<string, unknown>) : undefined,
  };
}

async function callGetAllTasks(
  worker: Worker,
  tasksBase: string,
  projectionCacheBase = path.join(path.dirname(tasksBase), 'projection-cache')
): Promise<{
  tasks: unknown[];
  diag?: Record<string, unknown>;
}> {
  const { result, diag } = await callWorker(worker, 'getAllTasks', {
    tasksBase,
    projectionCacheBase,
    maxTaskBytes: 256 * 1024,
    maxTaskReadMs: 5_000,
    concurrency: 2,
  });
  return {
    tasks: Array.isArray(result) ? result : [],
    diag: diag && typeof diag === 'object' ? (diag as Record<string, unknown>) : undefined,
  };
}

async function callWarmup(worker: Worker): Promise<void> {
  await callWorker(worker, 'warmup');
}

describe('team-fs-worker integration', () => {
  let tempDir = '';

  afterAll(async () => {
    const bundledWorkerPath = bundledWorkerPathPromise ? await bundledWorkerPathPromise : null;
    if (bundledWorkerPath) {
      await fs.rm(path.dirname(bundledWorkerPath), { recursive: true, force: true });
    }
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true });
      tempDir = '';
    }
  });

  it('uses launch-summary.json when launch-state.json is too large for mixed-team summaries', async () => {
    const workerPath = await getWorkerPath();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-fs-worker-'));
    const teamName = 'mixed-worker-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });

    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Mixed Worker Team',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    await fs.writeFile(path.join(teamDir, 'launch-state.json'), 'x'.repeat(40 * 1024), 'utf8');
    await fs.writeFile(
      path.join(teamDir, 'launch-summary.json'),
      JSON.stringify(
        createPersistedLaunchSummaryProjection({
          version: 2,
          teamName,
          updatedAt: '2026-04-22T12:00:00.000Z',
          launchPhase: 'finished',
          expectedMembers: ['alice', 'bob'],
          bootstrapExpectedMembers: ['alice'],
          members: {
            alice: {
              name: 'alice',
              providerId: 'codex',
              laneId: 'primary',
              laneKind: 'primary',
              laneOwnerProviderId: 'codex',
              launchState: 'confirmed_alive',
              agentToolAccepted: true,
              runtimeAlive: true,
              bootstrapConfirmed: true,
              hardFailure: false,
              lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            },
            bob: {
              name: 'bob',
              providerId: 'opencode',
              laneId: 'secondary:opencode:bob',
              laneKind: 'secondary',
              laneOwnerProviderId: 'opencode',
              launchState: 'failed_to_start',
              agentToolAccepted: true,
              runtimeAlive: false,
              bootstrapConfirmed: false,
              hardFailure: true,
              hardFailureReason: 'Side lane failed',
              lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
            },
          },
          summary: {
            confirmedCount: 1,
            pendingCount: 0,
            failedCount: 1,
            runtimeAlivePendingCount: 0,
          },
          teamLaunchState: 'partial_failure',
        } as never),
        null,
        2
      ),
      'utf8'
    );

    const worker = createWorker(workerPath);
    try {
      const { teams } = await callListTeams(worker, tempDir);
      expect(teams).toHaveLength(1);
      expect(teams[0]).toMatchObject({
        teamName,
        displayName: 'Mixed Worker Team',
        partialLaunchFailure: true,
        expectedMemberCount: 2,
        confirmedMemberCount: 1,
        missingMembers: ['bob'],
        teamLaunchState: 'partial_failure',
        confirmedCount: 1,
        pendingCount: 0,
        failedCount: 1,
      });
    } finally {
      await worker.terminate();
    }
  });

  it('ignores removed and lead members when draft-team worker summary counts members', async () => {
    const workerPath = await getWorkerPath();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-fs-worker-'));
    const teamName = 'draft-worker-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });

    await fs.writeFile(
      path.join(teamDir, 'team.meta.json'),
      JSON.stringify({
        version: 1,
        cwd: tempDir,
        displayName: 'Draft Worker Team',
        createdAt: Date.parse('2026-04-22T12:00:00.000Z'),
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'members.meta.json'),
      JSON.stringify({
        version: 1,
        members: [
          { name: 'team-lead', agentType: 'team-lead', color: '#123456' },
          { name: 'alice', removedAt: Date.parse('2026-04-22T12:01:00.000Z') },
          { name: 'bob', role: 'developer' },
        ],
      }),
      'utf8'
    );

    const worker = createWorker(workerPath);
    try {
      const { teams } = await callListTeams(worker, tempDir);
      expect(teams).toHaveLength(1);
      expect(teams[0]).toMatchObject({
        teamName,
        displayName: 'Draft Worker Team',
        memberCount: 1,
        leadName: 'team-lead',
        leadColor: '#123456',
      });
    } finally {
      await worker.terminate();
    }
  });

  it('uses lead cwd as the project path when config.projectPath is missing', async () => {
    const workerPath = await getWorkerPath();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-fs-worker-'));
    const teamName = 'lead-cwd-project-team';
    const teamDir = path.join(tempDir, teamName);
    const projectPath = path.join(tempDir, 'project-321');
    await fs.mkdir(teamDir, { recursive: true });

    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Lead Cwd Project Team',
        projectPath: null,
        members: [{ name: 'team-lead', agentType: 'team-lead', cwd: projectPath }],
      }),
      'utf8'
    );

    const worker = createWorker(workerPath);
    try {
      const { teams } = await callListTeams(worker, tempDir);
      expect(teams).toHaveLength(1);
      expect(teams[0]).toMatchObject({
        teamName,
        displayName: 'Lead Cwd Project Team',
        projectPath,
      });
    } finally {
      await worker.terminate();
    }
  });

  it('prewarms and reuses unchanged team summaries by fingerprint', async () => {
    const workerPath = await getWorkerPath();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-fs-worker-'));
    const teamName = 'cached-worker-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(path.join(teamDir, 'inboxes'), { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Cached Worker Team',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'members.meta.json'),
      JSON.stringify({ version: 1, members: [{ name: 'alice' }] }),
      'utf8'
    );

    const worker = createWorker(workerPath);
    try {
      await callWarmup(worker);
      const first = await callListTeams(worker, tempDir);
      expect(first.teams[0]).toMatchObject({ teamName, memberCount: 1 });
      expect(first.diag?.cacheMisses).toBe(1);

      const second = await callListTeams(worker, tempDir);
      expect(second.teams[0]).toMatchObject({ teamName, memberCount: 1 });
      expect(second.diag?.cacheHits).toBe(1);

      await fs.writeFile(
        path.join(teamDir, 'members.meta.json'),
        JSON.stringify({ version: 1, members: [{ name: 'alice' }, { name: 'bob' }] }),
        'utf8'
      );
      const changed = await callListTeams(worker, tempDir);
      expect(changed.teams[0]).toMatchObject({ teamName, memberCount: 2 });
      expect(changed.diag?.cacheMisses).toBe(1);
    } finally {
      await worker.terminate();
    }
  });

  it('does not cache pending launch summaries because liveness can change without file writes', async () => {
    const workerPath = await getWorkerPath();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-fs-worker-'));
    const teamName = 'pending-launch-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Pending Launch Team',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'launch-summary.json'),
      JSON.stringify({
        version: 1,
        teamName,
        updatedAt: new Date().toISOString(),
        launchPhase: 'active',
        teamLaunchState: 'partial_pending',
        expectedMemberCount: 1,
        pendingCount: 1,
      }),
      'utf8'
    );

    const worker = createWorker(workerPath);
    try {
      const first = await callListTeams(worker, tempDir);
      expect(first.teams[0]).toMatchObject({
        teamName,
        teamLaunchState: 'partial_pending',
        pendingCount: 1,
      });
      expect(first.diag?.cacheMisses).toBe(1);
      expect(first.diag?.cacheWriteSkips).toBe(1);

      const second = await callListTeams(worker, tempDir);
      expect(second.teams[0]).toMatchObject({
        teamName,
        teamLaunchState: 'partial_pending',
        pendingCount: 1,
      });
      expect(second.diag?.cacheHits).toBe(0);
      expect(second.diag?.cacheMisses).toBe(1);
      expect(second.diag?.cacheWriteSkips).toBe(1);
    } finally {
      await worker.terminate();
    }
  });

  it('ignores stale pending launch-summary fallbacks so offline teams do not stay reconciling', async () => {
    const workerPath = await getWorkerPath();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-fs-worker-'));
    const teamName = 'stale-pending-summary-team';
    const teamDir = path.join(tempDir, teamName);
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Stale Pending Summary Team',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    await fs.writeFile(
      path.join(teamDir, 'launch-summary.json'),
      JSON.stringify({
        version: 1,
        teamName,
        updatedAt: '2026-04-09T20:35:57.962Z',
        launchUpdatedAt: '2026-04-09T20:35:57.962Z',
        teamLaunchState: 'partial_pending',
        expectedMemberCount: 1,
        pendingCount: 1,
        permissionPendingCount: 0,
      }),
      'utf8'
    );

    const worker = createWorker(workerPath);
    try {
      const first = await callListTeams(worker, tempDir);
      expect(first.teams[0]).toMatchObject({ teamName });
      expect(first.teams[0]).not.toMatchObject({
        teamLaunchState: 'partial_pending',
      });
      expect(first.diag?.cacheMisses).toBe(1);
      expect(first.diag?.cacheWriteSkips).toBe(0);
    } finally {
      await worker.terminate();
    }
  });

  it('rereads launch-summary after caching a stale pending fallback as settled', async () => {
    const workerPath = await getWorkerPath();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-fs-worker-'));
    const teamName = 'stale-pending-cache-invalidation-team';
    const teamDir = path.join(tempDir, teamName);
    const launchSummaryPath = path.join(teamDir, 'launch-summary.json');
    await fs.mkdir(teamDir, { recursive: true });
    await fs.writeFile(
      path.join(teamDir, 'config.json'),
      JSON.stringify({
        name: 'Stale Pending Cache Invalidation Team',
        members: [{ name: 'team-lead', agentType: 'team-lead' }],
      }),
      'utf8'
    );
    await fs.writeFile(
      launchSummaryPath,
      JSON.stringify({
        version: 1,
        teamName,
        updatedAt: '2026-04-09T20:35:57.962Z',
        launchUpdatedAt: '2026-04-09T20:35:57.962Z',
        teamLaunchState: 'partial_pending',
        expectedMemberCount: 1,
        pendingCount: 1,
        permissionPendingCount: 0,
      }),
      'utf8'
    );

    const worker = createWorker(workerPath);
    try {
      const stale = await callListTeams(worker, tempDir);
      expect(stale.teams[0]).toMatchObject({ teamName });
      expect(stale.teams[0]).not.toMatchObject({
        teamLaunchState: 'partial_pending',
      });
      expect(stale.diag?.cacheMisses).toBe(1);
      expect(stale.diag?.cacheWriteSkips).toBe(0);

      await fs.writeFile(
        launchSummaryPath,
        JSON.stringify({
          version: 1,
          teamName,
          updatedAt: new Date().toISOString(),
          launchPhase: 'active',
          teamLaunchState: 'partial_pending',
          expectedMemberCount: 1,
          pendingCount: 1,
          permissionPendingCount: 0,
        }),
        'utf8'
      );

      const fresh = await callListTeams(worker, tempDir);
      expect(fresh.teams[0]).toMatchObject({
        teamName,
        teamLaunchState: 'partial_pending',
        pendingCount: 1,
      });
      expect(fresh.diag?.cacheHits).toBe(0);
      expect(fresh.diag?.cacheMisses).toBe(1);
      expect(fresh.diag?.cacheWriteSkips).toBe(1);
    } finally {
      await worker.terminate();
    }
  });

  it('reuses unchanged parsed tasks and rereads changed task files by fingerprint', async () => {
    const workerPath = await getWorkerPath();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-fs-worker-'));
    const tasksBase = path.join(tempDir, 'tasks');
    const teamName = 'task-cache-team';
    const tasksDir = path.join(tasksBase, teamName);
    await fs.mkdir(tasksDir, { recursive: true });
    const taskPath = path.join(tasksDir, '1.json');
    await fs.writeFile(
      taskPath,
      JSON.stringify({
        id: '1',
        subject: 'First subject',
        status: 'pending',
        createdAt: '2026-05-02T12:00:00.000Z',
      }),
      'utf8'
    );

    const worker = createWorker(workerPath);
    try {
      const first = await callGetAllTasks(worker, tasksBase);
      expect(first.tasks[0]).toMatchObject({ teamName, subject: 'First subject' });
      expect(first.diag?.cacheMisses).toBe(1);

      const second = await callGetAllTasks(worker, tasksBase);
      expect(second.tasks[0]).toMatchObject({ teamName, subject: 'First subject' });
      expect(second.diag?.cacheHits).toBe(1);

      await fs.writeFile(
        taskPath,
        JSON.stringify({
          id: '1',
          subject: 'Changed subject with a different size',
          status: 'pending',
          createdAt: '2026-05-02T12:00:00.000Z',
        }),
        'utf8'
      );
      const changed = await callGetAllTasks(worker, tasksBase);
      expect(changed.tasks[0]).toMatchObject({
        teamName,
        subject: 'Changed subject with a different size',
      });
      expect(changed.diag?.cacheMisses).toBe(1);
    } finally {
      await worker.terminate();
    }
  });

  it('reuses persisted task projections after a worker restart', async () => {
    const workerPath = await getWorkerPath();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-fs-worker-'));
    const tasksBase = path.join(tempDir, 'tasks');
    const projectionCacheBase = path.join(tempDir, 'projection-cache');
    const teamName = 'persistent-task-cache-team';
    const tasksDir = path.join(tasksBase, teamName);
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(
      path.join(tasksDir, '1.json'),
      JSON.stringify({
        id: '1',
        subject: 'Persisted subject',
        status: 'pending',
        createdAt: '2026-05-02T12:00:00.000Z',
      }),
      'utf8'
    );

    const firstWorker = createWorker(workerPath);
    try {
      const first = await callGetAllTasks(firstWorker, tasksBase, projectionCacheBase);
      expect(first.tasks[0]).toMatchObject({ teamName, subject: 'Persisted subject' });
      expect(first.diag?.cacheMisses).toBe(1);
      expect(first.diag?.persistentCacheWrites).toBe(1);
    } finally {
      await firstWorker.terminate();
    }

    const secondWorker = createWorker(workerPath);
    try {
      const second = await callGetAllTasks(secondWorker, tasksBase, projectionCacheBase);
      expect(second.tasks[0]).toMatchObject({ teamName, subject: 'Persisted subject' });
      expect(second.diag?.cacheHits).toBe(0);
      expect(second.diag?.cacheMisses).toBe(0);
      expect(second.diag?.persistentCacheLoads).toBe(1);
      expect(second.diag?.persistentCacheHits).toBe(1);
    } finally {
      await secondWorker.terminate();
    }
  });

  it('falls back to task JSON when persisted projections are stale or corrupt', async () => {
    const workerPath = await getWorkerPath();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'team-fs-worker-'));
    const tasksBase = path.join(tempDir, 'tasks');
    const projectionCacheBase = path.join(tempDir, 'projection-cache');
    const teamName = 'stale-persistent-cache-team';
    const tasksDir = path.join(tasksBase, teamName);
    const taskPath = path.join(tasksDir, '1.json');
    await fs.mkdir(tasksDir, { recursive: true });
    await fs.writeFile(
      taskPath,
      JSON.stringify({
        id: '1',
        subject: 'Original subject',
        status: 'pending',
        createdAt: '2026-05-02T12:00:00.000Z',
      }),
      'utf8'
    );

    const firstWorker = createWorker(workerPath);
    try {
      const first = await callGetAllTasks(firstWorker, tasksBase, projectionCacheBase);
      expect(first.tasks[0]).toMatchObject({ subject: 'Original subject' });
      expect(first.diag?.persistentCacheWrites).toBe(1);
    } finally {
      await firstWorker.terminate();
    }

    await fs.writeFile(
      taskPath,
      JSON.stringify({
        id: '1',
        subject: 'Changed subject with a different size',
        status: 'pending',
        createdAt: '2026-05-02T12:00:00.000Z',
      }),
      'utf8'
    );

    const changedWorker = createWorker(workerPath);
    try {
      const changed = await callGetAllTasks(changedWorker, tasksBase, projectionCacheBase);
      expect(changed.tasks[0]).toMatchObject({
        teamName,
        subject: 'Changed subject with a different size',
      });
      expect(changed.diag?.persistentCacheLoads).toBe(1);
      expect(changed.diag?.persistentCacheHits).toBe(0);
      expect(changed.diag?.persistentCacheMisses).toBe(1);
      expect(changed.diag?.cacheMisses).toBe(1);
    } finally {
      await changedWorker.terminate();
    }

    const cacheFiles = await fs.readdir(path.join(projectionCacheBase, 'v1'));
    await fs.writeFile(path.join(projectionCacheBase, 'v1', cacheFiles[0]), '{bad json', 'utf8');

    const corruptWorker = createWorker(workerPath);
    try {
      const recovered = await callGetAllTasks(corruptWorker, tasksBase, projectionCacheBase);
      expect(recovered.tasks[0]).toMatchObject({
        teamName,
        subject: 'Changed subject with a different size',
      });
      expect(recovered.diag?.persistentCacheReadFailures).toBe(1);
      expect(recovered.diag?.cacheMisses).toBe(1);
    } finally {
      await corruptWorker.terminate();
    }
  });
});
