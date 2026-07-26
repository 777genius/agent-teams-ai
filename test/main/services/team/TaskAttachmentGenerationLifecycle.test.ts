import { promises as fs } from 'node:fs';
import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import {
  detachTaskAttachmentGeneration,
  finalizeDetachedTaskAttachmentGeneration,
  pinTaskAttachmentGeneration,
  removeTaskAttachmentGenerationPin,
  restoreDetachedTaskAttachmentGeneration,
} from '../../../../src/main/services/team/TaskAttachmentGenerationLifecycle';

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
        ino: oldIdentity.ino,
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

    const pinned = await pinTaskAttachmentGeneration(publicPath, {
      dev: identity.dev,
      ino: identity.ino,
    });
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

  it('rejects a changed public generation without removing it', async () => {
    const { publicPath } = await createRoot();
    await writeFile(publicPath, 'old');
    const oldIdentity = await fs.lstat(publicPath);
    await fs.unlink(publicPath);
    await writeFile(publicPath, 'replacement');

    await expect(
      pinTaskAttachmentGeneration(publicPath, {
        dev: oldIdentity.dev,
        ino: oldIdentity.ino,
      })
    ).resolves.toEqual({ kind: 'changed' });

    await expect(fs.readFile(publicPath, 'utf8')).resolves.toBe('replacement');
  });

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
