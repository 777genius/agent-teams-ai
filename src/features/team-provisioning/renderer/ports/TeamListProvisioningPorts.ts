import type { TeamCreateRequest, TeamLaunchRequest } from '@shared/types';

export interface TeamListProvisioningPorts {
  deleteDraft(teamName: string): Promise<void>;
  readDraft(teamName: string): Promise<TeamCreateRequest | null>;
  launchTeam(request: TeamLaunchRequest): Promise<string>;
}

export interface TeamListProvisioningLaunchPort {
  launchTeam(request: TeamLaunchRequest): Promise<string>;
}
