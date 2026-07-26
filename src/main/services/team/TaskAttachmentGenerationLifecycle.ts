import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface TaskAttachmentFileIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface DetachedTaskAttachmentGeneration {
  readonly originalPath: string;
  readonly detachedPath: string;
  readonly identity: TaskAttachmentFileIdentity;
}

export interface PinnedTaskAttachmentGeneration {
  readonly originalPath: string;
  readonly pinPath: string;
  readonly identity: TaskAttachmentFileIdentity;
}

export type DetachTaskAttachmentGenerationResult =
  | { readonly kind: 'detached'; readonly receipt: DetachedTaskAttachmentGeneration }
  | { readonly kind: 'missing' }
  | { readonly kind: 'changed' };

export type PinTaskAttachmentGenerationResult =
  | { readonly kind: 'pinned'; readonly receipt: PinnedTaskAttachmentGeneration }
  | { readonly kind: 'missing' }
  | { readonly kind: 'changed' };

function isSameIdentity(
  left: Pick<fs.Stats, 'dev' | 'ino'>,
  right: TaskAttachmentFileIdentity
): boolean {
  return left.dev === right.dev && left.ino !== 0 && left.ino === right.ino;
}

async function lstatOrNull(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

/**
 * Keeps an exact inode alive without removing its public pathname. The pin is
 * created before metadata mutation so a process crash cannot break a still-live
 * metadata reference.
 */
export async function pinTaskAttachmentGeneration(
  originalPath: string
): Promise<PinTaskAttachmentGenerationResult> {
  const pinPath = path.join(path.dirname(originalPath), `.review-create.${randomUUID()}.tmp`);
  let source: fs.promises.FileHandle;
  try {
    source = await fs.promises.open(originalPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    throw error;
  }

  try {
    const opened = await source.stat();
    if (!opened.isFile()) return { kind: 'changed' };
    const identity = { dev: opened.dev, ino: opened.ino };
    try {
      await fs.promises.link(originalPath, pinPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
      throw error;
    }

    const pinned = await fs.promises.lstat(pinPath);
    if (pinned.isFile() && !pinned.isSymbolicLink() && isSameIdentity(pinned, identity)) {
      return {
        kind: 'pinned',
        receipt: { originalPath, pinPath, identity },
      };
    }

    if (pinned.isFile() && !pinned.isSymbolicLink()) {
      await removeTaskAttachmentGenerationPin(pinPath, { dev: pinned.dev, ino: pinned.ino });
    }
    return { kind: 'changed' };
  } finally {
    await source.close();
  }
}

/**
 * Atomically removes the public pathname, then proves which inode was detached.
 * If another process replaced the public path first, its generation is restored
 * without clobbering any newer winner and is never deleted by the stale operation.
 */
export async function detachTaskAttachmentGeneration(
  originalPath: string,
  expectedIdentity: TaskAttachmentFileIdentity
): Promise<DetachTaskAttachmentGenerationResult> {
  const detachedPath = path.join(
    path.dirname(originalPath),
    `.attachment-delete.${randomUUID()}.staged`
  );
  try {
    await fs.promises.rename(originalPath, detachedPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return { kind: 'missing' };
    throw error;
  }

  const detached = await fs.promises.lstat(detachedPath);
  if (
    detached.isFile() &&
    !detached.isSymbolicLink() &&
    isSameIdentity(detached, expectedIdentity)
  ) {
    return {
      kind: 'detached',
      receipt: { originalPath, detachedPath, identity: expectedIdentity },
    };
  }

  const movedUnexpectedGeneration: DetachedTaskAttachmentGeneration = {
    originalPath,
    detachedPath,
    identity: { dev: detached.dev, ino: detached.ino },
  };
  const restored = await restoreDetachedTaskAttachmentGeneration(movedUnexpectedGeneration);
  if (restored === 'conflict') {
    throw new Error('Task attachment changed while detaching; preserved conflicting generation');
  }
  return { kind: 'changed' };
}

export async function restoreDetachedTaskAttachmentGeneration(
  receipt: DetachedTaskAttachmentGeneration
): Promise<'restored' | 'already-restored' | 'missing' | 'conflict'> {
  const detached = await lstatOrNull(receipt.detachedPath);
  if (!detached) {
    const current = await lstatOrNull(receipt.originalPath);
    return current && isSameIdentity(current, receipt.identity) ? 'already-restored' : 'missing';
  }
  if (
    !detached.isFile() ||
    detached.isSymbolicLink() ||
    !isSameIdentity(detached, receipt.identity)
  ) {
    return 'conflict';
  }

  try {
    await fs.promises.link(receipt.detachedPath, receipt.originalPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;
    const current = await lstatOrNull(receipt.originalPath);
    if (!current || !isSameIdentity(current, receipt.identity)) return 'conflict';
  }
  await fs.promises.unlink(receipt.detachedPath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error;
  });
  return 'restored';
}

/** Removes only the detached transaction artifact, never a public pathname. */
export async function finalizeDetachedTaskAttachmentGeneration(
  receipt: DetachedTaskAttachmentGeneration
): Promise<void> {
  const detached = await lstatOrNull(receipt.detachedPath);
  if (!detached) return;
  if (
    !detached.isFile() ||
    detached.isSymbolicLink() ||
    !isSameIdentity(detached, receipt.identity)
  ) {
    throw new Error('Detached task attachment generation changed; refusing to remove it');
  }
  await fs.promises.unlink(receipt.detachedPath);
}

/** Removes a transaction-owned pin only while it still names the expected inode. */
export async function removeTaskAttachmentGenerationPin(
  pinPath: string,
  expectedIdentity: TaskAttachmentFileIdentity
): Promise<void> {
  const pin = await lstatOrNull(pinPath);
  if (!pin) return;
  if (!pin.isFile() || pin.isSymbolicLink() || !isSameIdentity(pin, expectedIdentity)) {
    throw new Error('Task attachment generation pin changed; refusing to remove it');
  }
  await fs.promises.unlink(pinPath);
}
