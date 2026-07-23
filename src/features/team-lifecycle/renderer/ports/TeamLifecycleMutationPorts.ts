export type TeamLifecycleMutationKind = 'soft-delete' | 'restore' | 'permanent-delete';

export interface TeamLifecycleMutationSelectionState {
  selectedTeamData: unknown;
  selectedTeamError: string | null;
  selectedTeamLoading: boolean;
  selectedTeamName: string | null;
}

export interface TeamLifecycleMutationSlice {
  deleteTeam(teamName: string): Promise<void>;
  permanentlyDeleteTeam(teamName: string): Promise<void>;
  restoreTeam(teamName: string): Promise<void>;
}

export interface TeamLifecycleMutationTransportPort {
  permanentlyDelete(teamName: string): Promise<void>;
  restore(teamName: string): Promise<void>;
  softDelete(teamName: string): Promise<void>;
}

export interface TeamLifecycleMutationStatePort<
  TState extends TeamLifecycleMutationSelectionState,
> {
  setState(update: (state: TState) => Partial<TState>): void;
}

export interface TeamLifecycleMutationCleanupPort<
  TState extends TeamLifecycleMutationSelectionState,
> {
  projectState(
    state: TState,
    teamName: string,
    mutation: TeamLifecycleMutationKind,
    floor: string
  ): Partial<TState>;
  resetScope(teamName: string, mutation: TeamLifecycleMutationKind): void;
}

export interface TeamLifecycleMutationRefreshPort {
  fetchAllTasks(): Promise<void>;
  fetchTeams(): Promise<void>;
}

export interface TeamLifecycleMutationAnalyticsPort<TContext> {
  captureSoftDelete(teamName: string): TContext;
  recordSoftDeleteFailure(context: TContext, error: unknown): void;
  recordSoftDeleteSuccess(context: TContext): void;
}

export interface TeamLifecycleMutationClockPort {
  nowIso(): string;
}

export interface TeamLifecycleMutationStateCleanupDependencies<
  TState extends TeamLifecycleMutationSelectionState,
> {
  buildProgressTombstones(state: TState, teamName: string, floor: string): Partial<TState>;
  collectStateRemovals(state: TState, teamName: string): Partial<TState>;
  resetScope(teamName: string, mutation: TeamLifecycleMutationKind): void;
}
