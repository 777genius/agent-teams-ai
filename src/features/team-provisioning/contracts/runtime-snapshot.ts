import type { TeamAgentRuntimeSnapshot } from '@shared/types/team';

export interface TeamProvisioningRuntimeSnapshotApi {
  getTeamAgentRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot>;
}
