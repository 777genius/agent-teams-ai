import { api } from '@renderer/api';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';
import { createLogger } from '@shared/utils/logger';

import { structurallySharePlainValue } from '../team/teamSnapshotStructuralSharing';

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

export const createDeletedTaskFeed: StateCreator<AppState, [], [], DeletedTaskFeed> = (
  set,
  get
) => {
  let fetchGeneration = 0;
  let inFlightRefresh: Promise<void> | null = null;

  return {
    deletedTasks: [],
    deletedTasksLoading: false,
    globalDeletedTasks: [],

    fetchAllDeletedTasks: async () => {
      const generation = ++fetchGeneration;
      if (inFlightRefresh) await inFlightRefresh;
      if (generation !== fetchGeneration) return;
      const run = (async () => {
        try {
          const batches = await Promise.all(
            get().teams.map(async (team) => {
              const tasks: TeamTask[] = await unwrapIpc('team:getDeletedTasks', () =>
                api.teams.getDeletedTasks(team.teamName)
              );
              return tasks.map(
                (task): GlobalTask => ({
                  ...task,
                  teamName: team.teamName,
                  teamDisplayName: team.displayName,
                  teamDeleted: team.deletedAt ? true : undefined,
                  projectPath: task.projectPath ?? team.projectPath,
                })
              );
            })
          );
          set((state) => ({
            globalDeletedTasks: structurallySharePlainValue(
              state.globalDeletedTasks,
              batches.flat()
            ),
          }));
        } catch (error) {
          logger.error('Failed to fetch deleted tasks for task views:', error);
        }
      })();
      inFlightRefresh = run.finally(() => {
        inFlightRefresh = null;
      });
      await inFlightRefresh;
    },
  };
};
