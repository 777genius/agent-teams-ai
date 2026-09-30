import type { TeamAgentRuntimeSnapshot } from '@shared/types/team';

export type { TeamAgentRuntimeSnapshot };

export interface TeamProvisioningRuntimeSnapshotApi {
  getTeamAgentRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot>;
}
