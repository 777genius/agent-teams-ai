import { api } from '@renderer/api';

import type { TeamListLifecyclePorts } from '@features/team-lifecycle/renderer';

export type TeamAliveListReadPort = Pick<TeamListLifecyclePorts, 'listAliveTeams'>;

export function createTeamAliveListReadPort(): TeamAliveListReadPort {
  return {
    listAliveTeams: () => api.teams.aliveList(),
  };
}
