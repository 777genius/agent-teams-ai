import type { TeamListViewReadPorts } from '../ports/TeamListViewReadPorts';

interface LegacyTeamListViewReadApi {
  readonly teams: {
    getData: TeamListViewReadPorts['readTeamData'];
  };
}

export function createTeamListViewReadPorts(
  legacyApi: LegacyTeamListViewReadApi
): TeamListViewReadPorts {
  return {
    readTeamData: (teamName, options) => legacyApi.teams.getData(teamName, options),
  };
}
