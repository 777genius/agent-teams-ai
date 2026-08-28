import { spawn } from 'node:child_process';
import { once } from 'node:events';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import * as sqliteTransactionLock from '@main/services/infrastructure/SqliteTransactionLock';
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
  mode: 'async-holder' | 'authority-holder' | 'crash-holder' | 'sync-contender',
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

interface CapturedFailure {
  error?: unknown;
  failed: boolean;
}

function captureFailure(fn: () => unknown): CapturedFailure {
  try {
    fn();
    return { failed: false };
  } catch (error) {
    return { error, failed: true };
  }
}

async function captureAsyncFailure(fn: () => Promise<unknown>): Promise<CapturedFailure> {
  try {
    await fn();
    return { failed: false };
  } catch (error) {
    return { error, failed: true };
  }
}

function failOwnedDescriptorClose(closeError: unknown): () => void {
  const originalClose = fs.closeSync;
  let failedDescriptor: number | undefined;
  const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
    if (failedDescriptor === undefined && fs.fstatSync(descriptor).isFile()) {
      failedDescriptor = descriptor;
      throw closeError;
    }
    originalClose(descriptor);
  });

  return () => {
    closeSpy.mockRestore();
    if (failedDescriptor !== undefined) originalClose(failedDescriptor);
  };
}

function expectUndefinedOperationAggregate(error: unknown, cleanupError: Error): void {
  expect(error).toBeInstanceOf(AggregateError);
  const aggregate = error as AggregateError;
  expect(aggregate.message).toBe('File lock operation and cleanup both failed');
  expect(aggregate.errors[0]).toMatchObject({
    message: 'File lock operation failed by throwing undefined',
  });
  expect(Object.prototype.hasOwnProperty.call(aggregate.errors[0], 'cause')).toBe(true);
  expect((aggregate.errors[0] as Error).cause).toBeUndefined();
  expect(aggregate.errors[1]).toBe(cleanupError);
  expect(aggregate.cause).toBe(aggregate.errors[0]);
}

const COMPLETE_PUBLICATION = `${process.pid}\n9007199254740991\nagent-teams-legacy-authoritative-v2\n12345678-1234-4123-8123-123456789abc\n`;

