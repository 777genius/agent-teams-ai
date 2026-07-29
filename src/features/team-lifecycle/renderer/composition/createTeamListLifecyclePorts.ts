import type { TeamListLifecyclePorts } from '../ports/TeamListLifecyclePorts';

interface LegacyTeamListLifecycleApi {
  readonly teams: {
    aliveList(): Promise<string[]>;
    stop(teamName: string): Promise<void>;
  };
}

export function createTeamListLifecyclePorts(
  legacyApi: LegacyTeamListLifecycleApi
): TeamListLifecyclePorts {
  return {
    listAliveTeams: () => legacyApi.teams.aliveList(),
    stopTeam: (teamName) => legacyApi.teams.stop(teamName),
  };
}
