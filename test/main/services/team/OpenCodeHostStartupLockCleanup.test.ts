import {
  PERIODIC_STALE_LOCK_INTERVAL_MS,
  PERIODIC_STALE_LOCK_MIN_AGE_MS,
  purgeStaleOpenCodeHostStartupLocks,
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
