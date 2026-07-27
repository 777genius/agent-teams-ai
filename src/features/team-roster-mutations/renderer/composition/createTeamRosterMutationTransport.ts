import { api } from '@renderer/api';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import type { TeamRosterMutationRendererTransportPort } from '../ports/TeamRosterMutationRendererPorts';

export function createTeamRosterMutationTransport(): TeamRosterMutationRendererTransportPort {
  return {
    add: (teamName, request) =>
      unwrapIpc('team:addMember', () => api.teams.addMember(teamName, request)),
    remove: (teamName, memberName) =>
      unwrapIpc('team:removeMember', () => api.teams.removeMember(teamName, memberName)),
    restore: (teamName, memberName) =>
      unwrapIpc('team:restoreMember', () => api.teams.restoreMember(teamName, memberName)),
    updateRole: (teamName, memberName, role) =>
      unwrapIpc('team:updateMemberRole', () =>
        api.teams.updateMemberRole(teamName, memberName, role)
      ),
  };
}
