import type {
  TeamLifecycleMutationCleanupPort,
  TeamLifecycleMutationSelectionState,
  TeamLifecycleMutationStateCleanupDependencies,
} from '../ports/TeamLifecycleMutationPorts';

export function createTeamLifecycleMutationCleanup<
  TState extends TeamLifecycleMutationSelectionState,
>(
  dependencies: TeamLifecycleMutationStateCleanupDependencies<TState>
): TeamLifecycleMutationCleanupPort<TState> {
  return {
    resetScope: (teamName, mutation) => dependencies.resetScope(teamName, mutation),

    projectState: (state, teamName, mutation, floor) => {
      const clearedState = dependencies.collectStateRemovals(state, teamName);
      const tombstones = dependencies.buildProgressTombstones(state, teamName, floor);
      const selected = state.selectedTeamName === teamName;

      if (mutation === 'soft-delete') {
        return {
          ...(selected
            ? {
                selectedTeamName: null,
                selectedTeamData: null,
                selectedTeamLoading: false,
                selectedTeamError: null,
              }
            : {}),
          ...clearedState,
          ...tombstones,
        } as Partial<TState>;
      }

      if (mutation === 'permanent-delete') {
        if (selected) {
          return {
            selectedTeamName: null,
            selectedTeamData: null,
            selectedTeamError: null,
            ...clearedState,
            ...tombstones,
          } as Partial<TState>;
        }
        if (Object.keys(clearedState).length > 0) {
          return {
            ...clearedState,
            ...tombstones,
          };
        }
        return tombstones;
      }

      if (Object.keys(clearedState).length === 0) {
        return tombstones;
      }
      return {
        ...clearedState,
        ...tombstones,
      };
    },
  };
}
