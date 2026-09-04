import {
  PERIODIC_STALE_LOCK_INTERVAL_MS,
  PERIODIC_STALE_LOCK_MIN_AGE_MS,
  PRE_LAUNCH_STALE_LOCK_MIN_AGE_MS,
  purgeStaleOpenCodeHostStartupLocks,
  purgeStaleOpenCodeHostStartupLocksBeforeLaunch,
  resolveOpenCodeHostStartupLocksDir,
  startPeriodicOpenCodeHostStartupLockPurge,
} from '@main/services/team/opencode/bridge/OpenCodeHostStartupLockCleanup';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

let locksDir = '';

function writeLock(name: string, ageMs: number): string {
  const lockPath = path.join(locksDir, name);
  fs.writeFileSync(lockPath, '');
  const mtime = new Date(Date.now() - ageMs);
  fs.utimesSync(lockPath, mtime, mtime);
  return lockPath;
}

beforeEach(() => {
  locksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-host-locks-'));
});

afterEach(() => {
  fs.rmSync(locksDir, { recursive: true, force: true });
});

describe('resolveOpenCodeHostStartupLocksDir', () => {
  it('prefers an absolute data-home override on every platform', () => {
    const override = path.join(os.tmpdir(), 'multimodel-data-home');

    expect(
      resolveOpenCodeHostStartupLocksDir({
        platform: 'win32',
        env: { CLAUDE_MULTIMODEL_DATA_HOME: override },
      })
    ).toBe(path.join(override, 'opencode', 'host-startup-locks'));
  });

  it('falls back to the platform data directory when the override is not absolute', () => {
    const resolved = resolveOpenCodeHostStartupLocksDir({
      platform: 'darwin',
      env: { CLAUDE_MULTIMODEL_DATA_HOME: 'relative/path' },
      homeDir: path.join(os.tmpdir(), 'home'),
    });

    expect(resolved).toBe(
      path.join(
        os.tmpdir(),
        'home',
        'Library',
        'Application Support',
        'claude-multimodel-nodejs',
        'opencode',
        'host-startup-locks'
      )
    );
  });
});

describe('purgeStaleOpenCodeHostStartupLocks', () => {
  it('removes only lock entries that are at least as old as the threshold', async () => {
    writeLock('old.lock', 20 * 60_000);
    writeLock('fresh.lock', 1_000);
    fs.writeFileSync(path.join(locksDir, 'not-a-lock.json'), '{}');

    const result = await purgeStaleOpenCodeHostStartupLocks({
      locksDir,
      minAgeMs: PERIODIC_STALE_LOCK_MIN_AGE_MS,
    });

    expect(result).toMatchObject({ scanned: 2, removed: 1, kept: 1, diagnostics: [] });
    expect(fs.existsSync(path.join(locksDir, 'old.lock'))).toBe(false);
    expect(fs.existsSync(path.join(locksDir, 'fresh.lock'))).toBe(true);
    expect(fs.existsSync(path.join(locksDir, 'not-a-lock.json'))).toBe(true);
  });

  it('reports nothing at all when the lock directory does not exist', async () => {
    const result = await purgeStaleOpenCodeHostStartupLocks({
      locksDir: path.join(locksDir, 'missing'),
    });

    expect(result).toMatchObject({ scanned: 0, removed: 0, kept: 0, diagnostics: [] });
  });

  // A lock the OS refuses to remove is held by a host that is still running.
  // That is the expected outcome of a correct purge, not a problem to report,
  // and treating it as one would bury the failures that do matter.
  it.each(['EBUSY', 'EPERM', 'EACCES'])(
    'keeps a lock whose owner is still alive (%s) without reporting a problem',
    async (code) => {
      writeLock('held.lock', 20 * 60_000);

      const result = await purgeStaleOpenCodeHostStartupLocks({
        locksDir,
        minAgeMs: PERIODIC_STALE_LOCK_MIN_AGE_MS,
        removeLockEntry: () => Promise.reject(Object.assign(new Error('in use'), { code })),
      });

      expect(result).toMatchObject({ scanned: 1, removed: 0, kept: 1, diagnostics: [] });
      expect(fs.existsSync(path.join(locksDir, 'held.lock'))).toBe(true);
    }
  );

  it('reports a removal failure that is not a live owner', async () => {
    writeLock('broken.lock', 20 * 60_000);

    const result = await purgeStaleOpenCodeHostStartupLocks({
      locksDir,
      minAgeMs: PERIODIC_STALE_LOCK_MIN_AGE_MS,
      removeLockEntry: () => Promise.reject(Object.assign(new Error('nope'), { code: 'EIO' })),
    });

    expect(result).toMatchObject({ scanned: 1, removed: 0, kept: 1 });
    expect(result.diagnostics).toEqual(['broken.lock: Error: nope']);
  });
});

