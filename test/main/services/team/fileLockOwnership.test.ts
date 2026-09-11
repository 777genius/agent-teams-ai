import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withFileLock, withFileLockSync } from '@main/services/team/fileLock';
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('file lock physical owner mode', () => {
  let root: string;
  let path: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'work-sync-lock-owner-'));
    path = join(root, 'sandbox.json');
  });
  afterEach(async () => {
    vi.restoreAllMocks();
    await rm(root, { recursive: true, force: true });
  });

  it('makes even a default waiter respect a strict live owner older than the lease', async () => {
    await withFileLock(
      path,
      async () => {
        const future = Date.now() + 31_000;
        vi.spyOn(Date, 'now').mockReturnValue(future);
        expect(() => withFileLockSync(path, () => 'stolen', { acquireTimeoutMs: 0 })).toThrow(
          'File lock timeout'
        );
        expect(await readFile(`${path}.lock`, 'utf8')).toContain('strict:');
      },
      { preventLiveOwnerTakeover: true }
    );
  });

  it('does not let a strict waiter evict an old live legacy owner', async () => {
    await withFileLock(path, async () => {
      const future = Date.now() + 31_000;
      vi.spyOn(Date, 'now').mockReturnValue(future);
      expect(() =>
        withFileLockSync(path, () => 'stolen', {
          acquireTimeoutMs: 0,
          preventLiveOwnerTakeover: true,
        })
      ).toThrow('File lock timeout');
    });
  });

  it('cleans its own failed acquisition after a candidate write fault', async () => {
    const fault = new Error('test lock acquisition fault');
    const spy = vi.spyOn(fs, 'writeSync').mockImplementationOnce(() => {
      throw fault;
    });
    let called = false;
    await expect(
      withFileLock(
        path,
        async () => {
          called = true;
        },
        {
          preventLiveOwnerTakeover: true,
        }
      )
    ).rejects.toThrow('test lock acquisition fault');
    spy.mockRestore();
    expect(called).toBe(false);
    expect(
      await withFileLock(path, async () => 'recovered', {
        preventLiveOwnerTakeover: true,
        acquireTimeoutMs: 100,
      })
    ).toBe('recovered');
  });

  it('does not delete a replacement inode while cleaning a failed publication', async () => {
    const replacement = `${process.pid}\n${Date.now()}\nstrict:replacement\n`;
    const link = fs.linkSync;
    vi.spyOn(fs, 'linkSync').mockImplementationOnce((existing, newPath) => {
      link(existing, newPath);
      fs.unlinkSync(newPath);
      fs.appendFileSync(newPath, replacement);
      throw new Error('test publish fault');
    });
    await expect(
      withFileLock(path, async () => 'not reached', {
        preventLiveOwnerTakeover: true,
      })
    ).rejects.toThrow('test publish fault');
    expect(await readFile(`${path}.lock`, 'utf8')).toBe(replacement);
  });

  it('reclaims a dead strict owner and does not unlink a replacement token on release', async () => {
    await writeFile(`${path}.lock`, '999999999\n0\nstrict:dead-owner\n');
    const replacement = `${process.pid}\n${Date.now()}\nstrict:replacement\n`;
    await withFileLock(
      path,
      async () => {
        expect(await readFile(`${path}.lock`, 'utf8')).not.toContain('dead-owner');
        await writeFile(`${path}.lock`, replacement);
      },
      { preventLiveOwnerTakeover: true }
    );
    expect(await readFile(`${path}.lock`, 'utf8')).toBe(replacement);
  });
});
