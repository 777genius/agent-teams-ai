import type {
  TeamLifecycleMutationAnalyticsPort,
  TeamLifecycleMutationCleanupPort,
  TeamLifecycleMutationClockPort,
  TeamLifecycleMutationKind,
  TeamLifecycleMutationRefreshPort,
  TeamLifecycleMutationSelectionState,
  TeamLifecycleMutationSlice,
  TeamLifecycleMutationStatePort,
  TeamLifecycleMutationTransportPort,
} from '../ports/TeamLifecycleMutationPorts';

export interface TeamLifecycleMutationSliceDependencies<
  TState extends TeamLifecycleMutationSelectionState,
  TAnalyticsContext,
> {
  analytics: TeamLifecycleMutationAnalyticsPort<TAnalyticsContext>;
  cleanup: TeamLifecycleMutationCleanupPort<TState>;
  clock: TeamLifecycleMutationClockPort;
  refresh: TeamLifecycleMutationRefreshPort;
  state: TeamLifecycleMutationStatePort<TState>;
  transport: TeamLifecycleMutationTransportPort;
}

export function createTeamLifecycleMutationSlice<
  TState extends TeamLifecycleMutationSelectionState,
  TAnalyticsContext,
>(
  dependencies: TeamLifecycleMutationSliceDependencies<TState, TAnalyticsContext>
): TeamLifecycleMutationSlice {
  const finishMutation = async (
    teamName: string,
    mutation: TeamLifecycleMutationKind
  ): Promise<void> => {
    dependencies.cleanup.resetScope(teamName, mutation);
    dependencies.state.setState((state) =>
      dependencies.cleanup.projectState(state, teamName, mutation, dependencies.clock.nowIso())
    );
    await dependencies.refresh.fetchTeams();
    await dependencies.refresh.fetchAllTasks();
  };

  return {
    deleteTeam: async (teamName) => {
      const analyticsContext = dependencies.analytics.captureSoftDelete(teamName);
      try {
        await dependencies.transport.softDelete(teamName);
      } catch (error) {
        dependencies.analytics.recordSoftDeleteFailure(analyticsContext, error);
        throw error;
      }
      dependencies.analytics.recordSoftDeleteSuccess(analyticsContext);
      await finishMutation(teamName, 'soft-delete');
    },

    permanentlyDeleteTeam: async (teamName) => {
      await dependencies.transport.permanentlyDelete(teamName);
      await finishMutation(teamName, 'permanent-delete');
    },

    restoreTeam: async (teamName) => {
      await dependencies.transport.restore(teamName);
      await finishMutation(teamName, 'restore');
    },
  };
}
