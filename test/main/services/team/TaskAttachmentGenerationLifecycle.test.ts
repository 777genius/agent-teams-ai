import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { chmod, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  detachTaskAttachmentGeneration,
  finalizeDetachedTaskAttachmentGeneration,
  pinTaskAttachmentGeneration,
  removeTaskAttachmentGenerationPin,
  restoreDetachedTaskAttachmentGeneration,
} from '../../../../src/main/services/team/TaskAttachmentGenerationLifecycle';
import {
  cleanupAtomicCreateTempLinks,
  isSameDurableFileIdentity,
} from '../../../../src/main/utils/atomicWrite';

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

  async function publishReplacementBeforePrivateRemoval<T>(
    publicPath: string,
    operation: () => Promise<T>
  ): Promise<T> {
    const realRm = fs.rm.bind(fs);
    let replacementPublished = false;
    const remove = vi.spyOn(fs, 'rm').mockImplementation(async (target, options) => {
      if (!replacementPublished && basename(String(target)).includes('.deleting.')) {
        replacementPublished = true;
        await writeFile(publicPath, 'replacement', 'utf8');
      }
      await realRm(target, options);
    });
    try {
      return await operation();
    } finally {
      remove.mockRestore();
    }
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

  it('fails closed and removes its transaction pin when inode identity is unavailable', async () => {
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
      await expect(pinTaskAttachmentGeneration(publicPath)).resolves.toEqual({ kind: 'changed' });

      await expect(fs.readFile(publicPath, 'utf8')).resolves.toBe('old');
      expect(await readdir(root)).toEqual(['attachment']);
    } finally {
      lstat.mockRestore();
    }
  });

  it('leaves a recoverable guard when file handles also report zero inode identity', async () => {
    const { root, publicPath } = await createRoot();
    await writeFile(publicPath, 'old');
    const realLstat = fs.lstat.bind(fs);
    const realOpen = fs.open.bind(fs);
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async (filePath) => {
      const stats = await realLstat(filePath);
      return new Proxy(stats, {
        get(target, property) {
          return property === 'ino' ? 0 : Reflect.get(target, property, target);
        },
      });
    });
    const open = vi.spyOn(fs, 'open').mockImplementation(async (...args) => {
      const handle = await realOpen(...args);
      return {
        close: () => handle.close(),
        stat: async () => {
          const stats = await handle.stat();
          return new Proxy(stats, {
            get(target, property) {
              return property === 'ino' ? 0 : Reflect.get(target, property, target);
            },
          });
        },
      } as Awaited<ReturnType<typeof fs.open>>;
    });

    try {
      await expect(pinTaskAttachmentGeneration(publicPath)).resolves.toEqual({ kind: 'changed' });
    } finally {
      open.mockRestore();
      lstat.mockRestore();
    }

    await expect(fs.readFile(publicPath, 'utf8')).resolves.toBe('old');
    expect(
      (await readdir(root)).filter((entry) => entry.startsWith('.review-create.'))
    ).toHaveLength(1);
  });

  it('preserves a replacement swapped in after its cleanup capability was acquired', async () => {
    const { root, publicPath } = await createRoot();
    await writeFile(publicPath, 'old');
    const realLstat = fs.lstat.bind(fs);
    const realRename = fs.rename.bind(fs);
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async (filePath) => {
      const stats = await realLstat(filePath);
      return new Proxy(stats, {
        get(target, property) {
          return property === 'ino' ? 0 : Reflect.get(target, property, target);
        },
      });
    });
    let replacementPinPath = '';
    const rename = vi.spyOn(fs, 'rename').mockImplementation(async (source, target) => {
      if (basename(String(source)).startsWith('.review-create.')) {
        replacementPinPath = String(source);
        await fs.unlink(replacementPinPath);
        await writeFile(replacementPinPath, 'foreign replacement', 'utf8');
      }
      await realRename(source, target);
    });

    try {
      await expect(pinTaskAttachmentGeneration(publicPath)).resolves.toEqual({ kind: 'changed' });
    } finally {
      rename.mockRestore();
      lstat.mockRestore();
    }

    await expect(fs.readFile(publicPath, 'utf8')).resolves.toBe('old');
    await expect(fs.readFile(replacementPinPath, 'utf8')).resolves.toBe('foreign replacement');
    expect((await readdir(root)).sort()).toEqual(
      ['attachment', basename(replacementPinPath)].sort()
    );
  });

  it('requires every durable file identity field to match', () => {
    const identity = { dev: 1, ino: 2, birthtimeMs: 3, size: 4 };

    expect(isSameDurableFileIdentity(identity, { ...identity, birthtimeMs: 5 })).toBe(false);
    expect(isSameDurableFileIdentity(identity, { ...identity, size: 5 })).toBe(false);
    expect(isSameDurableFileIdentity(identity, { ...identity })).toBe(true);
  });

  it('does not detach a zero-inode replacement with a colliding fallback identity', async () => {
    const { root, publicPath } = await createRoot();
    await writeFile(publicPath, 'old');
    const old = await fs.lstat(publicPath);
    await fs.unlink(publicPath);
    await writeFile(publicPath, 'new');
    const realLstat = fs.lstat.bind(fs);
    const lstat = vi.spyOn(fs, 'lstat').mockImplementation(async (filePath) => {
      const stats = await realLstat(filePath);
      return new Proxy(stats, {
        get(target, property) {
          if (property === 'ino') return 0;
          if (property === 'birthtimeMs') return old.birthtimeMs;
          return Reflect.get(target, property, target);
        },
      });
    });

    try {
      await expect(
        detachTaskAttachmentGeneration(publicPath, {
          dev: old.dev,
          ino: 0,
          birthtimeMs: old.birthtimeMs,
          size: old.size,
        })
      ).resolves.toEqual({ kind: 'changed' });

      await expect(fs.readFile(publicPath, 'utf8')).resolves.toBe('new');
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

      await expect(fs.readFile(ownGuard, 'utf8')).resolves.toBe('old');
      await expect(fs.readFile(otherGuard, 'utf8')).resolves.toBe('different-size');
      expect((await readdir(root)).sort()).toEqual(
        ['attachment', 'other-attachment', basename(ownGuard), otherGuardName].sort()
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

  it('does not remove a replacement published while a detached receipt is finalized', async () => {
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

    await publishReplacementBeforePrivateRemoval(detached.receipt.detachedPath, () =>
      finalizeDetachedTaskAttachmentGeneration(detached.receipt)
    );

    await expect(fs.readFile(detached.receipt.detachedPath, 'utf8')).resolves.toBe('replacement');
  });

  it('does not remove a replacement published while a generation pin is finalized', async () => {
    const { publicPath } = await createRoot();
    await writeFile(publicPath, 'old');
    const pinned = await pinTaskAttachmentGeneration(publicPath);
    if (pinned.kind !== 'pinned') throw new Error('Expected pinned generation');

    await publishReplacementBeforePrivateRemoval(pinned.receipt.pinPath, () =>
      removeTaskAttachmentGenerationPin(pinned.receipt.pinPath, pinned.receipt.identity)
    );

    await expect(fs.readFile(publicPath, 'utf8')).resolves.toBe('old');
    await expect(fs.readFile(pinned.receipt.pinPath, 'utf8')).resolves.toBe('replacement');
  });

  it('does not remove a replacement published while a restored receipt is cleaned up', async () => {
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

    await expect(
      publishReplacementBeforePrivateRemoval(detached.receipt.detachedPath, () =>
        restoreDetachedTaskAttachmentGeneration(detached.receipt)
      )
    ).resolves.toBe('restored');

    await expect(fs.readFile(publicPath, 'utf8')).resolves.toBe('old');
    await expect(fs.readFile(detached.receipt.detachedPath, 'utf8')).resolves.toBe('replacement');
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
