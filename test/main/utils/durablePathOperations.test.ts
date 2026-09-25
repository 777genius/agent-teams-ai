/**
 * Transient-rename behaviour of the identity fence.
 *
 * The fence renames a directory tree aside before removing it, and renames it
 * On Windows the detach rename can be refused with EPERM/EACCES/EBUSY while
 * another process holds a handle. The retry is bounded.
 */

import {
  getDurablePathIdentity,
  removePathWithIdentityFenceAsync,
} from '@main/utils/durablePathOperations';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

  it('recovers a proof-backed detached object when a successful rename reports ENOENT', async () => {
    const detachedPath = path.join(root, '.team-alpha.deleting.transaction');
    const originalIdentity = getDurablePathIdentity(fs.lstatSync(target));
    const events: string[] = [];
    const rename = vi
      .spyOn(fs.promises, 'rename')
      .mockImplementation(async (from: fs.PathLike, to: fs.PathLike) => {
        await realRename(from, to);
        fs.mkdirSync(target);
        fs.writeFileSync(path.join(target, 'replacement.json'), '{"replacement":true}');
        throw errnoError('ENOENT');
      });

    await expect(
      removePathWithIdentityFenceAsync(target, {
        recursive: true,
        force: true,
        durability: 'strict',
        validateDetached: async (candidatePath, identity) => {
          events.push('validated');
          expect(candidatePath).toBe(detachedPath);
          expect(identity).toEqual(originalIdentity);
          return true;
        },
        proofHooks: {
          detachedPath,
          onDetachedValidated: async () => {
            events.push('detached-proof');
            expect(fs.existsSync(detachedPath)).toBe(true);
          },
          onRemovalDurable: async () => {
            events.push('removal-proof');
            expect(fs.existsSync(detachedPath)).toBe(false);
          },
        },
      })
    ).resolves.toBe('deleted');

    expect(rename).toHaveBeenCalledTimes(1);
    expect(events).toEqual(['validated', 'detached-proof', 'removal-proof']);
    expect(fs.readFileSync(path.join(target, 'replacement.json'), 'utf8')).toBe(
      '{"replacement":true}'
    );
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

  it('retains a rejected directory in quarantine without an unsafe rollback', async () => {
    const rename = vi.spyOn(fs.promises, 'rename');

    await expect(
      removePathWithIdentityFenceAsync(target, {
        recursive: true,
        force: true,
        validateDetached: async () => false,
      })
    ).resolves.toBe('changed');

    expect(rename).toHaveBeenCalledTimes(1);
    expect(fs.existsSync(target)).toBe(false);
    const [detached] = fs.readdirSync(root);
    expect(detached).toMatch(/^\.team-alpha\.deleting\./);
    expect(fs.existsSync(path.join(root, detached, 'config.json'))).toBe(true);
  });
});
