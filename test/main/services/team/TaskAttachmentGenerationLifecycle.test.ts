import { execFile } from 'node:child_process';
import { promises as fs } from 'node:fs';
import { chmod, mkdtemp, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { afterEach, describe, expect, it } from 'vitest';

import {
  detachTaskAttachmentGeneration,
  finalizeDetachedTaskAttachmentGeneration,
  pinTaskAttachmentGeneration,
  removeTaskAttachmentGenerationPin,
  restoreDetachedTaskAttachmentGeneration,
} from '../../../../src/main/services/team/TaskAttachmentGenerationLifecycle';

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
      })
    ).resolves.toEqual({ kind: 'changed' });

    await expect(fs.readFile(publicPath, 'utf8')).resolves.toBe('replacement');
    expect(
      (await readdir(root)).filter((entry) => entry.startsWith('.attachment-delete.'))
    ).toEqual([]);
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
    });
    if (detached.kind !== 'detached') throw new Error('Expected detached generation');

    await expect(restoreDetachedTaskAttachmentGeneration(detached.receipt)).resolves.toBe(
      'restored'
    );
    await expect(fs.readFile(publicPath, 'utf8')).resolves.toBe('old');
    await expect(fs.lstat(detached.receipt.detachedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
