import type { TeamApplicationRuntimeIngressApi } from './TeamApplicationCapabilityApis';
import type {
  TeamHttpRuntimeApi,
  TeamRuntimeApi,
  TeamRuntimeControlCompatibilityApi,
} from './TeamProvisioningRuntimeApis';

/**
 * Legacy provider compatibility stays at this outer adapter. Application
 * hosts receive only provider-neutral runtime ingress operations.
 */
export function bindTeamOpenCodeRuntimeIngressCompatibilityApi(
  source: TeamRuntimeControlCompatibilityApi
): TeamApplicationRuntimeIngressApi {
  return {
    recordRuntimeBootstrapCheckin: (payload) =>
      source.recordOpenCodeRuntimeBootstrapCheckin(payload),
    deliverRuntimeMessage: (payload) => source.deliverOpenCodeRuntimeMessage(payload),
    recordRuntimeTaskEvent: (payload) => source.recordOpenCodeRuntimeTaskEvent(payload),
    recordRuntimeHeartbeat: (payload) => source.recordOpenCodeRuntimeHeartbeat(payload),
  };
}

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
