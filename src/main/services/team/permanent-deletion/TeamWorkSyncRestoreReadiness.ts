import { join } from 'node:path';

import { getBackupsBasePath } from '@main/utils/pathDecoder';

import { readBackupManifestStrict } from '../teamBackupManifest';

/** Called inside the existing lifecycle fence, without waiting for startup itself. */
export async function isTeamWorkSyncRestoreReady(
  teamName: string,
  owner: { isInitialized(): boolean; isShuttingDown(): boolean }
): Promise<boolean> {
  if (!owner.isInitialized() || owner.isShuttingDown()) return false;
  const manifest = await readBackupManifestStrict(
    join(getBackupsBasePath(), 'teams', teamName, 'manifest.json'),
    teamName
  );
  return !manifest?.workSyncRestorePending;
}