describe('withFileLock legacy compatibility ownership', () => {
  let temporaryRoot: string;
  let testFile: string;

  beforeEach(() => {
    temporaryRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'filelock-test-'));
    testFile = path.join(temporaryRoot, 'test.json');
    fs.writeFileSync(testFile, '[]', 'utf8');
  });

  afterEach(() => {
    vi.useRealTimers();
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
      'agent-teams-legacy-authoritative-v2',
    ]);
    expect(fs.existsSync(`${testFile}.lock`)).toBe(false);
    expect(fs.statSync(`${testFile}.lock.sqlite3`).isFile()).toBe(true);
    expect(fs.existsSync(`${testFile}.lock.lock.sqlite3`)).toBe(false);
  });

  it('atomically excludes an old creator in the former check-to-BEGIN window', async () => {
    const lockPath = `${testFile}.lock`;
    const originalLink = fs.linkSync;
    let injected = false;
    vi.spyOn(fs, 'linkSync').mockImplementation((existingPath, newPath) => {
      if (!injected && String(newPath) === lockPath) {
        injected = true;
        fs.writeFileSync(lockPath, `1234\n${Date.now()}\n`, { flag: 'wx', mode: 0o600 });
      }
      return originalLink(existingPath, newPath);
    });
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
    expect(fs.existsSync(`${testFile}.lock.sqlite3`)).toBe(false);
    expect(fs.existsSync(`${testFile}.lock.publishing`)).toBe(false);
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
      if (String(target) === lockPath && ++lockStatsReads === 3) {
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

  it('preserves a synchronous callback throwing undefined', () => {
    const failure = captureFailure(() =>
      withFileLockSync(testFile, () => {
        throw undefined;
      })
    );

    expect(failure.failed).toBe(true);
    expect(failure.error).toBeUndefined();
    expect(fs.existsSync(`${testFile}.lock`)).toBe(false);
  });

  it('preserves an asynchronous callback rejecting with undefined', async () => {
    const failure = await captureAsyncFailure(() =>
      withFileLock(testFile, async () => await Promise.reject())
    );

    expect(failure.failed).toBe(true);
    expect(failure.error).toBeUndefined();
    expect(fs.existsSync(`${testFile}.lock`)).toBe(false);
  });

  it('aggregates synchronous undefined callback and descriptor close failures', () => {
    const cleanupError = new Error('sync close failed');
    const closeLeakedDescriptor = failOwnedDescriptorClose(cleanupError);
    try {
      const failure = captureFailure(() =>
        withFileLockSync(testFile, () => {
          throw undefined;
        })
      );

      expect(failure.failed).toBe(true);
      expectUndefinedOperationAggregate(failure.error, cleanupError);
    } finally {
      closeLeakedDescriptor();
    }
  });

  it('aggregates asynchronous undefined callback and descriptor close failures', async () => {
    const cleanupError = new Error('async close failed');
    const closeLeakedDescriptor = failOwnedDescriptorClose(cleanupError);
    try {
      const failure = await captureAsyncFailure(() =>
        withFileLock(testFile, async () => await Promise.reject())
      );

      expect(failure.failed).toBe(true);
      expectUndefinedOperationAggregate(failure.error, cleanupError);
    } finally {
      closeLeakedDescriptor();
    }
  });

  it('surfaces a synchronous descriptor close failure after callback success', () => {
    const cleanupError = new Error('sync close failed after success');
    const closeLeakedDescriptor = failOwnedDescriptorClose(cleanupError);
    try {
      const failure = captureFailure(() => withFileLockSync(testFile, () => 42));

      expect(failure).toEqual({ error: cleanupError, failed: true });
    } finally {
      closeLeakedDescriptor();
    }
  });

  it('does not let a synchronous descriptor close failure mask an earlier cleanup failure', () => {
    const cleanupError = new Error('sync unlink failed');
    const closeError = new Error('sync close failed after unlink');
    vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (String(target) === `${testFile}.lock`) throw cleanupError;
    });
    const closeLeakedDescriptor = failOwnedDescriptorClose(closeError);
    try {
      const failure = captureFailure(() => withFileLockSync(testFile, () => 42));

      expect(failure.error).toMatchObject({
        cause: cleanupError,
        errors: [cleanupError, closeError],
        message: 'File lock cleanup and descriptor close both failed',
      });
    } finally {
      closeLeakedDescriptor();
    }
  });

  it('surfaces an asynchronous descriptor close failure after callback success', async () => {
    const cleanupError = new Error('async close failed after success');
    const closeLeakedDescriptor = failOwnedDescriptorClose(cleanupError);
    try {
      const failure = await captureAsyncFailure(() => withFileLock(testFile, async () => 42));

      expect(failure).toEqual({ error: cleanupError, failed: true });
    } finally {
      closeLeakedDescriptor();
    }
  });

  it('orders synchronous callback and descriptor close errors causally', () => {
    const callbackError = new Error('sync callback failed');
    const cleanupError = new Error('sync close failed after callback');
    const closeLeakedDescriptor = failOwnedDescriptorClose(cleanupError);
    try {
      const failure = captureFailure(() =>
        withFileLockSync(testFile, () => {
          throw callbackError;
        })
      );

      expect(failure.error).toMatchObject({
        cause: callbackError,
        errors: [callbackError, cleanupError],
        message: 'File lock operation and cleanup both failed',
      });
    } finally {
      closeLeakedDescriptor();
    }
  });

  it('orders asynchronous callback and descriptor close errors causally', async () => {
    const callbackError = new Error('async callback failed');
    const cleanupError = new Error('async close failed after callback');
    const closeLeakedDescriptor = failOwnedDescriptorClose(cleanupError);
    try {
      const failure = await captureAsyncFailure(() =>
        withFileLock(testFile, async () => await Promise.reject(callbackError))
      );

      expect(failure.error).toMatchObject({
        cause: callbackError,
        errors: [callbackError, cleanupError],
        message: 'File lock operation and cleanup both failed',
      });
    } finally {
      closeLeakedDescriptor();
    }
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

  it('rejects nested async reentry on the same canonical path before callback', async () => {
    const nestedCallback = vi.fn(async () => undefined);
    const timer = vi.spyOn(globalThis, 'setTimeout');

    await withFileLock(testFile, async () => {
      await expect(
        withFileLock(testFile, nestedCallback, {
          acquireTimeoutMs: 120_000,
          retryIntervalMs: 10_000,
        })
      ).rejects.toThrow(`File lock is already held by this process: ${testFile}`);
    });

    expect(timer).not.toHaveBeenCalled();
    expect(nestedCallback).not.toHaveBeenCalled();
  });

  it('rejects nested async reentry through a canonical alias before callback', async () => {
    const aliasDirectory = path.join(temporaryRoot, 'async-alias');
    fs.symlinkSync(temporaryRoot, aliasDirectory, 'dir');
    const aliasedFile = path.join(aliasDirectory, path.basename(testFile));
    const nestedCallback = vi.fn(async () => undefined);

    await withFileLock(testFile, async () => {
      await Promise.resolve();
      await expect(
        withFileLock(aliasedFile, nestedCallback, { acquireTimeoutMs: 120_000 })
      ).rejects.toThrow(`File lock is already held by this process: ${aliasedFile}`);
    });

    expect(nestedCallback).not.toHaveBeenCalled();
  });

  it('expires inherited async ownership only after the exact owner releases', async () => {
    let activeAttempt!: Promise<string>;
    let deferredAttempt!: Promise<string>;

    await withFileLock(testFile, async () => {
      activeAttempt = new Promise((resolve) => {
        setTimeout(() => {
          void withFileLock(testFile, async () => 'unexpected').then(
            () => resolve('entered'),
            (error) => resolve((error as Error).message)
          );
        }, 0);
      });
      deferredAttempt = new Promise((resolve, reject) => {
        setTimeout(() => {
          void withFileLock(testFile, async () => 'entered-after-release').then(resolve, reject);
        }, 50);
      });

      await expect(activeAttempt).resolves.toBe(
        `File lock is already held by this process: ${testFile}`
      );
    });

    await expect(deferredAttempt).resolves.toBe('entered-after-release');
  });

  it('queues a separate same-path async contender until exact release', async () => {
    let releaseOwner!: () => void;
    let markAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    let ownerLockContent = '';
    const owner = withFileLock(testFile, async () => {
      ownerLockContent = fs.readFileSync(`${testFile}.lock`, 'utf8');
      markAcquired();
      await new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
    });
    await acquired;

    const callback = vi.fn(async () => fs.readFileSync(`${testFile}.lock`, 'utf8'));
    const contender = withFileLock(testFile, callback, {
      acquireTimeoutMs: 1_000,
      retryIntervalMs: 5,
    });
    expect(callback).not.toHaveBeenCalled();
    releaseOwner();
    await owner;
    const contenderLockContent = await contender;
    expect(contenderLockContent).not.toBe(ownerLockContent);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('queues a separate async alias contender until canonical owner release', async () => {
    const aliasDirectory = path.join(temporaryRoot, 'queued-async-alias');
    fs.symlinkSync(temporaryRoot, aliasDirectory, 'dir');
    const aliasedFile = path.join(aliasDirectory, path.basename(testFile));
    let releaseOwner!: () => void;
    let markAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    let ownerLockContent = '';
    const owner = withFileLock(testFile, async () => {
      ownerLockContent = fs.readFileSync(`${testFile}.lock`, 'utf8');
      markAcquired();
      await new Promise<void>((resolve) => {
        releaseOwner = resolve;
      });
    });
    await acquired;

    const callback = vi.fn(async () => fs.readFileSync(`${testFile}.lock`, 'utf8'));
    const contender = withFileLock(aliasedFile, callback, {
      acquireTimeoutMs: 1_000,
      retryIntervalMs: 5,
    });
    expect(callback).not.toHaveBeenCalled();
    releaseOwner();
    await owner;
    const contenderLockContent = await contender;
    expect(contenderLockContent).not.toBe(ownerLockContent);
    expect(callback).toHaveBeenCalledOnce();
  });

  it('does not split ownership when the active same-process lock pathname disappears', async () => {
    const lockPath = `${testFile}.lock`;
    let settleOwner!: () => void;
    let markAcquired!: () => void;
    const acquired = new Promise<void>((resolve) => {
      markAcquired = resolve;
    });
    const owner = withFileLock(testFile, async () => {
      markAcquired();
      await new Promise<void>((resolve) => {
        settleOwner = resolve;
      });
    });
    await acquired;
    fs.unlinkSync(lockPath);

    const callback = vi.fn(async () => undefined);
    const contender = withFileLock(testFile, callback, {
      acquireTimeoutMs: 1_000,
      retryIntervalMs: 5,
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(callback).not.toHaveBeenCalled();
    expect(fs.existsSync(lockPath)).toBe(false);

    settleOwner();
    await expect(owner).rejects.toThrow(`File lock ownership was lost: ${testFile}`);
    await contender;
    expect(callback).toHaveBeenCalledOnce();
  });

  it('bounds timeout for a separate same-process async contender without callback entry', async () => {
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

    vi.useFakeTimers();
    const callback = vi.fn(async () => undefined);
    const contender = withFileLock(testFile, callback, {
      acquireTimeoutMs: 60,
      retryIntervalMs: 5,
    });
    const rejection = expect(contender).rejects.toThrow(`File lock timeout: ${testFile}`);
    await vi.advanceTimersByTimeAsync(60);

    await rejection;
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

  it('keeps child processes excluded after the holder pathname is unlinked', async () => {
    const tracePath = path.join(temporaryRoot, 'unlink-trace');
    const holder = launchWorker('async-holder', testFile, tracePath);
    await holder.acquired;
    fs.unlinkSync(`${testFile}.lock`);

    const contender = launchWorker('sync-contender', testFile, tracePath);
    await contender.acquired;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.readFileSync(tracePath, 'utf8').trim().split('\n')).toEqual(['holder:start']);

    holder.release();
    const [holderResult, contenderResult] = await Promise.all([holder.result, contender.result]);
    expect(holderResult.code, holderResult.output).not.toBe(0);
    expect(contenderResult.code, contenderResult.output).toBe(0);
    expect(fs.readFileSync(tracePath, 'utf8').trim().split('\n')).toEqual([
      'holder:start',
      'holder:end',
      'contender:acquired',
    ]);
  });

  it('treats controlled pre-publication authority as ordinary child-process contention', async () => {
    const tracePath = path.join(temporaryRoot, 'publication-trace');
    const publisher = launchWorker('authority-holder', testFile, tracePath);
    await publisher.acquired;
    expect(fs.existsSync(`${testFile}.lock`)).toBe(false);

    const contender = launchWorker('sync-contender', testFile, tracePath);
    await contender.acquired;
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(fs.readFileSync(tracePath, 'utf8').trim().split('\n')).toEqual(['publication:start']);

    publisher.release();
    const [publisherResult, contenderResult] = await Promise.all([
      publisher.result,
      contender.result,
    ]);
    expect(publisherResult.code, publisherResult.output).toBe(0);
    expect(contenderResult.code, contenderResult.output).toBe(0);
    expect(fs.readFileSync(tracePath, 'utf8').trim().split('\n')).toEqual([
      'publication:start',
      'publication:end',
      'contender:acquired',
    ]);
  });

  it('recovers a branded legacy tombstone after a child crashes', async () => {
    const tracePath = path.join(temporaryRoot, 'crash-trace');
    const crashed = launchWorker('crash-holder', testFile, tracePath);
    await crashed.acquired;
    const crashedContent = fs.readFileSync(`${testFile}.lock`, 'utf8');
    expect(crashedContent).toContain('agent-teams-legacy-authoritative-v2');

    crashed.release();
    const crashedResult = await crashed.result;
    expect(crashedResult.code, crashedResult.output).toBe(17);
    expect(fs.existsSync(`${testFile}.lock`)).toBe(true);

    const contender = launchWorker('sync-contender', testFile, tracePath);
    await contender.acquired;
    const contenderResult = await contender.result;
    expect(contenderResult.code, contenderResult.output).toBe(0);
    expect(fs.existsSync(`${testFile}.lock`)).toBe(false);
    expect(fs.readFileSync(tracePath, 'utf8').trim().split('\n')).toEqual([
      'crash:start',
      'contender:acquired',
    ]);
  });

  it.each(Array.from({ length: COMPLETE_PUBLICATION.length }, (_, length) => length))(
    'recovers a publication interrupted after exactly %i bytes on restart',
    (length) => {
      const publicationPath = `${testFile}.lock.publishing`;
      fs.writeFileSync(publicationPath, COMPLETE_PUBLICATION.slice(0, length), {
        encoding: 'utf8',
        mode: 0o600,
      });

      expect(withFileLockSync(testFile, () => 'restarted')).toBe('restarted');
      expect(fs.existsSync(publicationPath)).toBe(false);
      expect(fs.existsSync(`${testFile}.lock`)).toBe(false);
    }
  );

  it('recovers a complete branded publication left by a crashed predecessor', () => {
    const publicationPath = `${testFile}.lock.publishing`;
    fs.writeFileSync(publicationPath, COMPLETE_PUBLICATION, { encoding: 'utf8', mode: 0o600 });

    expect(withFileLockSync(testFile, () => 'restarted')).toBe('restarted');
    expect(fs.existsSync(publicationPath)).toBe(false);
  });

  it('rejects malformed publication bytes without deleting them', () => {
    const publicationPath = `${testFile}.lock.publishing`;
    const malformed = Buffer.from([0xff, 0x00, 0x61, 0x0a]);
    fs.writeFileSync(publicationPath, malformed, { mode: 0o600 });

    expect(() => withFileLockSync(testFile, () => undefined)).toThrow(
      `Unsafe file lock publication tombstone: ${publicationPath}`
    );
    expect(fs.readFileSync(publicationPath)).toEqual(malformed);
    expect(fs.existsSync(`${testFile}.lock`)).toBe(false);
  });

  it('does not unlink a foreign inode that replaces the inspected publication', () => {
    const publicationPath = `${testFile}.lock.publishing`;
    const inspectedPath = `${publicationPath}.inspected`;
    fs.writeFileSync(publicationPath, COMPLETE_PUBLICATION.slice(0, 17), {
      encoding: 'utf8',
      mode: 0o600,
    });
    const originalLstat = fs.lstatSync;
    let publicationStatsReads = 0;
    vi.spyOn(fs, 'lstatSync').mockImplementation(((target, options) => {
      if (String(target) === publicationPath && ++publicationStatsReads === 3) {
        fs.renameSync(publicationPath, inspectedPath);
        fs.writeFileSync(publicationPath, 'foreign replacement', { mode: 0o600 });
      }
      return originalLstat(target, options as never);
    }) as typeof fs.lstatSync);

    expect(() => withFileLockSync(testFile, () => undefined)).toThrow(
      'Lock changed before cleanup'
    );
    expect(fs.readFileSync(publicationPath, 'utf8')).toBe('foreign replacement');
    expect(fs.existsSync(inspectedPath)).toBe(true);
    expect(fs.existsSync(`${testFile}.lock`)).toBe(false);
  });

  it('reports stale-publication cleanup failure, releases authority, and permits restart', () => {
    const publicationPath = `${testFile}.lock.publishing`;
    fs.writeFileSync(publicationPath, '', { mode: 0o600 });
    const cleanupError = new Error('stale publication unlink failed');
    const originalUnlink = fs.unlinkSync;
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (String(target) === publicationPath) throw cleanupError;
      originalUnlink(target);
    });

    const failure = captureFailure(() => withFileLockSync(testFile, () => undefined));
    expect(failure).toEqual({ error: cleanupError, failed: true });
    expect(fs.existsSync(publicationPath)).toBe(true);

    unlinkSpy.mockRestore();
    expect(withFileLockSync(testFile, () => 'restarted')).toBe('restarted');
    expect(fs.existsSync(publicationPath)).toBe(false);
  });

  it.each(['write', 'fsync', 'link'] as const)(
    'preserves the %s publication failure and removes its poison',
    (stage) => {
      const publicationPath = `${testFile}.lock.publishing`;
      const primaryError = new Error(`${stage} publication failed`);
      const originalWrite = fs.writeFileSync;
      const originalFsync = fs.fsyncSync;
      const originalLink = fs.linkSync;
      let injected = false;
      const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((
        target,
        data,
        options
      ) => {
        if (stage === 'write' && !injected && typeof target === 'number') {
          injected = true;
          throw primaryError;
        }
        return originalWrite(target, data, options as never);
      }) as typeof fs.writeFileSync);
      const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation((descriptor) => {
        if (stage === 'fsync' && !injected && fs.fstatSync(descriptor).isFile()) {
          injected = true;
          throw primaryError;
        }
        originalFsync(descriptor);
      });
      const linkSpy = vi.spyOn(fs, 'linkSync').mockImplementation((existingPath, newPath) => {
        if (stage === 'link' && !injected && String(newPath) === `${testFile}.lock`) {
          injected = true;
          throw primaryError;
        }
        originalLink(existingPath, newPath);
      });

      const callback = vi.fn(() => undefined);
      const failure = captureFailure(() => withFileLockSync(testFile, callback));
      expect(failure).toEqual({ error: primaryError, failed: true });
      expect(callback).not.toHaveBeenCalled();
      expect(fs.existsSync(publicationPath)).toBe(false);
      expect(fs.existsSync(`${testFile}.lock`)).toBe(false);
      writeSpy.mockRestore();
      fsyncSpy.mockRestore();
      linkSpy.mockRestore();
      expect(withFileLockSync(testFile, () => 'next')).toBe('next');
    }
  );

  it('aggregates acquisition and every cleanup failure in causal order, including undefined', () => {
    const publicationPath = `${testFile}.lock.publishing`;
    const closeError = new Error('publication close failed');
    const unlinkError = new Error('publication unlink failed');
    const trace: string[] = [];
    const originalWrite = fs.writeFileSync;
    const originalClose = fs.closeSync;
    const originalUnlink = fs.unlinkSync;
    const originalLstat = fs.lstatSync;
    let leakedDescriptor: number | undefined;
    const databasePath = sqliteTransactionLock.getSqliteTransactionLockDatabasePath(testFile);
    const expectedReleaseError = `File lock ownership was lost: ${testFile}`;
    let publicationUnlinkAttempted = false;
    let releaseFailed = false;
    const lstatSpy = vi.spyOn(fs, 'lstatSync').mockImplementation(((target, options) => {
      if (publicationUnlinkAttempted && !releaseFailed && String(target) === databasePath) {
        releaseFailed = true;
        trace.push('release');
        throw new Error('injected authority identity read failure');
      }
      return originalLstat(target, options as never);
    }) as typeof fs.lstatSync);
    const writeSpy = vi.spyOn(fs, 'writeFileSync').mockImplementation(((target, data, options) => {
      if (typeof target === 'number') {
        trace.push('write');
        throw undefined;
      }
      return originalWrite(target, data, options as never);
    }) as typeof fs.writeFileSync);
    const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((descriptor) => {
      if (leakedDescriptor === undefined && fs.fstatSync(descriptor).isFile()) {
        leakedDescriptor = descriptor;
        trace.push('close');
        throw closeError;
      }
      originalClose(descriptor);
    });
    const unlinkSpy = vi.spyOn(fs, 'unlinkSync').mockImplementation((target) => {
      if (String(target) === publicationPath) {
        trace.push('unlink');
        publicationUnlinkAttempted = true;
        throw unlinkError;
      }
      originalUnlink(target);
    });

    const failure = captureFailure(() => withFileLockSync(testFile, () => undefined));
    expect(failure.failed).toBe(true);
    expect(failure.error).toBeInstanceOf(AggregateError);
    const aggregate = failure.error as AggregateError;
    expect(aggregate.message).toBe('File lock acquisition and cleanup failed');
    expect(aggregate.errors).toHaveLength(4);
    expect(aggregate.errors[0]).toMatchObject({
      message: 'File lock acquisition failed by throwing undefined',
    });
    expect(aggregate.errors.slice(1, 3)).toEqual([closeError, unlinkError]);
    expect(aggregate.errors[3]).toMatchObject({ message: expectedReleaseError });
    expect(aggregate.cause).toBe(aggregate.errors[0]);
    expect(trace).toEqual(['write', 'close', 'unlink', 'release']);
    expect(fs.existsSync(publicationPath)).toBe(true);

    writeSpy.mockRestore();
    closeSpy.mockRestore();
    unlinkSpy.mockRestore();
    lstatSpy.mockRestore();
    if (leakedDescriptor !== undefined) originalClose(leakedDescriptor);
    expect(withFileLockSync(testFile, () => 'next')).toBe('next');
    expect(fs.existsSync(publicationPath)).toBe(false);
  });
});
