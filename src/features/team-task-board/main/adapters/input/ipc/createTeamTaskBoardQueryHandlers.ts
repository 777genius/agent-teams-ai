import { validateTaskId, validateTeamName } from '@main/ipc/guards';

import { executeTeamTaskBoardHandler } from './executeTeamTaskBoardHandler';

import type { TeamTaskBoardIpcDependencies } from './TeamTaskBoardIpcDependencies';
import type {
  GlobalTask,
  IpcResult,
  TaskChangePresenceState,
  TeamTask,
  TeamTaskWithKanban,
} from '@shared/types';
import type { IpcMainInvokeEvent } from 'electron';

export function createTeamTaskBoardQueryHandlers(dependencies: TeamTaskBoardIpcDependencies): {
  getTask(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown
  ): Promise<IpcResult<TeamTaskWithKanban | null>>;
  getTaskChangePresence(
    event: IpcMainInvokeEvent,
    teamName: unknown
  ): Promise<IpcResult<Record<string, TaskChangePresenceState>>>;
  getAllTasks(event: IpcMainInvokeEvent): Promise<IpcResult<GlobalTask[]>>;
  getDeletedTasks(event: IpcMainInvokeEvent, teamName: unknown): Promise<IpcResult<TeamTask[]>>;
} {
  return {
    async getTask(_event, teamName, taskId) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedTaskId = validateTaskId(taskId);
      if (!validatedTaskId.valid) {
        return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
      }
      return executeTeamTaskBoardHandler(dependencies.logger, 'getTask', () =>
        dependencies.queries.getTask(validatedTeamName.value!, validatedTaskId.value!)
      );
    },

    async getTaskChangePresence(_event, teamName) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      return executeTeamTaskBoardHandler(dependencies.logger, 'getTaskChangePresence', () =>
        dependencies.changePresence.getTaskChangePresence(validatedTeamName.value!)
      );
    },

    async getAllTasks(_event) {
      dependencies.operationTracker.setCurrent('team:getAllTasks');
      const startedAt = dependencies.clock.now();
      try {
        return await executeTeamTaskBoardHandler(dependencies.logger, 'getAllTasks', () =>
          dependencies.globalTasks.getAllTasks()
        );
      } finally {
        const elapsedMs = dependencies.clock.now() - startedAt;
        if (elapsedMs >= 1500) {
          dependencies.logger.warn(`[teams:getAllTasks] slow ms=${elapsedMs}`);
        }
        dependencies.operationTracker.setCurrent(null);
      }
    },

    async getDeletedTasks(_event, teamName) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      return executeTeamTaskBoardHandler(dependencies.logger, 'getDeletedTasks', () =>
        dependencies.queries.getDeletedTasks(validatedTeamName.value!)
      );
    },
  };
}
