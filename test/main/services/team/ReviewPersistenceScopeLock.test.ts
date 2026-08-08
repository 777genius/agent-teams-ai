import { DatabaseSync } from 'node:sqlite';

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { once } from 'events';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let teamsBasePath: string;

interface WorkerResult {
  code: number | null;
  stderr: string;
}

const workerPath = path.resolve('test/fixtures/reviewPersistenceScopeLockWorker.ts');
const AMBIENT_PROVIDER_POISON = 'review-lock-ambient-provider-poison';

function runWorker(
  mode: 'run' | 'environment-probe',
  root: string,
  logPath: string,
  counterPath: string,
  workerId: string,
  delayMs: number,
  env: NodeJS.ProcessEnv = {}
): Promise<WorkerResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ['--import', 'tsx', workerPath, mode, root, logPath, counterPath, workerId, String(delayMs)],
      {
        cwd: process.cwd(),
        env: { NODE_ENV: 'test', ...env },
        stdio: ['ignore', 'ignore', 'pipe'],
      }
    );
    let stderr = '';
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stderr }));
  });
}

async function waitForLog(logPath: string, expected: string): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    try {
      if ((await readFile(logPath, 'utf8')).includes(expected)) return;
    } catch {
      // The first worker has not entered the lock yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${expected}`);
}

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => teamsBasePath,
}));

describe('ReviewPersistenceScopeLock', () => {
  beforeEach(async () => {
    teamsBasePath = await mkdtemp(path.join(tmpdir(), 'review-persistence-lock-'));
  });

  afterEach(async () => {
    const { closeReviewPersistenceScopeLockDatabasesForTests } =
      await import('@main/services/team/ReviewPersistenceScopeLock');
    closeReviewPersistenceScopeLockDatabasesForTests();
    await rm(teamsBasePath, { recursive: true, force: true });
  });

  it('serializes async operations for one exact scope', async () => {
    const { withReviewPersistenceScopeLock } =
      await import('@main/services/team/ReviewPersistenceScopeLock');
    const scope = { scopeKey: 'task-task-1', scopeToken: 'task:task-1:scope' };
    let active = 0;
    let maxActive = 0;
    const run = (delayMs: number) =>
      withReviewPersistenceScopeLock('demo', scope, async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        active -= 1;
      });

    await Promise.all([run(40), run(10), run(10)]);

    expect(maxActive).toBe(1);
  });

  it('serializes different fingerprints of one logical scope', async () => {
    const { withReviewPersistenceLogicalScopeLock } =
      await import('@main/services/team/ReviewPersistenceScopeLock');
    let active = 0;
    let maxActive = 0;
    const run = (delayMs: number) =>
      withReviewPersistenceLogicalScopeLock('demo', 'task-task-1', async () => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
        active -= 1;
      });

    await Promise.all([run(40), run(10), run(10)]);

    expect(maxActive).toBe(1);
  });

  it('releases the exact lease after an operation error', async () => {
    const { withReviewPersistenceScopeLock } =
      await import('@main/services/team/ReviewPersistenceScopeLock');
    const scope = { scopeKey: 'task-task-1', scopeToken: 'task:task-1:error' };

    await expect(
      withReviewPersistenceScopeLock('demo', scope, () =>
        Promise.reject(new Error('operation failed'))
      )
    ).rejects.toThrow('operation failed');
    await expect(
      withReviewPersistenceScopeLock('demo', scope, () => Promise.resolve('recovered'))
    ).resolves.toBe('recovered');
  });

  it('rejects path-like scope identities before opening the database', async () => {
    const { withReviewPersistenceScopeLock } =
      await import('@main/services/team/ReviewPersistenceScopeLock');

    await expect(
      withReviewPersistenceScopeLock(
        '../outside',
        {
          scopeKey: 'task-task-1',
          scopeToken: 'scope',
        },
        () => Promise.resolve()
      )
    ).rejects.toThrow('Invalid review persistence lock team name');
  });

  it.skipIf(process.platform === 'win32')(
    'gives the process-start probe only its exact host locale environment',
    async () => {
      const logPath = path.join(teamsBasePath, 'environment-probe.log');
      const counterPath = path.join(teamsBasePath, 'environment-probe-counter.txt');
      const first = runWorker('run', teamsBasePath, logPath, counterPath, 'first', 350);
      await waitForLog(logPath, 'first:enter');

      const second = runWorker(
        'environment-probe',
        teamsBasePath,
        logPath,
        counterPath,
        'provider-probe',
        0,
        {
          NODE_DEBUG: 'child_process',
          CODEX_API_KEY: AMBIENT_PROVIDER_POISON,
          CLAUDE_CODE_USE_OPENAI: '1',
          LC_ALL: 'hostile-locale',
        }
      );
      const [firstResult, secondResult] = await Promise.all([first, second]);

      expect(firstResult.code).toBe(0);
      expect(secondResult.code).toBe(0);
      expect(secondResult.stderr).toContain("env: { LC_ALL: 'C' }");
      expect(secondResult.stderr).toContain("envPairs: [ 'LC_ALL=C' ]");
      expect(secondResult.stderr).not.toContain(AMBIENT_PROVIDER_POISON);
      expect(secondResult.stderr).not.toContain('CLAUDE_CODE_USE_OPENAI');
      expect(secondResult.stderr).not.toContain('hostile-locale');
    }
  );

  it('reclaims a crash-left lease when its PID has been reused by another process', async () => {
    const { withReviewPersistenceScopeLock } =
      await import('@main/services/team/ReviewPersistenceScopeLock');
    const scope = { scopeKey: 'task-task-1', scopeToken: 'task:task-1:reused-pid' };
    await withReviewPersistenceScopeLock(
      'demo',
      { scopeKey: 'task-bootstrap', scopeToken: 'bootstrap' },
      () => Promise.resolve()
    );

    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      stdio: 'ignore',
    });
    await once(child, 'spawn');
    const childPid = child.pid;
    if (!childPid) throw new Error('Unable to start reused-PID lock fixture');
    try {
      const scopeId = createHash('sha256')
        .update('demo')
        .update('\0')
        .update(scope.scopeKey)
        .update('\0')
        .update(scope.scopeToken)
        .digest('hex');
      const database = new DatabaseSync(
        path.join(teamsBasePath, '.review-persistence-locks.sqlite3')
      );
      const now = Date.now();
      database
        .prepare(
          `INSERT INTO review_scope_locks (
            scope_id, owner_token, owner_pid, owner_started_at, acquired_at, heartbeat_at
          ) VALUES (?, ?, ?, ?, ?, ?)`
        )
        .run(scopeId, 'crashed-owner', childPid, now - 24 * 60 * 60 * 1_000, now, now);
      database.close();

      await expect(
        withReviewPersistenceScopeLock('demo', scope, () => Promise.resolve('recovered'), {
          acquireTimeoutMs: 500,
          retryIntervalMs: 10,
        })
      ).resolves.toBe('recovered');
    } finally {
      child.kill('SIGKILL');
      await once(child, 'close');
    }
  });
});
