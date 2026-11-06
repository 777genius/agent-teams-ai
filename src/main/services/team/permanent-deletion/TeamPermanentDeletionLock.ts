import { TeamPermanentDeletionLock } from '@agent-teams/legacy-agent-host/lifecycle';
import { getBackupsBasePath } from '@main/utils/pathDecoder';
export { TeamPermanentDeletionLock };
export type { PermanentDeletionLock } from '@agent-teams/legacy-agent-host/lifecycle';
export function createTeamPermanentDeletionLock(): TeamPermanentDeletionLock {
  return new TeamPermanentDeletionLock({ backups: getBackupsBasePath() });
}
