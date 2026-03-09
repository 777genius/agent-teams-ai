import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { withFileLock } from '@main/services/team/fileLock';

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

  it('creates parent directories for lock file', async () => {
    const nested = path.join(tmpDir, 'a', 'b', 'deep.json');

    const result = await withFileLock(nested, async () => 'created');
    expect(result).toBe('created');
    expect(fs.existsSync(`${nested}.lock`)).toBe(false);
  });
});
