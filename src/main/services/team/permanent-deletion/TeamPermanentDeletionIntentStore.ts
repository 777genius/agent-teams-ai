import { TeamPermanentDeletionIntentStore } from '@agent-teams/legacy-agent-host/lifecycle';
import type { TeamPermanentDeletionLock } from '@agent-teams/legacy-agent-host/lifecycle';
import { createLogger } from '@shared/utils/logger';
import { getBackupsBasePath } from '@main/utils/pathDecoder';
export type { TeamPermanentDeletionIntentStore } from '@agent-teams/legacy-agent-host/lifecycle';
export function createTeamPermanentDeletionIntentStore(
  lock: TeamPermanentDeletionLock
): TeamPermanentDeletionIntentStore {
  return new TeamPermanentDeletionIntentStore(
    lock,
    { backups: getBackupsBasePath() },
    createLogger('TeamBackupService')
  );
}
