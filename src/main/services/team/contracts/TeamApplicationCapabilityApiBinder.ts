import type {
  TeamApplicationDataApi,
  TeamApplicationProvisioningStartApi,
  TeamApplicationProvisioningStatusApi,
  TeamApplicationResumeApi,
  TeamApplicationRuntimeApi,
  TeamApplicationTaskActivityApi,
} from './TeamApplicationCapabilityApis';

export function bindTeamApplicationDataApi(source: TeamApplicationDataApi): TeamApplicationDataApi {
  return {
    listTeams: () => source.listTeams(),
    getTeamData: (teamName) => source.getTeamData(teamName),
    getSavedRequest: (teamName) => source.getSavedRequest(teamName),
    createTeamConfig: (request) => source.createTeamConfig(request),
  };
}

export function bindTeamApplicationProvisioningStartApi(
  source: TeamApplicationProvisioningStartApi
): TeamApplicationProvisioningStartApi {
  return {
    createTeam: (request, onProgress) => source.createTeam(request, onProgress),
    launchTeam: (request, onProgress) => source.launchTeam(request, onProgress),
  };
}

export function bindTeamApplicationProvisioningStatusApi(
  source: TeamApplicationProvisioningStatusApi
): TeamApplicationProvisioningStatusApi {
  return {
    getProvisioningStatus: (runId) => source.getProvisioningStatus(runId),
  };
}

export function bindTeamApplicationRuntimeApi(
  source: TeamApplicationRuntimeApi
): TeamApplicationRuntimeApi {
  return {
    getRuntimeState: (teamName) => source.getRuntimeState(teamName),
    stopTeam: (teamName) => source.stopTeam(teamName),
    getAliveTeams: () => source.getAliveTeams(),
  };
}

export function bindTeamApplicationTaskActivityApi(
  source: TeamApplicationTaskActivityApi
): TeamApplicationTaskActivityApi {
  return {
    repairStaleTaskActivityIntervalsBeforeSnapshot: (teamName) =>
      source.repairStaleTaskActivityIntervalsBeforeSnapshot(teamName),
  };
}

export function bindTeamApplicationResumeApi(
  source: TeamApplicationResumeApi
): TeamApplicationResumeApi {
  return {
    resumeTeam: (teamName) => source.resumeTeam(teamName),
  };
}
