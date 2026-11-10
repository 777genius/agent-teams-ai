import { TeamPermanentDeletionIntentStore } from '@agent-teams/legacy-agent-host/lifecycle';
import { getBackupsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import type { TeamPermanentDeletionLock } from '@agent-teams/legacy-agent-host/lifecycle';
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
