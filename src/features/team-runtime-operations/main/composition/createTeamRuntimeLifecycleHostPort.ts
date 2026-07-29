import type {
  TeamMemberSpawnStatusPort,
  TeamRuntimeLifecycleCommandPort,
} from '../../core/application/ports/TeamRuntimeOperationPorts';

interface LegacyTeamRuntimeLifecycleSource {
  getMemberSpawnStatuses: TeamMemberSpawnStatusPort['getMemberSpawnStatuses'];
  restartMember: TeamRuntimeLifecycleCommandPort['restartMember'];
  retryFailedOpenCodeSecondaryLanes: TeamRuntimeLifecycleCommandPort['retryFailedRuntimeLanes'];
  skipMemberForLaunch: TeamRuntimeLifecycleCommandPort['skipMemberForLaunch'];
}

type TeamRuntimeLifecycleHostPort = TeamMemberSpawnStatusPort & TeamRuntimeLifecycleCommandPort;

export function createTeamRuntimeLifecycleHostPort(
  source: LegacyTeamRuntimeLifecycleSource
): TeamRuntimeLifecycleHostPort {
  return {
    getMemberSpawnStatuses: (teamName) => source.getMemberSpawnStatuses(teamName),
    restartMember: (teamName, memberName) => source.restartMember(teamName, memberName),
    retryFailedRuntimeLanes: (teamName) => source.retryFailedOpenCodeSecondaryLanes(teamName),
    skipMemberForLaunch: (teamName, memberName) => source.skipMemberForLaunch(teamName, memberName),
  };
}
