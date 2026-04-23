import { existsSync } from 'fs';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { Worker } from 'worker_threads';

import { afterAll, afterEach, describe, expect, it } from 'vitest';

import { createPersistedLaunchSummaryProjection } from '../../../../src/main/services/team/TeamLaunchSummaryProjection';

interface WorkerResponse {
  id: string;
  ok: boolean;
  result?: unknown;
  error?: string;
}

let bundledWorkerPathPromise: Promise<string> | null = null;

async function getWorkerPath(): Promise<string> {
  const builtWorkerPath = path.join(process.cwd(), 'dist-electron', 'main', 'team-fs-worker.cjs');
  if (existsSync(builtWorkerPath)) {
    return builtWorkerPath;
  }

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

function callListTeams(worker: Worker, teamsDir: string): Promise<unknown[]> {
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
      resolve(Array.isArray(message.result) ? message.result : []);
    };

    worker.on('message', onMessage);
    worker.on('error', onError);
    worker.postMessage({
      id: requestId,
      op: 'listTeams',
      payload: {
        teamsDir,
        largeConfigBytes: 8 * 1024,
        configHeadBytes: 4 * 1024,
        maxConfigBytes: 256 * 1024,
        maxConfigReadMs: 5_000,
        maxMembersMetaBytes: 256 * 1024,
        maxSessionHistoryInSummary: 10,
        maxProjectPathHistoryInSummary: 10,
        concurrency: 2,
      },
    });
  });
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
      const teams = (await callListTeams(worker, tempDir)) as Array<Record<string, unknown>>;
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
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'alice', removedAt: Date.parse('2026-04-22T12:01:00.000Z') },
          { name: 'bob', role: 'developer' },
        ],
      }),
      'utf8'
    );

    const worker = createWorker(workerPath);
    try {
      const teams = (await callListTeams(worker, tempDir)) as Array<Record<string, unknown>>;
      expect(teams).toHaveLength(1);
      expect(teams[0]).toMatchObject({
        teamName,
        displayName: 'Draft Worker Team',
        memberCount: 1,
      });
    } finally {
      await worker.terminate();
    }
  });
});
