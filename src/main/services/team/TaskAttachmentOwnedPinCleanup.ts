import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { getDurableFileIdentity, isSameDurableFileIdentity } from '@main/utils/atomicWrite';

function isAlreadyGone(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

async function openIdentityHandle(filePath: string): Promise<fs.promises.FileHandle> {
  return fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
}

async function restoreUnprovenPin(stagedPath: string, pinPath: string): Promise<void> {
  try {
    await fs.promises.link(stagedPath, pinPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    return;
  }
  await fs.promises.unlink(stagedPath);
}

/**
 * Removes only the hardlink created by the current pin attempt. File handles
 * bind the source and pin objects before detachment; the private directory is
 * the capability which prevents a shared-path replacement before unlink.
 */
export async function cleanupJustCreatedTaskAttachmentPin(
  originalPath: string,
  pinPath: string
): Promise<boolean> {
  let originalHandle: fs.promises.FileHandle | null = null;
  let pinHandle: fs.promises.FileHandle | null = null;
  let stagedHandle: fs.promises.FileHandle | null = null;
  const cleanupDirectory = path.join(
    path.dirname(pinPath),
    `.task-attachment-pin-cleanup.${randomUUID()}`
  );
  const stagedPath = path.join(cleanupDirectory, 'owned-pin');
  let cleanupDirectoryCreated = false;
  try {
    originalHandle = await openIdentityHandle(originalPath);
    pinHandle = await openIdentityHandle(pinPath);
    const originalIdentity = getDurableFileIdentity(await originalHandle.stat());
    const pinIdentity = getDurableFileIdentity(await pinHandle.stat());
    if (!isSameDurableFileIdentity(originalIdentity, pinIdentity)) return false;

    await fs.promises.mkdir(cleanupDirectory, { mode: 0o700 });
    cleanupDirectoryCreated = true;
    await fs.promises.rename(pinPath, stagedPath);
    stagedHandle = await openIdentityHandle(stagedPath);
    const stagedIdentity = getDurableFileIdentity(await stagedHandle.stat());
    if (!isSameDurableFileIdentity(pinIdentity, stagedIdentity)) {
      await restoreUnprovenPin(stagedPath, pinPath);
      return false;
    }

    await fs.promises.unlink(stagedPath);
    return true;
  } catch (error) {
    if (isAlreadyGone(error)) return false;
    throw error;
  } finally {
    await stagedHandle?.close().catch(() => undefined);
    await pinHandle?.close().catch(() => undefined);
    await originalHandle?.close().catch(() => undefined);
    if (cleanupDirectoryCreated) {
      await fs.promises.rmdir(cleanupDirectory).catch(() => undefined);
    }
  }
}
