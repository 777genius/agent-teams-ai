import { join } from 'node:path';


import { readBackupManifestStrict } from './teamBackupManifest.js';

/** Called inside the existing lifecycle fence, without waiting for startup itself. */
export async function isTeamWorkSyncRestoreReady(
  teamName: string,
  owner: { isInitialized(): boolean; isShuttingDown(): boolean },
  backupsRoot: string
): Promise<boolean> {
  if (!owner.isInitialized() || owner.isShuttingDown()) return false;
  const manifest = await readBackupManifestStrict(
    join(backupsRoot, 'teams', teamName, 'manifest.json'),
    teamName
  );
  return !manifest?.workSyncRestorePending;
}
