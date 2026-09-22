import type { OpenCodeRuntimeControlAck, OpenCodeRuntimeControlApi } from '../runtime-control';
import type { TeamProvisioningRuntimeDeliveryApi as FeatureTeamProvisioningRuntimeDeliveryApi } from '@features/team-provisioning/contracts';
import type { TeamRuntimeState } from '@shared/types/team';

export type { OpenCodeRuntimeControlAck };

export type TeamRuntimeControlCompatibilityApi = Omit<
  OpenCodeRuntimeControlApi,
  'deliverOpenCodeRuntimeMessage'
> &
  Pick<FeatureTeamProvisioningRuntimeDeliveryApi, 'deliverOpenCodeRuntimeMessage'>;

export interface TeamRuntimeApi {
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
  stopTeam(teamName: string): Promise<void>;
  isTeamAlive(teamName: string): boolean;
  getAliveTeams(): string[];
  getCurrentRunId(teamName: string): string | null;
}

export interface TeamHttpRuntimeApi {
  getRuntimeState(teamName: string): Promise<TeamRuntimeState>;
  stopTeam(teamName: string): Promise<void>;
  getAliveTeams(): string[];
}
