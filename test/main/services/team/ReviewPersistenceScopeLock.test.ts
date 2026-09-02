import { DatabaseSync } from 'node:sqlite';

import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { once } from 'events';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let teamsBasePath: string;

vi.mock('@main/utils/pathDecoder', () => ({
  getTeamsBasePath: () => teamsBasePath,
}));

const startTimeProbeOverride = vi.hoisted(() => ({
  read: null as ((pid: number, timeoutMs?: number) => Promise<number | null>) | null,
}));

vi.mock('@main/utils/processStartTime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@main/utils/processStartTime')>();
  return {
    ...actual,
    readProcessStartTimeMs: (pid: number, platform?: NodeJS.Platform, timeoutMs?: number) =>
      startTimeProbeOverride.read
        ? startTimeProbeOverride.read(pid, timeoutMs)
        : actual.readProcessStartTimeMs(pid, platform, timeoutMs),
  };
});

describe('ReviewPersistenceScopeLock', () => {
  beforeEach(async () => {
    startTimeProbeOverride.read = null;
    teamsBasePath = await mkdtemp(path.join(tmpdir(), 'review-persistence-lock-'));
  });

  afterEach(async () => {
    const { closeReviewPersistenceScopeLockDatabasesForTests } =
      await import('@main/services/team/ReviewPersistenceScopeLock');
    closeReviewPersistenceScopeLockDatabasesForTests();
    await rm(teamsBasePath, { recursive: true, force: true });
  });

  function seedCrashLeftLease(
    scope: { scopeKey: string; scopeToken: string },
    ownerPid: number
  ): void {
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
      .run(scopeId, 'crashed-owner', ownerPid, now - 24 * 60 * 60 * 1_000, now, now);
    database.close();
  }

  async function withLiveForeignProcess(run: (pid: number) => Promise<void>): Promise<void> {
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1_000)'], {
      stdio: 'ignore',
    });
    await once(child, 'spawn');
    const childPid = child.pid;
    if (!childPid) throw new Error('Unable to start reused-PID lock fixture');
    try {
      await run(childPid);
    } finally {
      child.kill('SIGKILL');
      await once(child, 'close');
    }
  }

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
      withReviewPersistenceScopeLock('demo', scope, async () => {
        throw new Error('operation failed');
      })
    ).rejects.toThrow('operation failed');
    await expect(
      withReviewPersistenceScopeLock('demo', scope, async () => 'recovered')
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
        async () => undefined
      )
    ).rejects.toThrow('Invalid review persistence lock team name');
  });

  it('reclaims a crash-left lease when its PID has been reused by another process', async () => {
    const { withReviewPersistenceScopeLock } =
      await import('@main/services/team/ReviewPersistenceScopeLock');
    const scope = { scopeKey: 'task-task-1', scopeToken: 'task:task-1:reused-pid' };
    await withReviewPersistenceScopeLock(
      'demo',
      { scopeKey: 'task-bootstrap', scopeToken: 'bootstrap' },
      async () => undefined
    );

    await withLiveForeignProcess(async (childPid) => {
      seedCrashLeftLease(scope, childPid);

      await expect(
        withReviewPersistenceScopeLock('demo', scope, async () => 'recovered', {
          acquireTimeoutMs: 500,
          retryIntervalMs: 10,
        })
      ).resolves.toBe('recovered');
    });
  });

  it('re-probes an owner whose start time was unobservable on the first attempt', async () => {
    const { withReviewPersistenceScopeLock } =
      await import('@main/services/team/ReviewPersistenceScopeLock');
    const scope = { scopeKey: 'task-task-1', scopeToken: 'task:task-1:unobservable-start' };
    await withReviewPersistenceScopeLock(
      'demo',
      { scopeKey: 'task-bootstrap', scopeToken: 'bootstrap' },
      async () => undefined
    );

    await withLiveForeignProcess(async (childPid) => {
      seedCrashLeftLease(scope, childPid);
      let probeCount = 0;
      // A probe that times out under load answers null. Caching that miss for the
      // full success TTL would make every retry in one acquire budget reuse it, so
      // the crash-left row could never be reclaimed.
      startTimeProbeOverride.read = async () => (probeCount++ === 0 ? null : Date.now());

      await expect(
        withReviewPersistenceScopeLock('demo', scope, async () => 'recovered', {
          acquireTimeoutMs: 2_000,
          retryIntervalMs: 10,
        })
      ).resolves.toBe('recovered');
      expect(probeCount).toBeGreaterThan(1);
    });
  });

  it('rate-limits owner probes and caps them by the remaining acquire budget', async () => {
    const { withReviewPersistenceScopeLock } =
      await import('@main/services/team/ReviewPersistenceScopeLock');
    const scope = { scopeKey: 'task-task-1', scopeToken: 'task:task-1:unreadable-owner' };
    await withReviewPersistenceScopeLock(
      'demo',
      { scopeKey: 'task-bootstrap', scopeToken: 'bootstrap' },
      async () => undefined
    );

    await withLiveForeignProcess(async (childPid) => {
      seedCrashLeftLease(scope, childPid);
      const acquireTimeoutMs = 1_200;
      const probeTimeouts: number[] = [];
      // An owner nobody can read: a miss that expires per retry would let the 10ms loop
      // below spawn a probe process several times a second for the whole acquire window,
      // each one free to outlive the acquire that started it.
      startTimeProbeOverride.read = async (_pid, timeoutMs) => {
        probeTimeouts.push(timeoutMs ?? Number.POSITIVE_INFINITY);
        return null;
      };

      await expect(
        withReviewPersistenceScopeLock('demo', scope, async () => 'unreachable', {
          acquireTimeoutMs,
          retryIntervalMs: 10,
        })
      ).rejects.toThrow('busy in another app process');
      // This budget is above the probe floor, so the remaining budget is what caps each
      // probe: none of them may run on into the seconds after the acquire gave up.
      for (const probeTimeout of probeTimeouts) {
        expect(probeTimeout).toBeGreaterThan(0);
        expect(probeTimeout).toBeLessThanOrEqual(acquireTimeoutMs);
      }
      expect(probeTimeouts.length).toBeLessThanOrEqual(2);
    });
  });

  it('skips the owner probe once the acquire budget is already spent', async () => {
    const { withReviewPersistenceScopeLock } =
      await import('@main/services/team/ReviewPersistenceScopeLock');
    const scope = { scopeKey: 'task-task-1', scopeToken: 'task:task-1:spent-budget' };
    await withReviewPersistenceScopeLock(
      'demo',
      { scopeKey: 'task-bootstrap', scopeToken: 'bootstrap' },
      async () => undefined
    );

    await withLiveForeignProcess(async (childPid) => {
      seedCrashLeftLease(scope, childPid);
      let probeCount = 0;
      startTimeProbeOverride.read = async () => {
        probeCount += 1;
        return null;
      };

      await expect(
        withReviewPersistenceScopeLock('demo', scope, async () => 'unreachable', {
          acquireTimeoutMs: 0,
          retryIntervalMs: 10,
        })
      ).rejects.toThrow('busy in another app process');
      expect(probeCount).toBe(0);
    });
  });

  /**
   * The reason the probe is awaited before the transaction rather than inside it,
   * asserted rather than claimed in a comment. `BEGIN IMMEDIATE` takes the SQLite
   * write lock for the whole database, so awaiting a process spawn after it would
   * block every acquire in every app process for the length of that spawn. A
   * second connection can only take that lock while the acquire under test is not
   * holding it, so taking it from inside the probe is the observation.
   */
  it('holds no write transaction while the owner probe is in flight', async () => {
    const { withReviewPersistenceScopeLock } =
      await import('@main/services/team/ReviewPersistenceScopeLock');
    const scope = { scopeKey: 'task-task-1', scopeToken: 'task:task-1:probe-before-begin' };
    await withReviewPersistenceScopeLock(
      'demo',
      { scopeKey: 'task-bootstrap', scopeToken: 'bootstrap' },
      async () => undefined
    );

    await withLiveForeignProcess(async (childPid) => {
      seedCrashLeftLease(scope, childPid);
      let writeLockDuringProbe: 'free' | 'held' | 'not probed' = 'not probed';
      startTimeProbeOverride.read = async () => {
        const observer = new DatabaseSync(
          path.join(teamsBasePath, '.review-persistence-locks.sqlite3')
        );
        try {
          // No busy timeout is configured on this connection, so a write lock held
          // by the acquire under test fails here immediately instead of waiting.
          observer.exec('BEGIN IMMEDIATE');
          observer.exec('ROLLBACK');
          writeLockDuringProbe = 'free';
        } catch {
          writeLockDuringProbe = 'held';
        } finally {
          observer.close();
        }
        return Date.now();
      };

      await expect(
        withReviewPersistenceScopeLock('demo', scope, async () => 'recovered', {
          acquireTimeoutMs: 2_000,
          retryIntervalMs: 10,
        })
      ).resolves.toBe('recovered');
      expect(writeLockDuringProbe).toBe('free');
    });
  });

  /**
   * The conservative half of the recycled-pid rule, asserted for the first time:
   * an unobservable start time is not evidence of a different process. The
   * seeded row claims a start time a day old, so a probe that answered anything
   * real would evict this owner - answering null must not.
   */
  it('keeps a live-pid owner whose start time cannot be observed at all', async () => {
    const { withReviewPersistenceScopeLock } =
      await import('@main/services/team/ReviewPersistenceScopeLock');
    const scope = { scopeKey: 'task-task-1', scopeToken: 'task:task-1:unobservable-owner-kept' };
    await withReviewPersistenceScopeLock(
      'demo',
      { scopeKey: 'task-bootstrap', scopeToken: 'bootstrap' },
      async () => undefined
    );

    await withLiveForeignProcess(async (childPid) => {
      seedCrashLeftLease(scope, childPid);
      let probeCount = 0;
      startTimeProbeOverride.read = async () => {
        probeCount += 1;
        return null;
      };

      await expect(
        withReviewPersistenceScopeLock('demo', scope, async () => 'stolen', {
          acquireTimeoutMs: 300,
          retryIntervalMs: 10,
        })
      ).rejects.toThrow('busy in another app process');
      expect(probeCount).toBeGreaterThan(0);
    });
  });
});
