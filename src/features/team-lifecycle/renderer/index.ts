import { createTeamLifecycleMutationCleanup as createMutationCleanup } from './slices/createTeamLifecycleMutationCleanup';
import { createTeamLifecycleMutationSlice as createMutationSlice } from './slices/createTeamLifecycleMutationSlice';
import {
  LOADING_TEAM_LIFECYCLE_LIST_VIEW_MODEL as loadingListViewModel,
  toTeamLifecycleListItemViewModel as toListItemViewModel,
  toTeamLifecycleListViewModel as toListViewModel,
} from './view-models/teamLifecycleListViewModel';

import type {
  CanonicalListTeamLifecycleResult,
  CanonicalTeamLifecycleListItem,
} from '../contracts';
import type {
  TeamLifecycleMutationCleanupPort,
  TeamLifecycleMutationSelectionState,
  TeamLifecycleMutationSlice,
  TeamLifecycleMutationSliceDependencies,
  TeamLifecycleMutationStateCleanupDependencies,
} from './ports/TeamLifecycleMutationPorts';
import type {
  TeamLifecycleListItemViewModel,
  TeamLifecycleListViewModel,
} from './view-models/teamLifecycleListViewModel';

export type {
  HostedTeamLifecycleFetchPort,
  HostedTeamLifecycleHttpResponse,
  HostedTeamLifecycleTransport,
  HostedTeamLifecycleTransportDependencies,
} from './createHostedTeamLifecycleTransport';
export {
  createHostedTeamLifecycleTransport,
  HOSTED_TEAM_LIFECYCLE_TIMEOUT_MS,
} from './createHostedTeamLifecycleTransport';

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
export type { UseTeamLifecycleListResult } from './hooks/useTeamLifecycleList';
export { useTeamLifecycleList } from './hooks/useTeamLifecycleList';
export type {
  TeamLifecycleMutationAnalyticsPort,
  TeamLifecycleMutationCleanupPort,
  TeamLifecycleMutationClockPort,
  TeamLifecycleMutationKind,
  TeamLifecycleMutationRefreshPort,
  TeamLifecycleMutationSelectionState,
  TeamLifecycleMutationSlice,
  TeamLifecycleMutationSliceDependencies,
  TeamLifecycleMutationStateCleanupDependencies,
  TeamLifecycleMutationStatePort,
  TeamLifecycleMutationTransportPort,
} from './ports/TeamLifecycleMutationPorts';
export type { TeamListLifecyclePorts } from './ports/TeamListLifecyclePorts';
export { HostedTeamLifecycleControls } from './ui/HostedTeamLifecycleControls';
export type { HostedTeamLifecycleListProps } from './ui/HostedTeamLifecycleList';
export { HostedTeamLifecycleList } from './ui/HostedTeamLifecycleList';
export {
  loadTeamLifecycleList,
  TEAM_LIFECYCLE_LIST_MAX_ITEMS,
  TEAM_LIFECYCLE_LIST_MAX_PAGES,
} from './utils/loadTeamLifecycleList';
export type {
  TeamLifecycleListItemViewModel,
  TeamLifecycleListStatusLabelKey,
  TeamLifecycleListStatusTone,
  TeamLifecycleListViewModel,
} from './view-models/teamLifecycleListViewModel';