describe('purgeStaleOpenCodeHostStartupLocksBeforeLaunch', () => {
  it('purges the locks an earlier run left behind and reports the count durably', async () => {
    writeLock('old.lock', PRE_LAUNCH_STALE_LOCK_MIN_AGE_MS + 60_000);
    const logRemoved = vi.fn();

    const result = await purgeStaleOpenCodeHostStartupLocksBeforeLaunch({
      teamName: 'fixteam',
      aliveTeams: [],
      locksDir,
      logRemoved,
    });

    expect(result).toMatchObject({ removed: 1, kept: 0 });
    expect(fs.existsSync(path.join(locksDir, 'old.lock'))).toBe(false);
    expect(logRemoved).toHaveBeenCalledWith(
      'opencode_startup_locks_purged team=fixteam phase=pre_launch removed=1 kept=0'
    );
  });

  // A lock younger than the threshold belongs to a host that is starting right
  // now - possibly this very launch's own - so age is the only thing standing
  // between the purge and a host it must not disturb.
  it('keeps a lock younger than the pre-launch threshold', async () => {
    writeLock('starting.lock', PRE_LAUNCH_STALE_LOCK_MIN_AGE_MS - 5_000);
    const logRemoved = vi.fn();

    const result = await purgeStaleOpenCodeHostStartupLocksBeforeLaunch({
      teamName: 'fixteam',
      aliveTeams: [],
      locksDir,
      logRemoved,
    });

    expect(result).toMatchObject({ scanned: 1, removed: 0, kept: 1 });
    expect(fs.existsSync(path.join(locksDir, 'starting.lock'))).toBe(true);
    expect(logRemoved).not.toHaveBeenCalled();
  });

  it('does not purge at all while another team is alive', async () => {
    writeLock('old.lock', PRE_LAUNCH_STALE_LOCK_MIN_AGE_MS + 60_000);

    const result = await purgeStaleOpenCodeHostStartupLocksBeforeLaunch({
      teamName: 'fixteam',
      aliveTeams: ['fixteam', 'other-team'],
      locksDir,
    });

    expect(result).toBeNull();
    expect(fs.existsSync(path.join(locksDir, 'old.lock'))).toBe(true);
  });

  it("treats the launching team's own liveness as no obstacle", async () => {
    writeLock('old.lock', PRE_LAUNCH_STALE_LOCK_MIN_AGE_MS + 60_000);

    const result = await purgeStaleOpenCodeHostStartupLocksBeforeLaunch({
      teamName: 'fixteam',
      aliveTeams: ['fixteam'],
      locksDir,
    });

    expect(result).toMatchObject({ removed: 1 });
  });

  // It runs on the way into a launch, so a failure here must cost the launch
  // nothing at all.
  it('answers null instead of throwing when the purge itself fails', async () => {
    const logWarning = vi.fn();

    const result = await purgeStaleOpenCodeHostStartupLocksBeforeLaunch({
      teamName: 'fixteam',
      aliveTeams: [],
      locksDir,
      now: () => {
        throw new Error('clock unavailable');
      },
      logWarning,
    });

    expect(result).toBeNull();
    expect(logWarning).toHaveBeenCalledWith(
      '[fixteam] Pre-launch OpenCode host startup lock purge failed: clock unavailable'
    );
  });
});

describe('startPeriodicOpenCodeHostStartupLockPurge', () => {
  // Only the interval is faked: the purge itself does real file I/O, which has
  // to keep resolving on the real event loop while the schedule is driven.
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('purges stale locks on its own schedule and reports what it removed', async () => {
    writeLock('old.lock', 20 * 60_000);
    writeLock('fresh.lock', 1_000);
    const logInfo = vi.fn();
    const stop = startPeriodicOpenCodeHostStartupLockPurge({ locksDir, logInfo });

    try {
      // Nothing runs before the first interval elapses.
      expect(fs.existsSync(path.join(locksDir, 'old.lock'))).toBe(true);
      await vi.advanceTimersByTimeAsync(PERIODIC_STALE_LOCK_INTERVAL_MS);
      await vi.waitFor(() => expect(logInfo).toHaveBeenCalled());

      expect(fs.existsSync(path.join(locksDir, 'old.lock'))).toBe(false);
      expect(fs.existsSync(path.join(locksDir, 'fresh.lock'))).toBe(true);
      expect(logInfo).toHaveBeenCalledWith(
        '[OpenCode] periodic purge removed 1 stale host startup lock(s) (1 kept)'
      );
    } finally {
      stop();
    }
  });

  it('stops purging once it is stopped', async () => {
    const logInfo = vi.fn();
    const stop = startPeriodicOpenCodeHostStartupLockPurge({ locksDir, logInfo });
    stop();

    writeLock('old.lock', 20 * 60_000);
    await vi.advanceTimersByTimeAsync(PERIODIC_STALE_LOCK_INTERVAL_MS * 3);

    expect(fs.existsSync(path.join(locksDir, 'old.lock'))).toBe(true);
    expect(logInfo).not.toHaveBeenCalled();
  });

  it('says nothing on a round that removed no lock', async () => {
    writeLock('fresh.lock', 1_000);
    const logInfo = vi.fn();
    const logWarning = vi.fn();
    const stop = startPeriodicOpenCodeHostStartupLockPurge({ locksDir, logInfo, logWarning });

    try {
      await vi.advanceTimersByTimeAsync(PERIODIC_STALE_LOCK_INTERVAL_MS);

      expect(fs.existsSync(path.join(locksDir, 'fresh.lock'))).toBe(true);
      expect(logInfo).not.toHaveBeenCalled();
      expect(logWarning).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
