import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { chmod, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  detachTaskAttachmentGeneration,
  finalizeDetachedTaskAttachmentGeneration,
  pinTaskAttachmentGeneration,
  removeTaskAttachmentGenerationPin,
  restoreDetachedTaskAttachmentGeneration,
} from '../../../../src/main/services/team/TaskAttachmentGenerationLifecycle';
import { cleanupAtomicCreateTempLinks } from '../../../../src/main/utils/atomicWrite';

const execFileAsync = promisify(execFile);

describe('TaskAttachmentGenerationLifecycle', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function createRoot(): Promise<{ root: string; publicPath: string }> {
    const root = await mkdtemp(join(tmpdir(), 'attachment-generation-'));
    roots.push(root);
    return { root, publicPath: join(root, 'attachment') };
  }

  it('restores a replacement generation instead of deleting it after an identity mismatch', async () => {
    const { root, publicPath } = await createRoot();
    await writeFile(publicPath, 'old');
    const oldIdentity = await fs.lstat(publicPath);
    await fs.unlink(publicPath);
    await writeFile(publicPath, 'replacement');

    await expect(
      detachTaskAttachmentGeneration(publicPath, {
        dev: oldIdentity.dev,
        ino: 0,
        birthtimeMs: oldIdentity.birthtimeMs,
        size: oldIdentity.size,
      })
    ).resolves.toEqual({ kind: 'changed' });

    await expect(fs.readFile(publicPath, 'utf8')).resolves.toBe('replacement');
    expect(
      (await readdir(root)).filter((entry) => entry.startsWith('.attachment-delete.'))
    ).toEqual([]);
  });

  it('uses birthtime and size when a filesystem reports zero inode identities', async () => {
    const { root, publicPath } = await createRoot();
    await writeFile(publicPath, 'old');
    const realLstat = fs.lstat.bind(fs);
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async (filePath) => {
      const stats = await realLstat(filePath);
      return new Proxy(stats, {
        get(target, property) {
          return property === 'ino' ? 0 : Reflect.get(target, property, target);
        },
      });
    });

    try {
      const pinned = await pinTaskAttachmentGeneration(publicPath);
      if (pinned.kind !== 'pinned') throw new Error('Expected zero-inode generation to be pinned');
      expect(pinned.receipt.identity).toMatchObject({ ino: 0, size: 3 });

      await removeTaskAttachmentGenerationPin(pinned.receipt.pinPath, pinned.receipt.identity);

      await expect(fs.readFile(publicPath, 'utf8')).resolves.toBe('old');
      expect(await readdir(root)).toEqual(['attachment']);
    } finally {
      lstat.mockRestore();
    }
  });

  it('preserves a zero-inode replacement with a different durable fallback identity', async () => {
    const { root, publicPath } = await createRoot();
    await writeFile(publicPath, 'old');
    const realLstat = fs.lstat.bind(fs);
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async (filePath) => {
      const stats = await realLstat(filePath);
      return new Proxy(stats, {
        get(target, property) {
          return property === 'ino' ? 0 : Reflect.get(target, property, target);
        },
      });
    });

    try {
      const pinned = await pinTaskAttachmentGeneration(publicPath);
      if (pinned.kind !== 'pinned') throw new Error('Expected zero-inode generation to be pinned');
      await fs.unlink(publicPath);
      await writeFile(publicPath, 'replacement');

      await expect(
        detachTaskAttachmentGeneration(publicPath, pinned.receipt.identity)
      ).resolves.toEqual({ kind: 'changed' });
      await removeTaskAttachmentGenerationPin(pinned.receipt.pinPath, pinned.receipt.identity);

      await expect(fs.readFile(publicPath, 'utf8')).resolves.toBe('replacement');
      expect(await readdir(root)).toEqual(['attachment']);
    } finally {
      lstat.mockRestore();
    }
  });

  it('never removes another zero-inode generation guard during temp-link cleanup', async () => {
    const { root, publicPath } = await createRoot();
    const ownGuard = join(root, '.review-create.aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee.tmp');
    const otherPath = join(root, 'other-attachment');
    const otherGuardName = '.review-create.11111111-2222-4333-8444-555555555555.tmp';
    const otherGuard = join(root, otherGuardName);
    await writeFile(publicPath, 'old');
    await fs.link(publicPath, ownGuard);
    await writeFile(otherPath, 'different-size');
    await fs.link(otherPath, otherGuard);
    const realLstat = fs.lstat.bind(fs);
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async (filePath) => {
      const stats = await realLstat(filePath);
      return new Proxy(stats, {
        get(target, property) {
          return property === 'ino' ? 0 : Reflect.get(target, property, target);
        },
      });
    });

    try {
      await cleanupAtomicCreateTempLinks(publicPath);

      await expect(fs.lstat(ownGuard)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.readFile(otherGuard, 'utf8')).resolves.toBe('different-size');
      expect((await readdir(root)).sort()).toEqual(
        ['attachment', 'other-attachment', otherGuardName].sort()
      );
    } finally {
      lstat.mockRestore();
    }
  });

  it('pins an exact generation without removing its public pathname', async () => {
    const { publicPath } = await createRoot();
    await writeFile(publicPath, 'old');
    const identity = await fs.lstat(publicPath);

    const pinned = await pinTaskAttachmentGeneration(publicPath);
    if (pinned.kind !== 'pinned') throw new Error('Expected pinned generation');

    await expect(fs.readFile(publicPath, 'utf8')).resolves.toBe('old');
    const pinIdentity = await fs.lstat(pinned.receipt.pinPath);
    expect({ dev: pinIdentity.dev, ino: pinIdentity.ino }).toEqual({
      dev: identity.dev,
      ino: identity.ino,
    });

    await removeTaskAttachmentGenerationPin(pinned.receipt.pinPath, pinned.receipt.identity);
    await expect(fs.readFile(publicPath, 'utf8')).resolves.toBe('old');
  });

  it.runIf(process.platform !== 'win32')(
    'rejects a FIFO promptly and removes its transaction pin',
    async () => {
      const { root, publicPath } = await createRoot();
      await execFileAsync('/usr/bin/mkfifo', [publicPath], { timeout: 1_000 });

      let unblockWriter = Promise.resolve();
      const unblockTimer = setTimeout(() => {
        unblockWriter = fs.open(publicPath, 'w').then((handle) => handle.close());
      }, 750);
      const startedAt = Date.now();
      let result: Awaited<ReturnType<typeof pinTaskAttachmentGeneration>>;
      try {
        result = await pinTaskAttachmentGeneration(publicPath);
      } finally {
        clearTimeout(unblockTimer);
        await unblockWriter;
      }

      expect(Date.now() - startedAt).toBeLessThan(500);
      expect(result).toEqual({ kind: 'changed' });
      expect((await fs.lstat(publicPath)).isFIFO()).toBe(true);
      expect(await readdir(root)).toEqual(['attachment']);
    }
  );

  it.runIf(process.platform !== 'win32')(
    'pins a non-readable regular file without requiring read permission',
    async () => {
      const { publicPath } = await createRoot();
      await writeFile(publicPath, 'old');
      await chmod(publicPath, 0o000);

      const pinned = await pinTaskAttachmentGeneration(publicPath);
      if (pinned.kind !== 'pinned') throw new Error('Expected pinned generation');

      const publicIdentity = await fs.lstat(publicPath);
      const pinIdentity = await fs.lstat(pinned.receipt.pinPath);
      expect({ dev: pinIdentity.dev, ino: pinIdentity.ino }).toEqual({
        dev: publicIdentity.dev,
        ino: publicIdentity.ino,
      });

      await removeTaskAttachmentGenerationPin(pinned.receipt.pinPath, pinned.receipt.identity);
      await chmod(publicPath, 0o600);
      await expect(fs.readFile(publicPath, 'utf8')).resolves.toBe('old');
    }
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a symlink without leaving a transaction pin',
    async () => {
      const { root, publicPath } = await createRoot();
      const targetPath = join(root, 'target');
      await writeFile(targetPath, 'target');
      await symlink(targetPath, publicPath);

      await expect(pinTaskAttachmentGeneration(publicPath)).resolves.toEqual({ kind: 'changed' });

      expect(await fs.readlink(publicPath)).toBe(targetPath);
      expect((await readdir(root)).sort()).toEqual(['attachment', 'target']);
    }
  );

  it('never clobbers a replacement while rolling back a detached generation', async () => {
    const { root, publicPath } = await createRoot();
    await writeFile(publicPath, 'old');
    const oldIdentity = await fs.lstat(publicPath);
    const detached = await detachTaskAttachmentGeneration(publicPath, {
      dev: oldIdentity.dev,
      ino: oldIdentity.ino,
      birthtimeMs: oldIdentity.birthtimeMs,
      size: oldIdentity.size,
    });
    if (detached.kind !== 'detached') throw new Error('Expected detached generation');
    await writeFile(publicPath, 'replacement');

    await expect(restoreDetachedTaskAttachmentGeneration(detached.receipt)).resolves.toBe(
      'conflict'
    );
    await expect(fs.readFile(publicPath, 'utf8')).resolves.toBe('replacement');
    await expect(fs.readFile(detached.receipt.detachedPath, 'utf8')).resolves.toBe('old');

    await finalizeDetachedTaskAttachmentGeneration(detached.receipt);
    await expect(fs.readFile(publicPath, 'utf8')).resolves.toBe('replacement');
    expect(await readdir(root)).toEqual(['attachment']);
  });

  it('restores the exact detached inode when the public path is still free', async () => {
    const { publicPath } = await createRoot();
    await writeFile(publicPath, 'old');
    const identity = await fs.lstat(publicPath);
    const detached = await detachTaskAttachmentGeneration(publicPath, {
      dev: identity.dev,
      ino: identity.ino,
      birthtimeMs: identity.birthtimeMs,
      size: identity.size,
    });
    if (detached.kind !== 'detached') throw new Error('Expected detached generation');

    await expect(restoreDetachedTaskAttachmentGeneration(detached.receipt)).resolves.toBe(
      'restored'
    );
    await expect(fs.readFile(publicPath, 'utf8')).resolves.toBe('old');
    await expect(fs.lstat(detached.receipt.detachedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
