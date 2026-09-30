import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { withFileLock, withFileLockSync } from '@main/services/team/fileLock';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { withFileLockSync: withControllerFileLockSync } = createRequire(import.meta.url)(
  '../../../../agent-teams-controller/src/internal/fileLock.js'
) as { withFileLockSync: typeof withFileLockSync };

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
        expect(await readFile(`${path}.lock`, 'utf8')).toMatch(
          /^[1-9][0-9]*\n[0-9]+\nstrict-[0-9a-f-]{36}\n(?:pidns:[0-9]+\n)?$/
        );
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

  it('lets the controller reclaim a dead desktop strict transition gate', async () => {
    const gate = `${path}.lock-transition-v2`;
    const token = 'strict-00000000-0000-4000-8000-000000000001';
    const entry = `owner-999999999-${token}`;
    await mkdir(gate);
    await writeFile(join(gate, entry), `file-lock-transition-v2\n999999999\n${token}\n`);
    expect(
      withControllerFileLockSync(path, () => 'ok', { acquireTimeoutMs: 200, retryIntervalMs: 5 })
    ).toBe('ok');
  });

  it('recovers a dead strict transition gate so later acquisition can proceed', async () => {
    const gate = `${path}.lock-transition-v2`;
    const token = 'strict-00000000-0000-4000-8000-000000000001';
    const entry = `owner-999999999-${token}`;
    await mkdir(gate);
    await writeFile(join(gate, entry), `file-lock-transition-v2\n999999999\n${token}\n`);
    await expect(
      withFileLock(path, async () => 'ok', {
        preventLiveOwnerTakeover: true,
        acquireTimeoutMs: 200,
        retryIntervalMs: 5,
      })
    ).resolves.toBe('ok');
  });
});
