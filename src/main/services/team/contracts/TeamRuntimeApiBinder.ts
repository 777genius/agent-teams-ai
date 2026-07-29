import type {
  TeamHttpRuntimeApi,
  TeamRuntimeApi,
  TeamRuntimeControlCompatibilityApi,
} from './TeamProvisioningRuntimeApis';

export function bindTeamRuntimeControlCompatibilityApi(
  source: TeamRuntimeControlCompatibilityApi
): TeamRuntimeControlCompatibilityApi {
  return {
    recordOpenCodeRuntimeBootstrapCheckin:
      source.recordOpenCodeRuntimeBootstrapCheckin.bind(source),
    deliverOpenCodeRuntimeMessage: source.deliverOpenCodeRuntimeMessage.bind(source),
    recordOpenCodeRuntimeTaskEvent: source.recordOpenCodeRuntimeTaskEvent.bind(source),
    recordOpenCodeRuntimeHeartbeat: source.recordOpenCodeRuntimeHeartbeat.bind(source),
    answerOpenCodeRuntimePermission: source.answerOpenCodeRuntimePermission.bind(source),
  };
}

export function bindTeamRuntimeApi(source: TeamRuntimeApi): TeamRuntimeApi {
  return {
    getRuntimeState: source.getRuntimeState.bind(source),
    stopTeam: source.stopTeam.bind(source),
    isTeamAlive: source.isTeamAlive.bind(source),
    getAliveTeams: source.getAliveTeams.bind(source),
    getCurrentRunId: source.getCurrentRunId.bind(source),
  };
}

export function bindTeamHttpRuntimeApi(source: TeamHttpRuntimeApi): TeamHttpRuntimeApi {
  return {
    getRuntimeState: source.getRuntimeState.bind(source),
    stopTeam: source.stopTeam.bind(source),
    getAliveTeams: source.getAliveTeams.bind(source),
  };
}
