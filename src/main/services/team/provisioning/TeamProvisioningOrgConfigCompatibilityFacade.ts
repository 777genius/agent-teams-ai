import type {
  OpenCodeMemberDirectory,
  OpenCodeMemberIdentityResolution,
} from '../opencode/delivery/OpenCodeMemberMessageDeliveryService';
import type { TeamConfig, TeamMember } from '@shared/types';

export interface TeamProvisioningOrgConfigCompatibilityServiceHost {
  configFacade: {
    readConfigForObservation(teamName: string): Promise<TeamConfig | null>;
  };
  teamMetaStore: {
    getMeta(teamName: string): Promise<OpenCodeMemberDirectory['teamMeta']>;
  };
  membersMetaStore: {
    getMembers(teamName: string): Promise<TeamMember[]>;
  };
  openCodeMemberIdentityBoundary: {
    resolveOpenCodeMemberIdentityFromDirectory(
      teamName: string,
      memberName: string,
      directory: OpenCodeMemberDirectory
    ): OpenCodeMemberIdentityResolution;
  };
}

export class TeamProvisioningOrgConfigCompatibilityFacade {
  constructor(private readonly host: TeamProvisioningOrgConfigCompatibilityServiceHost) {}

  async readOpenCodeMemberDirectory(teamName: string): Promise<OpenCodeMemberDirectory> {
    const [config, teamMeta, metaMembers] = await Promise.all([
      this.host.configFacade.readConfigForObservation(teamName).catch(() => null),
      this.host.teamMetaStore.getMeta(teamName).catch(() => null),
      this.host.membersMetaStore.getMembers(teamName).catch(() => []),
    ]);
    return { config, teamMeta, metaMembers };
  }

  resolveOpenCodeMemberIdentityFromDirectory(
    teamName: string,
    memberName: string,
    directory: OpenCodeMemberDirectory
  ): OpenCodeMemberIdentityResolution {
    return this.host.openCodeMemberIdentityBoundary.resolveOpenCodeMemberIdentityFromDirectory(
      teamName,
      memberName,
      directory
    );
  }
}

export function createTeamProvisioningOrgConfigCompatibilityFacadeFromService(
  service: TeamProvisioningOrgConfigCompatibilityServiceHost
): TeamProvisioningOrgConfigCompatibilityFacade {
  return new TeamProvisioningOrgConfigCompatibilityFacade(service);
}
