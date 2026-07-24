import {
  TEAM_GET_TASK_ACTIVITY,
  TEAM_GET_TASK_ACTIVITY_DETAIL,
  TEAM_GET_TASK_EXACT_LOG_DETAIL,
  TEAM_GET_TASK_EXACT_LOG_SUMMARIES,
  TEAM_GET_TASK_LOG_STREAM,
  TEAM_GET_TASK_LOG_STREAM_SUMMARY,
} from '@features/task-log-observability/contracts';
import { validateTaskId, validateTeamName } from '@main/ipc/guards';

import type { TaskLogObservabilityReaders } from '@features/task-log-observability/core/application/ports/TaskLogObservabilityReaders';
import type {
  BoardTaskActivityDetailResult,
  BoardTaskActivityEntry,
  BoardTaskExactLogDetailResult,
  BoardTaskExactLogSummariesResponse,
  BoardTaskLogStreamResponse,
  BoardTaskLogStreamSummary,
  IpcResult,
} from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

export interface TaskLogObservabilityIpcLogger {
  error(message: string): void;
}

export interface TaskLogObservabilityIpcDependencies {
  readers: TaskLogObservabilityReaders;
  logger: TaskLogObservabilityIpcLogger;
}

async function executeQuery<T>(
  dependencies: TaskLogObservabilityIpcDependencies,
  operation: string,
  query: () => Promise<T>
): Promise<IpcResult<T>> {
  try {
    return { success: true, data: await query() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    dependencies.logger.error(`[teams:${operation}] ${message}`);
    return { success: false, error: message };
  }
}

function validateTaskLocator(
  teamName: unknown,
  taskId: unknown
): { valid: true; teamName: string; taskId: string } | { valid: false; result: IpcResult<never> } {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return {
      valid: false,
      result: { success: false, error: validatedTeamName.error ?? 'Invalid teamName' },
    };
  }

  const validatedTaskId = validateTaskId(taskId);
  if (!validatedTaskId.valid) {
    return {
      valid: false,
      result: { success: false, error: validatedTaskId.error ?? 'Invalid taskId' },
    };
  }

  return {
    valid: true,
    teamName: validatedTeamName.value!,
    taskId: validatedTaskId.value!,
  };
}

export function registerTaskLogObservabilityIpc(
  ipcMain: IpcMain,
  dependencies: TaskLogObservabilityIpcDependencies
): void {
  ipcMain.handle(
    TEAM_GET_TASK_ACTIVITY,
    async (
      _event: IpcMainInvokeEvent,
      teamName: unknown,
      taskId: unknown
    ): Promise<IpcResult<BoardTaskActivityEntry[]>> => {
      const locator = validateTaskLocator(teamName, taskId);
      if (!locator.valid) return locator.result;

      return executeQuery(dependencies, 'getTaskActivity', () =>
        dependencies.readers.activity.getTaskActivity(locator.teamName, locator.taskId)
      );
    }
  );

  ipcMain.handle(
    TEAM_GET_TASK_ACTIVITY_DETAIL,
    async (
      _event: IpcMainInvokeEvent,
      teamName: unknown,
      taskId: unknown,
      activityId: unknown
    ): Promise<IpcResult<BoardTaskActivityDetailResult>> => {
      const locator = validateTaskLocator(teamName, taskId);
      if (!locator.valid) return locator.result;
      if (typeof activityId !== 'string' || activityId.trim().length === 0) {
        return { success: false, error: 'activityId must be a non-empty string' };
      }

      return executeQuery(dependencies, 'getTaskActivityDetail', () =>
        dependencies.readers.activityDetail.getTaskActivityDetail(
          locator.teamName,
          locator.taskId,
          activityId.trim()
        )
      );
    }
  );

  ipcMain.handle(
    TEAM_GET_TASK_LOG_STREAM_SUMMARY,
    async (
      _event: IpcMainInvokeEvent,
      teamName: unknown,
      taskId: unknown
    ): Promise<IpcResult<BoardTaskLogStreamSummary>> => {
      const locator = validateTaskLocator(teamName, taskId);
      if (!locator.valid) return locator.result;

      return executeQuery(dependencies, 'getTaskLogStreamSummary', () =>
        dependencies.readers.stream.getTaskLogStreamSummary(locator.teamName, locator.taskId)
      );
    }
  );

  ipcMain.handle(
    TEAM_GET_TASK_LOG_STREAM,
    async (
      _event: IpcMainInvokeEvent,
      teamName: unknown,
      taskId: unknown
    ): Promise<IpcResult<BoardTaskLogStreamResponse>> => {
      const locator = validateTaskLocator(teamName, taskId);
      if (!locator.valid) return locator.result;

      return executeQuery(dependencies, 'getTaskLogStream', () =>
        dependencies.readers.stream.getTaskLogStream(locator.teamName, locator.taskId)
      );
    }
  );

  ipcMain.handle(
    TEAM_GET_TASK_EXACT_LOG_SUMMARIES,
    async (
      _event: IpcMainInvokeEvent,
      teamName: unknown,
      taskId: unknown
    ): Promise<IpcResult<BoardTaskExactLogSummariesResponse>> => {
      const locator = validateTaskLocator(teamName, taskId);
      if (!locator.valid) return locator.result;

      return executeQuery(dependencies, 'getTaskExactLogSummaries', () =>
        dependencies.readers.exactLogSummaries.getTaskExactLogSummaries(
          locator.teamName,
          locator.taskId
        )
      );
    }
  );

  ipcMain.handle(
    TEAM_GET_TASK_EXACT_LOG_DETAIL,
    async (
      _event: IpcMainInvokeEvent,
      teamName: unknown,
      taskId: unknown,
      exactLogId: unknown,
      expectedSourceGeneration: unknown
    ): Promise<IpcResult<BoardTaskExactLogDetailResult>> => {
      const locator = validateTaskLocator(teamName, taskId);
      if (!locator.valid) return locator.result;
      if (typeof exactLogId !== 'string' || exactLogId.trim().length === 0) {
        return { success: false, error: 'exactLogId must be a non-empty string' };
      }
      if (
        typeof expectedSourceGeneration !== 'string' ||
        expectedSourceGeneration.trim().length === 0
      ) {
        return { success: false, error: 'expectedSourceGeneration must be a non-empty string' };
      }

      return executeQuery(dependencies, 'getTaskExactLogDetail', () =>
        dependencies.readers.exactLogDetail.getTaskExactLogDetail(
          locator.teamName,
          locator.taskId,
          exactLogId.trim(),
          expectedSourceGeneration.trim()
        )
      );
    }
  );
}

export function removeTaskLogObservabilityIpc(ipcMain: IpcMain): void {
  ipcMain.removeHandler(TEAM_GET_TASK_ACTIVITY);
  ipcMain.removeHandler(TEAM_GET_TASK_ACTIVITY_DETAIL);
  ipcMain.removeHandler(TEAM_GET_TASK_LOG_STREAM_SUMMARY);
  ipcMain.removeHandler(TEAM_GET_TASK_LOG_STREAM);
  ipcMain.removeHandler(TEAM_GET_TASK_EXACT_LOG_SUMMARIES);
  ipcMain.removeHandler(TEAM_GET_TASK_EXACT_LOG_DETAIL);
}
