import { createLogger } from '@shared/utils/logger';

import { createTeamTaskBoardActions } from '../../core/application/createTeamTaskBoardActions';

import { createTaskChangePresenceRefreshPort } from './createTaskChangePresenceRefreshPort';
import { createTeamTaskBoardTransport } from './createTeamTaskBoardTransport';
import { getTaskLifecycleAnalyticsTracker } from './taskLifecycleAnalytics';

import type { TeamTaskBoardActions } from '../../core/application/createTeamTaskBoardActions';
import type { TaskChangeRequestOptions, TeamTask, TeamViewSnapshot } from '@shared/types';

export interface TeamTaskBoardRendererSlice extends TeamTaskBoardActions {
  reviewActionError: string | null;
  deletedTasks: TeamTask[];
  deletedTasksLoading: boolean;
}

export interface TeamTaskBoardRendererStoreContext {
  checkTaskHasChanges?: (
    teamName: string,
    taskId: string,
    options: TaskChangeRequestOptions
  ) => Promise<unknown>;
  fetchAllTasks(): Promise<void>;
  getTeamData(teamName: string): TeamViewSnapshot | null;
  invalidateTaskChangePresence?: (cacheKeys: string[]) => void;
  refreshTeamData(teamName: string): Promise<void>;
  selectedTeamData: TeamViewSnapshot | null;
  selectedTeamName: string | null;
}

export interface TeamTaskBoardRendererSliceDependencies {
  getState(): TeamTaskBoardRendererStoreContext;
  mapReviewError(error: unknown): string;
  setState(state: Partial<TeamTaskBoardRendererSlice>): void;
}

const logger = createLogger('TeamTaskBoardRenderer');

export function createTeamTaskBoardRendererSlice(
  dependencies: TeamTaskBoardRendererSliceDependencies
): TeamTaskBoardRendererSlice {
  const transport = createTeamTaskBoardTransport();
  const actions = createTeamTaskBoardActions({
    clock: { now: () => Date.now() },
    deletedTasks: transport.deletedTasks,
    lifecycle: getTaskLifecycleAnalyticsTracker(),
    logger: {
      error: (message, error) => logger.error(message, error),
    },
    mutations: transport.mutations,
    presence: createTaskChangePresenceRefreshPort(() => dependencies.getState()),
    refresh: {
      refreshAllTasks: () => dependencies.getState().fetchAllTasks(),
      refreshTeamData: (teamName) => dependencies.getState().refreshTeamData(teamName),
    },
    reviewErrors: { map: (error) => dependencies.mapReviewError(error) },
    state: {
      getTeamData: (teamName) => dependencies.getState().getTeamData(teamName),
      setDeletedTasks: (tasks, loading) =>
        dependencies.setState({ deletedTasks: tasks, deletedTasksLoading: loading }),
      setDeletedTasksLoading: (loading) => dependencies.setState({ deletedTasksLoading: loading }),
      setReviewActionError: (error) => dependencies.setState({ reviewActionError: error }),
    },
  });

  return {
    reviewActionError: null,
    deletedTasks: [],
    deletedTasksLoading: false,
    ...actions,
  };
}
