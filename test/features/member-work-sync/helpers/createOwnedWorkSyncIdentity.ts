import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TeamBackupService } from '@main/services/team/TeamBackupService';
import { setAppDataBasePath } from '@main/utils/pathDecoder';

import type { TeamWorkSyncIdentityAccess } from '@main/services/team/permanent-deletion/TeamWorkSyncIdentityAccess';

export interface OwnedWorkSyncIdentity {
  identity: TeamWorkSyncIdentityAccess;
  backup: TeamBackupService;
  appDataRoot: string;
  dispose(): Promise<void>;
}

/**
 * Production backup identity owner with isolated app-data/backups.
 * Stops periodic backup so live tests cannot surprise-register a team.
 */
export async function createOwnedWorkSyncIdentity(): Promise<OwnedWorkSyncIdentity> {
  const appDataRoot = await mkdtemp(join(tmpdir(), 'work-sync-owned-identity-'));
  setAppDataBasePath(appDataRoot);
  const backup = new TeamBackupService();
  await backup.initialize();
  backup.dispose();
  return {
    identity: backup.workSyncIdentity,
    backup,
    appDataRoot,
    async dispose() {
      backup.dispose();
      setAppDataBasePath(null);
      await rm(appDataRoot, { recursive: true, force: true });
    },
  };
}
