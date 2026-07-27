import type {
  TeamRosterMutationActionsPort,
  TeamRosterMutationRendererSlice,
  TeamRosterMutationRendererTransportPort,
} from '../ports/TeamRosterMutationRendererPorts';

export interface TeamRosterMutationRendererSliceDependencies {
  actions: TeamRosterMutationActionsPort;
  transport: TeamRosterMutationRendererTransportPort;
}

export function createTeamRosterMutationRendererSlice(
  dependencies: TeamRosterMutationRendererSliceDependencies
): TeamRosterMutationRendererSlice {
  return {
    addMember: async (teamName, request) => {
      await dependencies.transport.add(teamName, request);
      await dependencies.actions.getActions().refreshTeamData(teamName);
    },
    removeMember: async (teamName, memberName) => {
      await dependencies.transport.remove(teamName, memberName);
      await dependencies.actions.getActions().refreshTeamData(teamName);
    },
    restoreMember: async (teamName, memberName) => {
      await dependencies.transport.restore(teamName, memberName);
      await dependencies.actions.getActions().refreshTeamData(teamName);
      await Promise.allSettled([
        dependencies.actions.getActions().fetchMemberSpawnStatuses(teamName),
        dependencies.actions.getActions().fetchTeamAgentRuntime(teamName),
      ]);
    },
    updateMemberRole: async (teamName, memberName, role) => {
      await dependencies.transport.updateRole(teamName, memberName, role);
      await dependencies.actions.getActions().refreshTeamData(teamName);
    },
  };
}
