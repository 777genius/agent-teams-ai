/**
 * Transient-rename behaviour of the identity fence.
 *
 * The fence renames a directory tree aside before removing it, and renames it
 * back when validation rejects the detached tree. On Windows both renames can
 * be refused with EPERM/EACCES/EBUSY while some other process still holds a
 * handle inside the tree, which is why they retry - but the retry is bounded,
 * and every other error still reaches the caller on the first attempt.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { removePathWithIdentityFenceAsync } from '@main/utils/durablePathOperations';

const realRename = fs.promises.rename;

function errnoError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`${code}: rename failed`), { code });
}

describe('removePathWithIdentityFenceAsync transient rename retry', () => {
  let root: string;
  let target: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'durable-path-ops-'));
    target = path.join(root, 'team-alpha');
    fs.mkdirSync(path.join(target, 'inboxes'), { recursive: true });
    fs.writeFileSync(path.join(target, 'config.json'), '{}');
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('retries a transient detach rename exactly six times and rethrows the original error', async () => {
    const failure = errnoError('EPERM');
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValue(failure);
    vi.useFakeTimers();
    const startedAt = Date.now();

    const removal = removePathWithIdentityFenceAsync(target, { recursive: true, force: true });
    const rejection = expect(removal).rejects.toBe(failure);
    await vi.runAllTimersAsync();
    await rejection;

    expect(rename).toHaveBeenCalledTimes(6);
    // Five backoffs of 150, 300, 450, 600 and 750 ms: the whole retry window is
    // bounded at 2.25 s, so a permanently held handle reports an error instead
    // of parking the delete forever.
    expect(Date.now() - startedAt).toBe(2_250);
    expect(fs.existsSync(target)).toBe(true);
  });

  it('rethrows a non-transient rename failure on the first attempt without sleeping', async () => {
    const failure = errnoError('ENOTEMPTY');
    const rename = vi.spyOn(fs.promises, 'rename').mockRejectedValue(failure);
    vi.useFakeTimers();
    const startedAt = Date.now();

    await expect(
      removePathWithIdentityFenceAsync(target, { recursive: true, force: true })
    ).rejects.toBe(failure);

    expect(rename).toHaveBeenCalledTimes(1);
    expect(Date.now() - startedAt).toBe(0);
  });

  it('still reports a missing path instead of retrying its ENOENT', async () => {
    const rename = vi.spyOn(fs.promises, 'rename');

    await expect(
      removePathWithIdentityFenceAsync(path.join(root, 'absent'), {
        recursive: true,
        force: true,
      })
    ).resolves.toBe('missing');

    expect(rename).toHaveBeenCalledTimes(1);
  });

  it('completes the removal once a transient detach rename clears', async () => {
    let attempts = 0;
    const rename = vi
      .spyOn(fs.promises, 'rename')
      .mockImplementation(async (from: fs.PathLike, to: fs.PathLike) => {
        attempts += 1;
        if (attempts <= 2) throw errnoError('EACCES');
        await realRename(from, to);
      });

    await expect(
      removePathWithIdentityFenceAsync(target, { recursive: true, force: true })
    ).resolves.toBe('deleted');

    expect(rename).toHaveBeenCalledTimes(3);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('retries the rollback rename that puts a rejected tree back', async () => {
    let attempts = 0;
    const rename = vi
      .spyOn(fs.promises, 'rename')
      .mockImplementation(async (from: fs.PathLike, to: fs.PathLike) => {
        attempts += 1;
        // Attempt 1 detaches; attempt 2 is the rollback and is refused once.
        if (attempts === 2) throw errnoError('EBUSY');
        await realRename(from, to);
      });

    await expect(
      removePathWithIdentityFenceAsync(target, {
        recursive: true,
        force: true,
        validateDetached: async () => false,
      })
    ).resolves.toBe('changed');

    expect(rename).toHaveBeenCalledTimes(3);
    expect(fs.existsSync(path.join(target, 'config.json'))).toBe(true);
    expect(fs.readdirSync(root)).toEqual(['team-alpha']);
  });
});
