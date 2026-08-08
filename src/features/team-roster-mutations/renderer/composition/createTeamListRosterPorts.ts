import type { TeamListRosterPorts } from '../ports/TeamListRosterPorts';

interface LegacyTeamListRosterApi {
  readonly teams: {
    replaceMembers: TeamListRosterPorts['replaceRoster'];
  };
}

export function createTeamListRosterPorts(legacyApi: LegacyTeamListRosterApi): TeamListRosterPorts {
  return {
    replaceRoster: (teamName, request) => legacyApi.teams.replaceMembers(teamName, request),
  };
}
