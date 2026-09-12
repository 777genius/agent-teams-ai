import { access, readdir, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { syncDirectoryDurably } from '@main/utils/atomicWrite';

import type { MemberWorkSyncStorePaths } from './MemberWorkSyncStorePaths';

const MEMBER_WORK_SYNC_FILE_NAMES = [
  'status.json',
  'reports.json',
  'outbox.json',
  'journal.jsonl',
] as const;

export function createAlwaysCurrentJsonMemberWorkSyncPurgeLifecycle(): {
  establishPendingPrimaryPurge(): Promise<void>;
  isPurgeGenerationCurrent(): Promise<boolean>;
  confirmActiveStateCleared(): Promise<void>;
} {
  return {
    establishPendingPrimaryPurge: async () => undefined,
    isPurgeGenerationCurrent: async () => true,
    confirmActiveStateCleared: async () => undefined,
  };
}

export async function listJsonMemberWorkSyncActiveFilePaths(
  paths: MemberWorkSyncStorePaths,
  teamName: string
): Promise<string[]> {
  // The SQLite compatibility replica is replaced by writeClean, not deleted
  // here. Removing it before the empty publication would leave ENOENT if
  // purge crashes in that window and would resurrect or drop crash evidence.
  const files = [
    paths.getLegacyStatusPath(teamName),
    paths.getLegacyPendingReportsPath(teamName),
    paths.getLegacyOutboxPath(teamName),
    paths.getMetricsIndexPath(teamName),
    paths.getOutboxIndexPath(teamName),
    paths.getPendingReportsIndexPath(teamName),
    paths.getReportTokenSecretPath(teamName),
  ];
  const membersDir = join(paths.getTeamRootDir(teamName), 'members');
  const entries = await readdir(membersDir, { withFileTypes: true }).catch(() => []);
  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }
    const workSyncDir = join(membersDir, entry.name, '.member-work-sync');
    for (const fileName of MEMBER_WORK_SYNC_FILE_NAMES) {
      files.push(join(workSyncDir, fileName));
    }
  }
  return files;
}

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
