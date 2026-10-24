import { isTeamWorkSyncRestoreReady as readyPortable } from '@agent-teams/legacy-agent-host/lifecycle';
import { getBackupsBasePath } from '@main/utils/pathDecoder';
export function isTeamWorkSyncRestoreReady(
  teamName: string,
  owner: Parameters<typeof readyPortable>[1]
): Promise<boolean> {
  return readyPortable(teamName, owner, getBackupsBasePath());
}
