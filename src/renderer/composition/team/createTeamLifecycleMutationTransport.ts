import { api } from '@renderer/api';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import type { TeamLifecycleMutationTransportPort } from '@features/team-lifecycle/renderer';

export function createTeamLifecycleMutationTransport(): TeamLifecycleMutationTransportPort {
  return {
    permanentlyDelete: (teamName) =>
      unwrapIpc('team:permanentlyDeleteTeam', () => api.teams.permanentlyDeleteTeam(teamName)),
    restore: (teamName) => unwrapIpc('team:restoreTeam', () => api.teams.restoreTeam(teamName)),
    softDelete: (teamName) => unwrapIpc('team:deleteTeam', () => api.teams.deleteTeam(teamName)),
  };
}
