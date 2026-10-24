import { observeTeamWorkSyncPriorIdentity as observePortable } from '@agent-teams/legacy-agent-host/lifecycle';
import { getBackupsBasePath } from '@main/utils/pathDecoder';
import type { TeamWorkSyncPriorIdentity } from '@agent-teams/legacy-agent-host/lifecycle';
export type { TeamWorkSyncPriorIdentity } from '@agent-teams/legacy-agent-host/lifecycle';
export function observeTeamWorkSyncPriorIdentity(
  teamName: string,
  owner: Parameters<typeof observePortable>[1]
): Promise<TeamWorkSyncPriorIdentity> {
  return observePortable(teamName, owner, getBackupsBasePath());
}
