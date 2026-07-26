import { access, rm } from 'node:fs/promises';
import { dirname } from 'node:path';

import { syncDirectoryDurably } from '@main/utils/atomicWrite';

export async function purgeJsonMemberWorkSyncActiveState(
  activeFilePaths: readonly string[],
  lifecycle: {
    establishPendingPrimaryPurge(): Promise<void>;
    isPurgeGenerationCurrent(): Promise<boolean>;
    confirmActiveStateCleared(): Promise<void>;
  }
): Promise<void> {
  await lifecycle.establishPendingPrimaryPurge();

  const directoriesToSync = new Set(activeFilePaths.map((filePath) => dirname(filePath)));
  for (const filePath of activeFilePaths) {
    if (!(await lifecycle.isPurgeGenerationCurrent())) {
      throw new Error('member-work-sync active-state purge generation changed');
    }
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

  if (!(await lifecycle.isPurgeGenerationCurrent())) {
    throw new Error('member-work-sync active-state purge generation changed');
  }
  await lifecycle.confirmActiveStateCleared();
}
