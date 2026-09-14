import type {
  TeamListProvisioningLaunchPort,
  TeamListProvisioningPorts,
} from '../ports/TeamListProvisioningPorts';

interface LegacyTeamListProvisioningApi {
  readonly teams: {
    deleteDraft(teamName: string): Promise<void>;
    getSavedRequest(teamName: string): ReturnType<TeamListProvisioningPorts['readDraft']>;
  };
}

export function createTeamListProvisioningPorts(
  legacyApi: LegacyTeamListProvisioningApi,
  launch: TeamListProvisioningLaunchPort
): TeamListProvisioningPorts {
  return {
    deleteDraft: (teamName) => legacyApi.teams.deleteDraft(teamName),
    readDraft: (teamName) => legacyApi.teams.getSavedRequest(teamName),
    // The existing store-owned launch slice remains the one launch/process
    // coordinator. This renderer facet only narrows the dependency exposed to
    // the list presentation.
    launchTeam: (request) => launch.launchTeam(request),
  };
}
