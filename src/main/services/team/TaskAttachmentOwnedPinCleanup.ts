import * as fs from 'node:fs';

import {
  getDurableFileIdentity,
  isSameDurableFileIdentity,
  removePathWithIdentityFenceAsync,
} from '@main/utils/atomicWrite';

async function openIdentityHandle(filePath: string): Promise<fs.promises.FileHandle> {
  return fs.promises.open(filePath, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
}

/**
 * Removes only the hardlink created by the current pin attempt. File handles
 * bind the source and pin objects before the shared removal primitive detaches
 * the pin name. App writers only know the shared pin path, so a replacement
 * published there after detachment is never targeted. Guessing the primitive's
 * random private path from another same-UID process is outside the supported
 * cooperative app-concurrency threat model.
 *
 * If either handle reports ino=0, ownership cannot be proven and the standard
 * .review-create guard remains recoverable by normal temp-link reconciliation.
 */
export async function cleanupJustCreatedTaskAttachmentPin(
  originalPath: string,
  pinPath: string
): Promise<boolean> {
  let originalHandle: fs.promises.FileHandle | null = null;
  let pinHandle: fs.promises.FileHandle | null = null;
  try {
    originalHandle = await openIdentityHandle(originalPath);
    pinHandle = await openIdentityHandle(pinPath);
    const originalIdentity = getDurableFileIdentity(await originalHandle.stat());
    const pinIdentity = getDurableFileIdentity(await pinHandle.stat());
    if (!isSameDurableFileIdentity(originalIdentity, pinIdentity)) return false;

    const removal = await removePathWithIdentityFenceAsync(pinPath, {
      force: true,
      durability: 'strict',
      validateDetached: async (detachedPath) => {
        const detachedHandle = await openIdentityHandle(detachedPath);
        try {
          return isSameDurableFileIdentity(
            pinIdentity,
            getDurableFileIdentity(await detachedHandle.stat())
          );
        } finally {
          await detachedHandle.close();
        }
      },
    });
    return removal === 'deleted';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  } finally {
    await pinHandle?.close().catch(() => undefined);
    await originalHandle?.close().catch(() => undefined);
  }
}
