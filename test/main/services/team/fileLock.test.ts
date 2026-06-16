import { withFileLock } from '@main/services/team/fileLock';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const canAssertPosixPermissions = process.platform !== 'win32' && process.getuid?.() !== 0;

describe('withFileLock', () => {
  let tmpDir: string;
  let testFile: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'filelock-test-'));
    testFile = path.join(tmpDir, 'test.json');
    fs.writeFileSync(testFile, '[]', 'utf8');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('acquires and releases lock around fn()', async () => {
    const lockPath = `${testFile}.lock`;

    const result = await withFileLock(testFile, async () => {
      expect(fs.existsSync(lockPath)).toBe(true);
      return 42;
    });

    expect(result).toBe(42);
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('releases lock even on error', async () => {
    const lockPath = `${testFile}.lock`;

    await expect(
      withFileLock(testFile, async () => {
        throw new Error('boom');
      })
    ).rejects.toThrow('boom');

    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('serializes concurrent access', async () => {
    const order: number[] = [];

    const task = (id: number, delayMs: number) =>
      withFileLock(testFile, async () => {
        order.push(id);
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      });

    await Promise.all([task(1, 50), task(2, 10), task(3, 10)]);

    expect(order).toHaveLength(3);
    expect(new Set(order).size).toBe(3);
  });

  it('removes stale lock and acquires', async () => {
    const lockPath = `${testFile}.lock`;
    // Create a stale lock (timestamp 60s ago)
    fs.writeFileSync(lockPath, `99999\n${Date.now() - 60_000}\n`, 'utf8');

    const result = await withFileLock(testFile, async () => 'ok');
    expect(result).toBe('ok');
  });

  it('removes stale directory lock and acquires', async () => {
    const lockPath = `${testFile}.lock`;
    fs.mkdirSync(lockPath);
    const staleDate = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, staleDate, staleDate);

    const result = await withFileLock(testFile, async () => 'ok', {
      staleTimeoutMs: 1_000,
    });

    expect(result).toBe('ok');
    expect(fs.existsSync(lockPath)).toBe(false);
  });

  it('removes a fresh abandoned lock when the owner process is gone', async () => {
    const lockPath = `${testFile}.lock`;
    const abandonedPid = 424_242;
    fs.writeFileSync(lockPath, `${abandonedPid}\n${Date.now()}\n`, 'utf8');
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number | string) => {
      if (pid === abandonedPid) {
        const error = new Error('process is gone') as NodeJS.ErrnoException;
        error.code = 'ESRCH';
        throw error;
      }
      return true;
    }) as typeof process.kill);

    try {
      const result = await withFileLock(testFile, async () => 'ok');

      expect(result).toBe('ok');
      expect(fs.existsSync(lockPath)).toBe(false);
    } finally {
      killSpy.mockRestore();
    }
  });

  it('creates parent directories for lock file', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'deep.json');

    const result = await withFileLock(nested, async () => 'created');
    expect(result).toBe('created');
    expect(fs.existsSync(`${nested}.lock`)).toBe(false);
  });

  it.skipIf(!canAssertPosixPermissions)(
    'rethrows fatal errors while creating missing lock directory',
    async () => {
      const readonlyDir = path.join(tmpDir, 'readonly');
      fs.mkdirSync(readonlyDir, 0o555);
      const nested = path.join(readonlyDir, 'missing', 'test.json');

      try {
        await expect(
          withFileLock(nested, async () => 'ok', {
            acquireTimeoutMs: 25,
            retryIntervalMs: 1,
          })
        ).rejects.toMatchObject({ code: 'EACCES' });
      } finally {
        fs.chmodSync(readonlyDir, 0o755);
      }
    }
  );
});
