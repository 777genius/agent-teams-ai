import { access, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { syncDirectoryDurably } from '@main/utils/atomicWrite';

export async function purgeJsonMemberWorkSyncActiveState(
  activeFilePaths: readonly string[],
  lifecycle: {
    establishPendingPrimaryPurge(): Promise<void>;
    confirmActiveStateCleared(): Promise<void>;
  }
): Promise<void> {
  await lifecycle.establishPendingPrimaryPurge();

  const directoriesToSync = new Set(activeFilePaths.map((filePath) => dirname(filePath)));
  for (const filePath of activeFilePaths) {
    try {
      await access(filePath);
      await rm(filePath, { force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }
  for (const directory of directoriesToSync) {
    try {
      await syncDirectoryDurably(directory);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        throw error;
      }
    }
  }

  await lifecycle.confirmActiveStateCleared();
}
