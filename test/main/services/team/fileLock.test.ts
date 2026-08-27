import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  FILE_LOCK_RETIREMENT_MARKER,
  withFileLock,
  withFileLockSync,
} from '@main/services/team/fileLock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('node:fs', { spy: true });

const workerPath = path.resolve('test/fixtures/fileLockProcessWorker.ts');
const tsxPath = path.resolve('node_modules/tsx/dist/loader.mjs');

interface Worker {
  acquired: Promise<void>;
  release(): void;
  result: Promise<{ code: number | null; output: string }>;
}

function launchWorker(
  mode: 'async-holder' | 'sync-contender',
  target: string,
  trace: string
): Worker {
  const child = spawn(process.execPath, ['--import', tsxPath, workerPath, mode, target, trace], {
    cwd: process.cwd(),
    env: { ...process.env, NODE_ENV: 'test' },
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  let output = '';
  let markAcquired!: () => void;
  let rejectAcquired!: (error: Error) => void;
  let isAcquired = false;
  const acquired = new Promise<void>((resolve, reject) => {
    markAcquired = resolve;
    rejectAcquired = reject;
  });
  child.stdout!.on('data', (chunk) => {
    output += String(chunk);
    if (output.includes('acquired\n') || output.includes('attempting\n')) {
      isAcquired = true;
      markAcquired();
    }
  });
  child.stderr!.on('data', (chunk) => {
    output += String(chunk);
  });
  const result = once(child, 'close').then(([code]) => ({ code: code as number | null, output }));
  child.once('close', (code) => {
    if (!isAcquired) rejectAcquired(new Error(`Worker exited before barrier (${code}): ${output}`));
  });
  return {
    acquired,
    release: () => child.send('release'),
    result,
  };
}

function exactLegacyLockAge(lockPath: string, now: number): number | null {
  try {
    const content = fs.readFileSync(lockPath, 'utf8');
    const timestamp = Number.parseInt(content.split('\n')[1] || '', 10);
    return Number.isFinite(timestamp) ? now - timestamp : null;
  } catch {
    return null;
  }
}

function exactLegacyTryDeleteStale(lockPath: string, now: number, staleTimeoutMs: number): void {
  const age = exactLegacyLockAge(lockPath, now);
  if (age !== null && age > staleTimeoutMs) fs.unlinkSync(lockPath);
}

describe('withFileLock legacy compatibility ownership', () => {
  let temporaryRoot: string;
  let testFile: string;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'filelock-test-'));
    testFile = path.join(temporaryRoot, 'test.json');
    fs.writeFileSync(testFile, '[]', 'utf8');
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(temporaryRoot, { recursive: true, force: true });
  });

  it('uses the exact legacy namespace for async and synchronous operations', async () => {
    let asyncLockContent = '';
    const asyncResult = await withFileLock(testFile, async () => {
      asyncLockContent = fs.readFileSync(`${testFile}.lock`, 'utf8');
      return 42;
    });
    const syncResult = withFileLockSync(testFile, () => {
      expect(fs.statSync(`${testFile}.lock`).isFile()).toBe(true);
      return 43;
    });

    expect(asyncResult).toBe(42);
    expect(syncResult).toBe(43);
    expect(asyncLockContent.split('\n').slice(0, 3)).toEqual([
      String(process.pid),
      '9007199254740991',
      'agent-teams-legacy-authoritative-v1',
    ]);
    expect(fs.existsSync(`${testFile}.lock`)).toBe(false);
    expect(fs.existsSync(`${testFile}.lock.sqlite3`)).toBe(false);
  });

  it('atomically excludes an old creator in the former check-to-BEGIN window', async () => {
    const lockPath = `${testFile}.lock`;
    const originalOpen = fs.openSync;
    let injected = false;
    vi.spyOn(fs, 'openSync').mockImplementation(((target, flags, mode) => {
      if (!injected && String(target) === lockPath && flags === 'wx') {
        injected = true;
        const oldDescriptor = originalOpen(lockPath, 'wx', 0o600);
        fs.writeSync(oldDescriptor, `1234\n${Date.now()}\n`);
        fs.closeSync(oldDescriptor);
      }
      return originalOpen(target, flags, mode);
    }) as typeof fs.openSync);
    const callback = vi.fn(async () => undefined);

    await expect(withFileLock(testFile, callback, { acquireTimeoutMs: 60_000 })).rejects.toThrow(
      `Legacy file lock ownership is uncertain: ${testFile}`
    );
    expect(callback).not.toHaveBeenCalled();
    expect(fs.readFileSync(lockPath, 'utf8')).toMatch(/^1234\n/);
  });

  it('cannot expose an active lock to the exact legacy stale parser', async () => {
    await withFileLock(testFile, async () => {
      const lockPath = `${testFile}.lock`;
      fs.utimesSync(lockPath, new Date(0), new Date(0));
      exactLegacyTryDeleteStale(lockPath, Date.now() + 60_000, 1);
      expect(fs.existsSync(lockPath)).toBe(true);
      expect(exactLegacyLockAge(lockPath, Date.now())).toBeLessThan(0);
    });
  });

  it('defines a durable marker that the exact legacy parser cannot age out', () => {
    const lockPath = `${testFile}.lock`;
    fs.writeFileSync(lockPath, FILE_LOCK_RETIREMENT_MARKER, { encoding: 'utf8', mode: 0o600 });
    fs.utimesSync(lockPath, new Date(0), new Date(0));

    expect(FILE_LOCK_RETIREMENT_MARKER.split('\n').slice(0, 3)).toEqual([
      '0',
      '9007199254740991',
      'agent-teams-sqlite-cutover-v1',
    ]);
    exactLegacyTryDeleteStale(lockPath, Date.now() + 60_000, 1);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(FILE_LOCK_RETIREMENT_MARKER);
  });

  it('fails immediately on an ownerless two-line lock without deleting it', async () => {
    const lockPath = `${testFile}.lock`;
    const legacyContent = `424242\n${Date.now()}\n`;
    fs.writeFileSync(lockPath, legacyContent, 'utf8');
    const callback = vi.fn(async () => undefined);
    const timer = vi.spyOn(globalThis, 'setTimeout');

    await expect(withFileLock(testFile, callback, { acquireTimeoutMs: 120_000 })).rejects.toThrow(
      `Legacy file lock ownership is uncertain: ${testFile}`
    );
    expect(timer).not.toHaveBeenCalled();
    expect(callback).not.toHaveBeenCalled();
    expect(fs.readFileSync(lockPath, 'utf8')).toBe(legacyContent);
  });

  it.each([
    ['malformed file', (lockPath: string) => fs.writeFileSync(lockPath, 'foreign\nbytes\n')],
    ['directory', (lockPath: string) => fs.mkdirSync(lockPath)],
    ['symlink', (lockPath: string) => fs.symlinkSync(testFile, lockPath)],
  ])('fails immediately without deleting an unknown %s', async (_label, createUnknown) => {
    const lockPath = `${testFile}.lock`;
    createUnknown(lockPath);
    const before = fs.lstatSync(lockPath);
    const callback = vi.fn(async () => undefined);

    await expect(withFileLock(testFile, callback, { acquireTimeoutMs: 120_000 })).rejects.toThrow(
      `Legacy file lock ownership is uncertain: ${testFile}`
    );
    expect(callback).not.toHaveBeenCalled();
    const after = fs.lstatSync(lockPath);
    expect([after.dev, after.ino, after.mode]).toEqual([before.dev, before.ino, before.mode]);
  });

  it('detects ownership replacement and preserves the foreign path', async () => {
    const lockPath = `${testFile}.lock`;
    const displacedPath = `${lockPath}.displaced`;

    await expect(
      withFileLock(testFile, async () => {
        fs.renameSync(lockPath, displacedPath);
        fs.writeFileSync(lockPath, 'foreign replacement', 'utf8');
      })
    ).rejects.toThrow(`File lock ownership was lost: ${testFile}`);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('foreign replacement');
    expect(fs.existsSync(displacedPath)).toBe(true);
  });

  it('validates ownership again before protected effects', async () => {
    const lockPath = `${testFile}.lock`;
    const originalLstat = fs.lstatSync;
    let lockStatsReads = 0;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target, options) => {
      if (String(target) === lockPath && ++lockStatsReads === 2) {
        fs.renameSync(lockPath, `${lockPath}.displaced`);
        fs.writeFileSync(lockPath, 'foreign replacement', 'utf8');
      }
      return originalLstat(target, options as never);
    }) as typeof fs.lstatSync);
    const callback = vi.fn(async () => undefined);

    const attempt = withFileLock(testFile, callback);
    await expect(attempt).rejects.toThrow('File lock operation and cleanup both failed');
    await expect(attempt).rejects.toMatchObject({
      errors: [
        { message: `File lock ownership was lost: ${testFile}` },
        { message: `File lock ownership was lost: ${testFile}` },
      ],
    });
    expect(callback).not.toHaveBeenCalled();
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('foreign replacement');
  });

  it('preserves callback and cleanup failures deterministically', async () => {
    const callbackError = new Error('callback failed');
    const lockPath = `${testFile}.lock`;
    let caught: unknown;
    try {
      await withFileLock(testFile, async () => {
        fs.renameSync(lockPath, `${lockPath}.displaced`);
        fs.writeFileSync(lockPath, 'foreign replacement', 'utf8');
        throw callbackError;
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(AggregateError);
    const aggregate = caught as AggregateError;
    expect(aggregate.errors[0]).toBe(callbackError);
    expect(aggregate.errors[1]).toMatchObject({
      message: `File lock ownership was lost: ${testFile}`,
    });
    expect(aggregate.cause).toBe(callbackError);
    expect(fs.readFileSync(lockPath, 'utf8')).toBe('foreign replacement');
  });

  it('fails a sync caller behind an async same-process owner without spinning', async () => {
    let releaseOwner!: () => void;
    let markAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const owner = withFileLock(testFile, async () => {
      markAcquired();
      await new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
    });
    await acquired;

    expect(() => withFileLockSync(testFile, () => undefined)).toThrow(
      `File lock is already held by this process: ${testFile}`
    );
    releaseOwner();
    await owner;
  });

  it('keys same-process ownership by the canonical lock path across aliases', async () => {
    const aliasDirectory = path.join(temporaryRoot, 'alias');
    fs.symlinkSync(temporaryRoot, aliasDirectory, 'dir');
    const aliasedFile = path.join(aliasDirectory, path.basename(testFile));
    let releaseOwner!: () => void;
    let markAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const owner = withFileLock(testFile, async () => {
      markAcquired();
      await new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
    });
    await acquired;

    expect(() =>
      withFileLockSync(aliasedFile, () => undefined, { acquireTimeoutMs: 120_000 })
    ).toThrow(`File lock is already held by this process: ${aliasedFile}`);
    releaseOwner();
    await owner;
  });

  it('rejects an async caller through an alias while the canonical path is held', async () => {
    const aliasDirectory = path.join(temporaryRoot, 'async-alias');
    fs.symlinkSync(temporaryRoot, aliasDirectory, 'dir');
    const aliasedFile = path.join(aliasDirectory, path.basename(testFile));
    let releaseOwner!: () => void;
    let markAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const owner = withFileLock(testFile, async () => {
      markAcquired();
      await new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
    });
    await acquired;

    const callback = vi.fn(async () => undefined);
    await expect(
      withFileLock(aliasedFile, callback, { acquireTimeoutMs: 120_000 })
    ).rejects.toThrow(`File lock is already held by this process: ${aliasedFile}`);
    expect(callback).not.toHaveBeenCalled();
    releaseOwner();
    await owner;
  });

  it('fails closed when a requested symlink parent is retargeted before callback entry', async () => {
    const originalDirectory = path.join(temporaryRoot, 'original');
    const retargetedDirectory = path.join(temporaryRoot, 'retargeted');
    const aliasDirectory = path.join(temporaryRoot, 'mutable-alias');
    fs.mkdirSync(originalDirectory);
    fs.mkdirSync(retargetedDirectory);
    fs.symlinkSync(originalDirectory, aliasDirectory, 'dir');
    const aliasedFile = path.join(aliasDirectory, 'protected.json');
    const originalLockPath = path.join(originalDirectory, 'protected.json.lock');
    const retargetedLockPath = path.join(retargetedDirectory, 'protected.json.lock');
    const originalReadFile = fs.readFileSync;
    let retargeted = false;
    vi.spyOn(fs, 'readFileSync').mockImplementation(((target, options) => {
      const result = originalReadFile(target, options as never);
      if (!retargeted && String(target) === originalLockPath) {
        retargeted = true;
        fs.unlinkSync(aliasDirectory);
        fs.symlinkSync(retargetedDirectory, aliasDirectory, 'dir');
      }
      return result;
    }) as typeof fs.readFileSync);
    const callback = vi.fn(async () => undefined);

    const attempt = withFileLock(aliasedFile, callback);
    await expect(attempt).rejects.toThrow('File lock operation and cleanup both failed');
    await expect(attempt).rejects.toMatchObject({
      errors: [
        { message: `File lock ownership was lost: ${aliasedFile}` },
        { message: `File lock ownership was lost: ${aliasedFile}` },
      ],
    });
    expect(retargeted).toBe(true);
    expect(callback).not.toHaveBeenCalled();
    expect(fs.existsSync(originalLockPath)).toBe(true);
    expect(fs.existsSync(retargetedLockPath)).toBe(false);
  });

  it('queues behind a valid new-format contender and succeeds after release', async () => {
    const tracePath = path.join(temporaryRoot, 'trace');
    const holder = launchWorker('async-holder', testFile, tracePath);
    await holder.acquired;
    const contender = launchWorker('sync-contender', testFile, tracePath);
    await contender.acquired;

    holder.release();
    const [holderResult, contenderResult] = await Promise.all([holder.result, contender.result]);
    expect(holderResult.code, holderResult.output).toBe(0);
    expect(contenderResult.code, contenderResult.output).toBe(0);
    expect(fs.readFileSync(tracePath, 'utf8').trim().split('\n')).toEqual([
      'holder:start',
      'holder:end',
      'contender:acquired',
    ]);
  });
});
