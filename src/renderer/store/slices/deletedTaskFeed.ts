import { api } from '@renderer/api';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';
import { createLogger } from '@shared/utils/logger';

import { structurallySharePlainValue } from '../team/teamSnapshotStructuralSharing';
import {
  captureContextScopedRequestEpoch,
  isContextScopedRequestEpochCurrent,
} from '../utils/contextScopedRequestEpoch';

import type { AppState } from '../types';
import type { GlobalTask, TeamTask } from '@shared/types';
import type { StateCreator } from 'zustand';

const logger = createLogger('Store:deletedTaskFeed');

export interface DeletedTaskFeed {
  deletedTasks: TeamTask[];
  deletedTasksLoading: boolean;
  globalDeletedTasks: GlobalTask[];
  fetchAllDeletedTasks: () => Promise<void>;
}

interface DeletedTaskFeedScope {
  contextId: string;
  contextEpoch: number;
}

export const createDeletedTaskFeed: StateCreator<AppState, [], [], DeletedTaskFeed> = (
  set,
  get
) => {
  let fetchGeneration = 0;
  let inFlightRefresh: Promise<void> | null = null;

  const projectTeamDeletedTasks = (
    team: AppState['teams'][number],
    tasks: TeamTask[]
  ): GlobalTask[] =>
    tasks.map(
      (task): GlobalTask => ({
        ...task,
        teamName: team.teamName,
        teamDisplayName: team.displayName,
        teamDeleted: team.deletedAt ? true : undefined,
        projectPath: task.projectPath ?? team.projectPath,
      })
    );

  return {
    deletedTasks: [],
    deletedTasksLoading: false,
    globalDeletedTasks: [],

    fetchAllDeletedTasks: async () => {
      const generation = ++fetchGeneration;
      if (inFlightRefresh) await inFlightRefresh;
      if (generation !== fetchGeneration) return;
      const run = (async () => {
        const scope: DeletedTaskFeedScope = {
          contextId: get().activeContextId,
          contextEpoch: captureContextScopedRequestEpoch(),
        };
        const settled = await Promise.allSettled(
          get().teams.map(async (team) => {
            const tasks = await unwrapIpc<TeamTask[]>('team:getDeletedTasks', () =>
              api.teams.getDeletedTasks(team.teamName)
            );
            return projectTeamDeletedTasks(team, tasks);
          })
        );
        const batches: GlobalTask[][] = [];
        for (const result of settled) {
          if (result.status === 'fulfilled') {
            batches.push(result.value);
          } else {
            logger.error('Failed to fetch deleted tasks for one team:', result.reason);
          }
        }
        if (
          get().activeContextId !== scope.contextId ||
          !isContextScopedRequestEpochCurrent(scope.contextEpoch)
        ) {
          return;
        }
        set((state) => ({
          globalDeletedTasks: structurallySharePlainValue(state.globalDeletedTasks, batches.flat()),
        }));
      })();
      inFlightRefresh = run.finally(() => {
        inFlightRefresh = null;
      });
      await inFlightRefresh;
    },
  };
};
