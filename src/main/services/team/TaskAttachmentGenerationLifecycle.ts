import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  type DurableFileIdentity,
  getDurableFileIdentity,
  hasTrustworthyDurablePathIdentity,
  isSameDurableFileIdentity,
} from '@main/utils/atomicWrite';

import { isTaskAttachmentGenerationGuardName } from './TaskAttachmentArtifacts';

export type TaskAttachmentFileIdentity = DurableFileIdentity;

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

export function getTaskAttachmentFileIdentity(
  stats: Pick<fs.Stats, 'dev' | 'ino' | 'birthtimeMs' | 'size'>
): TaskAttachmentFileIdentity {
  return getDurableFileIdentity(stats);
}

export function isSameTaskAttachmentFileIdentity(
  left: Pick<fs.Stats, 'dev' | 'ino' | 'birthtimeMs' | 'size'>,
  right: TaskAttachmentFileIdentity
): boolean {
  const leftIdentity = getTaskAttachmentFileIdentity(left);
  return isSameDurableFileIdentity(leftIdentity, right);
}

export function hasTrustworthyTaskAttachmentFileIdentity(
  identity: TaskAttachmentFileIdentity
): boolean {
  return hasTrustworthyDurablePathIdentity(identity);
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
  try {
    await fs.promises.link(originalPath, pinPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return { kind: 'missing' };
    throw error;
  }

  const pinned = await fs.promises.lstat(pinPath);

  const identity = getTaskAttachmentFileIdentity(pinned);
  if (!pinned.isFile() || pinned.isSymbolicLink()) {
    await removePinnedTaskAttachmentPath(pinPath, identity);
    return { kind: 'changed' };
  }
  if (!hasTrustworthyTaskAttachmentFileIdentity(identity)) {
    return { kind: 'changed' };
  }

  let publicGeneration: fs.Stats | null;
  try {
    publicGeneration = await lstatOrNull(originalPath);
  } catch (error) {
    await removePinnedTaskAttachmentPath(pinPath, identity);
    throw error;
  }
  if (
    !publicGeneration ||
    !publicGeneration.isFile() ||
    publicGeneration.isSymbolicLink() ||
    !isSameTaskAttachmentFileIdentity(publicGeneration, identity)
  ) {
    await removePinnedTaskAttachmentPath(pinPath, identity);
    return publicGeneration ? { kind: 'changed' } : { kind: 'missing' };
  }

  return {
    kind: 'pinned',
    receipt: { originalPath, pinPath, identity },
  };
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
  if (!hasTrustworthyTaskAttachmentFileIdentity(expectedIdentity)) {
    return { kind: 'changed' };
  }
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
    isSameTaskAttachmentFileIdentity(detached, expectedIdentity)
  ) {
    return {
      kind: 'detached',
      receipt: { originalPath, detachedPath, identity: expectedIdentity },
    };
  }

  const movedUnexpectedGeneration: DetachedTaskAttachmentGeneration = {
    originalPath,
    detachedPath,
    identity: getTaskAttachmentFileIdentity(detached),
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
    return current && isSameTaskAttachmentFileIdentity(current, receipt.identity)
      ? 'already-restored'
      : 'missing';
  }
  if (
    !detached.isFile() ||
    detached.isSymbolicLink() ||
    !isSameTaskAttachmentFileIdentity(detached, receipt.identity)
  ) {
    return 'conflict';
  }

  try {
    await fs.promises.link(receipt.detachedPath, receipt.originalPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;
    const current = await lstatOrNull(receipt.originalPath);
    if (!current || !isSameTaskAttachmentFileIdentity(current, receipt.identity)) return 'conflict';
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
    !isSameTaskAttachmentFileIdentity(detached, receipt.identity)
  ) {
    throw new Error('Detached task attachment generation changed; refusing to remove it');
  }
  await fs.promises.unlink(receipt.detachedPath);
}

async function removePinnedTaskAttachmentPath(
  pinPath: string,
  expectedIdentity: TaskAttachmentFileIdentity
): Promise<void> {
  if (!isTaskAttachmentGenerationGuardName(path.basename(pinPath))) {
    throw new Error('Invalid task attachment generation pin');
  }
  if (!hasTrustworthyTaskAttachmentFileIdentity(expectedIdentity)) {
    throw new Error('Task attachment generation pin identity is not trustworthy');
  }
  const pin = await lstatOrNull(pinPath);
  if (!pin) return;
  if (
    !pin.isFile() ||
    pin.isSymbolicLink() ||
    !isSameTaskAttachmentFileIdentity(pin, expectedIdentity)
  ) {
    throw new Error('Task attachment generation pin changed; refusing to remove it');
  }
  await fs.promises.unlink(pinPath);
}

export async function removeTaskAttachmentGenerationPin(
  pinPath: string,
  expectedIdentity: TaskAttachmentFileIdentity
): Promise<void> {
  await removePinnedTaskAttachmentPath(pinPath, expectedIdentity);
}
