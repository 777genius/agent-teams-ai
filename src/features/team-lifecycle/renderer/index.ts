import { createTeamLifecycleMutationCleanup as createMutationCleanup } from './adapters/createTeamLifecycleMutationCleanup';
import { createTeamLifecycleMutationSlice as createMutationSlice } from './adapters/createTeamLifecycleMutationSlice';
import {
  LOADING_TEAM_LIFECYCLE_LIST_VIEW_MODEL as loadingListViewModel,
  toTeamLifecycleListItemViewModel as toListItemViewModel,
  toTeamLifecycleListViewModel as toListViewModel,
} from './adapters/teamLifecycleListViewModel';

import type {
  CanonicalListTeamLifecycleResult,
  CanonicalTeamLifecycleListItem,
} from '../contracts';
import type {
  TeamLifecycleListItemViewModel,
  TeamLifecycleListViewModel,
} from './hooks/useTeamLifecycleList';
import type {
  TeamLifecycleMutationAnalyticsPort,
  TeamLifecycleMutationCleanupPort,
  TeamLifecycleMutationClockPort,
  TeamLifecycleMutationRefreshPort,
  TeamLifecycleMutationSelectionState,
  TeamLifecycleMutationSlice,
  TeamLifecycleMutationStateCleanupDependencies,
  TeamLifecycleMutationStatePort,
  TeamLifecycleMutationTransportPort,
} from './ports/TeamLifecycleMutationPorts';

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

export function createTeamLifecycleMutationCleanup<
  TState extends TeamLifecycleMutationSelectionState,
>(
  dependencies: TeamLifecycleMutationStateCleanupDependencies<TState>
): TeamLifecycleMutationCleanupPort<TState> {
  return createMutationCleanup(dependencies);
}

export function createTeamLifecycleMutationSlice<
  TState extends TeamLifecycleMutationSelectionState,
  TAnalyticsContext,
>(
  dependencies: TeamLifecycleMutationSliceDependencies<TState, TAnalyticsContext>
): TeamLifecycleMutationSlice {
  return createMutationSlice(dependencies);
}

export const LOADING_TEAM_LIFECYCLE_LIST_VIEW_MODEL: TeamLifecycleListViewModel =
  loadingListViewModel;

export function toTeamLifecycleListItemViewModel(
  item: CanonicalTeamLifecycleListItem
): TeamLifecycleListItemViewModel {
  return toListItemViewModel(item);
}

export function toTeamLifecycleListViewModel(
  result: CanonicalListTeamLifecycleResult
): TeamLifecycleListViewModel {
  return toListViewModel(result);
}

export { createTeamListLifecyclePorts } from './composition/createTeamListLifecyclePorts';
export type {
  TeamLifecycleListItemViewModel,
  TeamLifecycleListStatusLabelKey,
  TeamLifecycleListStatusTone,
  TeamLifecycleListViewModel,
  UseTeamLifecycleListResult,
} from './hooks/useTeamLifecycleList';
export { useTeamLifecycleList } from './hooks/useTeamLifecycleList';
export type {
  TeamLifecycleMutationAnalyticsPort,
  TeamLifecycleMutationCleanupPort,
  TeamLifecycleMutationClockPort,
  TeamLifecycleMutationKind,
  TeamLifecycleMutationRefreshPort,
  TeamLifecycleMutationSelectionState,
  TeamLifecycleMutationSlice,
  TeamLifecycleMutationStateCleanupDependencies,
  TeamLifecycleMutationStatePort,
  TeamLifecycleMutationTransportPort,
} from './ports/TeamLifecycleMutationPorts';
export type { TeamListLifecyclePorts } from './ports/TeamListLifecyclePorts';
export type { HostedTeamLifecycleListProps } from './ui/HostedTeamLifecycleList';
export { HostedTeamLifecycleList } from './ui/HostedTeamLifecycleList';
export {
  loadTeamLifecycleList,
  TEAM_LIFECYCLE_LIST_MAX_ITEMS,
  TEAM_LIFECYCLE_LIST_MAX_PAGES,
} from './utils/loadTeamLifecycleList';
