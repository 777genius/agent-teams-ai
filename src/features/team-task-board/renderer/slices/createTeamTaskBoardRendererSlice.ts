import { createLogger } from '@shared/utils/logger';

import { createTeamTaskBoardActions } from '../../core/application/createTeamTaskBoardActions';
import { createTaskChangePresenceRefreshPort } from '../composition/createTaskChangePresenceRefreshPort';
import { getTaskLifecycleAnalyticsTracker } from '../composition/taskLifecycleAnalytics';

import type {
  TeamTaskBoardRendererSlice,
  TeamTaskBoardRendererSliceDependencies,
} from '../ports/TeamTaskBoardRendererPorts';

export type {
  TeamTaskBoardRendererSlice,
  TeamTaskBoardRendererSliceDependencies,
  TeamTaskBoardRendererStoreContext,
} from '../ports/TeamTaskBoardRendererPorts';

const logger = createLogger('TeamTaskBoardRenderer');

export function createTeamTaskBoardRendererSlice(
  dependencies: TeamTaskBoardRendererSliceDependencies
): TeamTaskBoardRendererSlice {
  const transport = dependencies.transport;
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
