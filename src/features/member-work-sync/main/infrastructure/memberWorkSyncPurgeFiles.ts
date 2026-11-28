import { lstat, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import {
  atomicWriteAsync,
  type DurablePathIdentity,
  getDurablePathIdentity,
  syncDirectoryDurably,
} from '@main/utils/atomicWrite';

import type { PendingPrimaryPurgeMarker } from './memberWorkSyncPurgeMarker';

export async function writePendingPrimaryPurgeFile(
  markerPath: string,
  marker: PendingPrimaryPurgeMarker,
  activeJsonStateCleared: boolean
): Promise<void> {
  const teamName = marker.teamName;
  const markerDirectory = dirname(markerPath);
  const firstCreatedDirectory = await mkdir(markerDirectory, { recursive: true });
  if (firstCreatedDirectory) {
    await syncDirectoryDurably(dirname(firstCreatedDirectory));
  }
  await atomicWriteAsync(
    markerPath,
    `${JSON.stringify(
      {
        schemaVersion: marker.schemaVersion,
        teamName,
        deletionIdentityId: marker.deletionIdentityId,
        teamRootIdentity: marker.teamRootIdentity,
        activeJsonStateCleared,
      },
      null,
      2
    )}\n`,
    { durability: 'strict', syncDirectory: true }
  );
}

export async function isPendingPrimaryPurgeGenerationCurrent(
  marker: PendingPrimaryPurgeMarker,
  getTeamRootPath: () => string
): Promise<boolean> {
  if (!marker.recoverySafe) return false;
  const teamRootPath = getTeamRootPath();
  let currentRootIdentity: DurablePathIdentity | null = null;
  try {
    currentRootIdentity = getDurablePathIdentity(await lstat(teamRootPath));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return false;
  }
  if (!currentRootIdentity) return marker.deletionIdentityId !== null;

  if (marker.deletionIdentityId) {
    try {
      const parsed = JSON.parse(
        await readFile(join(teamRootPath, 'config.json'), 'utf8')
      ) as Record<string, unknown>;
      return parsed._backupIdentityId === marker.deletionIdentityId;
    } catch {
      return false;
    }
  }
  return (
    marker.teamRootIdentity !== null &&
    currentRootIdentity.dev === marker.teamRootIdentity.dev &&
    currentRootIdentity.ino === marker.teamRootIdentity.ino &&
    currentRootIdentity.birthtimeMs === marker.teamRootIdentity.birthtimeMs
  );
}
