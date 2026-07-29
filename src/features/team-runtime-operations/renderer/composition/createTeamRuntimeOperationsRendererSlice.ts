import type {
  TeamRuntimeOperationsActionsPort,
  TeamRuntimeOperationsRendererSlice,
  TeamRuntimeOperationsRendererTransportPort,
} from '../ports/TeamRuntimeOperationsRendererPorts';

export interface TeamRuntimeOperationsRendererSliceDependencies {
  actions: TeamRuntimeOperationsActionsPort;
  transport: TeamRuntimeOperationsRendererTransportPort;
}

export function createTeamRuntimeOperationsRendererSlice(
  dependencies: TeamRuntimeOperationsRendererSliceDependencies
): TeamRuntimeOperationsRendererSlice {
  const refreshRuntime = (
    teamName: string,
    options: { includeMessages?: boolean; includeTeams?: boolean } = {}
  ): Promise<PromiseSettledResult<unknown>[]> => {
    return Promise.allSettled([
      ...(options.includeMessages
        ? [dependencies.actions.getActions().refreshTeamMessagesHead(teamName)]
        : []),
      dependencies.actions.getActions().fetchMemberSpawnStatuses(teamName),
      dependencies.actions.getActions().fetchTeamAgentRuntime(teamName),
      ...(options.includeTeams ? [dependencies.actions.getActions().fetchTeams()] : []),
    ]);
  };

  return {
    restartMember: async (teamName, memberName) => {
      try {
        await dependencies.transport.restartMember(teamName, memberName);
      } finally {
        await refreshRuntime(teamName, { includeMessages: true });
      }
    },
    retryFailedRuntimeLanes: async (teamName) => {
      try {
        return await dependencies.transport.retryFailedSecondaryLanes(teamName);
      } finally {
        await refreshRuntime(teamName);
      }
    },
    skipMemberForLaunch: async (teamName, memberName) => {
      try {
        await dependencies.transport.skipMemberForLaunch(teamName, memberName);
      } finally {
        await refreshRuntime(teamName, { includeTeams: true });
      }
    },
  };
}
