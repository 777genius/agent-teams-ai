/**
 * IPC handlers for scheduled tasks.
 *
 * Pattern: initializeScheduleHandlers(service) → registerScheduleHandlers(ipcMain)
 *          → removeScheduleHandlers(ipcMain)
 */

import {
  SCHEDULE_CREATE,
  SCHEDULE_DELETE,
  SCHEDULE_GET,
  SCHEDULE_GET_RUN_LOGS,
  SCHEDULE_GET_RUNS,
  SCHEDULE_LIST,
  SCHEDULE_PAUSE,
  SCHEDULE_RESUME,
  SCHEDULE_TRIGGER_NOW,
  SCHEDULE_UPDATE,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants are shared between main and preload by design
} from '@preload/constants/ipcChannels';
import { createLogger } from '@shared/utils/logger';

import type { SchedulerService } from '../services/schedule/SchedulerService';
import type {
  CreateScheduleInput,
  IpcResult,
  Schedule,
  ScheduleRun,
  UpdateSchedulePatch,
} from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('IPC:schedule');

let schedulerService: SchedulerService | null = null;

function getService(): SchedulerService {
  if (!schedulerService) {
    throw new Error('SchedulerService not initialized');
  }
  return schedulerService;
}

async function wrapScheduleHandler<T>(
  operation: string,
  handler: () => Promise<T>
): Promise<IpcResult<T>> {
  try {
    const data = await handler();
    return { success: true, data };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`[schedule:${operation}] ${message}`);
    return { success: false, error: message };
  }
}

// =============================================================================
// Handlers
// =============================================================================

async function handleList(_event: IpcMainInvokeEvent): Promise<IpcResult<Schedule[]>> {
  return wrapScheduleHandler('list', () => getService().listSchedules());
}

async function handleGet(
  _event: IpcMainInvokeEvent,
  id: unknown
): Promise<IpcResult<Schedule | null>> {
  if (typeof id !== 'string' || !id.trim()) {
    return { success: false, error: 'id must be a non-empty string' };
  }
  return wrapScheduleHandler('get', () => getService().getSchedule(id));
}

async function handleCreate(
  _event: IpcMainInvokeEvent,
  input: unknown
): Promise<IpcResult<Schedule>> {
  if (!input || typeof input !== 'object') {
    return { success: false, error: 'input must be an object' };
  }
  const inp = input as CreateScheduleInput;
  if (!inp.teamName || !inp.cronExpression || !inp.timezone || !inp.launchConfig) {
    return {
      success: false,
      error: 'Missing required fields: teamName, cronExpression, timezone, launchConfig',
    };
  }
  if (!inp.launchConfig.cwd || !inp.launchConfig.prompt) {
    return { success: false, error: 'launchConfig requires cwd and prompt' };
  }
  return wrapScheduleHandler('create', () => getService().createSchedule(inp));
}

async function handleUpdate(
  _event: IpcMainInvokeEvent,
  id: unknown,
  patch: unknown
): Promise<IpcResult<Schedule>> {
  if (typeof id !== 'string' || !id.trim()) {
    return { success: false, error: 'id must be a non-empty string' };
  }
  if (!patch || typeof patch !== 'object') {
    return { success: false, error: 'patch must be an object' };
  }
  return wrapScheduleHandler('update', () =>
    getService().updateSchedule(id, patch as UpdateSchedulePatch)
  );
}

async function handleDelete(_event: IpcMainInvokeEvent, id: unknown): Promise<IpcResult<void>> {
  if (typeof id !== 'string' || !id.trim()) {
    return { success: false, error: 'id must be a non-empty string' };
  }
  return wrapScheduleHandler('delete', () => getService().deleteSchedule(id));
}

async function handlePause(_event: IpcMainInvokeEvent, id: unknown): Promise<IpcResult<void>> {
  if (typeof id !== 'string' || !id.trim()) {
    return { success: false, error: 'id must be a non-empty string' };
  }
  return wrapScheduleHandler('pause', () => getService().pauseSchedule(id));
}

async function handleResume(_event: IpcMainInvokeEvent, id: unknown): Promise<IpcResult<void>> {
  if (typeof id !== 'string' || !id.trim()) {
    return { success: false, error: 'id must be a non-empty string' };
  }
  return wrapScheduleHandler('resume', () => getService().resumeSchedule(id));
}

async function handleTriggerNow(
  _event: IpcMainInvokeEvent,
  id: unknown
): Promise<IpcResult<ScheduleRun>> {
  if (typeof id !== 'string' || !id.trim()) {
    return { success: false, error: 'id must be a non-empty string' };
  }
  return wrapScheduleHandler('triggerNow', () => getService().triggerNow(id));
}

async function handleGetRuns(
  _event: IpcMainInvokeEvent,
  scheduleId: unknown,
  opts?: unknown
): Promise<IpcResult<ScheduleRun[]>> {
  if (typeof scheduleId !== 'string' || !scheduleId.trim()) {
    return { success: false, error: 'scheduleId must be a non-empty string' };
  }
  const parsedOpts =
    opts && typeof opts === 'object' ? (opts as { limit?: number; offset?: number }) : undefined;
  return wrapScheduleHandler('getRuns', () => getService().getRuns(scheduleId, parsedOpts));
}

async function handleGetRunLogs(
  _event: IpcMainInvokeEvent,
  scheduleId: unknown,
  runId: unknown
): Promise<IpcResult<{ stdout: string; stderr: string }>> {
  if (typeof scheduleId !== 'string' || !scheduleId.trim()) {
    return { success: false, error: 'scheduleId must be a non-empty string' };
  }
  if (typeof runId !== 'string' || !runId.trim()) {
    return { success: false, error: 'runId must be a non-empty string' };
  }
  return wrapScheduleHandler('getRunLogs', () => getService().getRunLogs(scheduleId, runId));
}

// =============================================================================
// Lifecycle
// =============================================================================

export function initializeScheduleHandlers(service: SchedulerService): void {
  schedulerService = service;
}

export function registerScheduleHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(SCHEDULE_LIST, handleList);
  ipcMain.handle(SCHEDULE_GET, handleGet);
  ipcMain.handle(SCHEDULE_CREATE, handleCreate);
  ipcMain.handle(SCHEDULE_UPDATE, handleUpdate);
  ipcMain.handle(SCHEDULE_DELETE, handleDelete);
  ipcMain.handle(SCHEDULE_PAUSE, handlePause);
  ipcMain.handle(SCHEDULE_RESUME, handleResume);
  ipcMain.handle(SCHEDULE_TRIGGER_NOW, handleTriggerNow);
  ipcMain.handle(SCHEDULE_GET_RUNS, handleGetRuns);
  ipcMain.handle(SCHEDULE_GET_RUN_LOGS, handleGetRunLogs);
  logger.info('Schedule handlers registered');
}

export function removeScheduleHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(SCHEDULE_LIST);
  ipcMain.removeHandler(SCHEDULE_GET);
  ipcMain.removeHandler(SCHEDULE_CREATE);
  ipcMain.removeHandler(SCHEDULE_UPDATE);
  ipcMain.removeHandler(SCHEDULE_DELETE);
  ipcMain.removeHandler(SCHEDULE_PAUSE);
  ipcMain.removeHandler(SCHEDULE_RESUME);
  ipcMain.removeHandler(SCHEDULE_TRIGGER_NOW);
  ipcMain.removeHandler(SCHEDULE_GET_RUNS);
  ipcMain.removeHandler(SCHEDULE_GET_RUN_LOGS);
  logger.info('Schedule handlers removed');
}
