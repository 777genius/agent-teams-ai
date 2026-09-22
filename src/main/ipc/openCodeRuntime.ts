import {
  OPENCODE_RUNTIME_GET_STATUS,
  OPENCODE_RUNTIME_INSTALL,
  OPENCODE_RUNTIME_INVALIDATE_STATUS,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants shared between main and preload
} from '@preload/constants/ipcChannels';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import type { OpenCodeRuntimeInstallerService } from '../services';
import type { IpcResult, OpenCodeRuntimeStatus } from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('IPC:openCodeRuntime');

let service: OpenCodeRuntimeInstallerService | null = null;

export function initializeOpenCodeRuntimeHandlers(
  openCodeRuntimeService: OpenCodeRuntimeInstallerService
): void {
  service = openCodeRuntimeService;
}

export function registerOpenCodeRuntimeHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(OPENCODE_RUNTIME_GET_STATUS, handleGetStatus);
  ipcMain.handle(OPENCODE_RUNTIME_INSTALL, handleInstall);
  ipcMain.handle(OPENCODE_RUNTIME_INVALIDATE_STATUS, handleInvalidateStatus);
  logger.info('OpenCode runtime handlers registered');
}

export function removeOpenCodeRuntimeHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(OPENCODE_RUNTIME_GET_STATUS);
  ipcMain.removeHandler(OPENCODE_RUNTIME_INSTALL);
  ipcMain.removeHandler(OPENCODE_RUNTIME_INVALIDATE_STATUS);
  logger.info('OpenCode runtime handlers removed');
}

function requireService(): OpenCodeRuntimeInstallerService {
  if (!service) {
    throw new Error('OpenCode runtime installer service is not initialized');
  }
  return service;
}

async function handleGetStatus(
  _event: IpcMainInvokeEvent
): Promise<IpcResult<OpenCodeRuntimeStatus>> {
  try {
    return { success: true, data: await requireService().getStatus() };
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error('Error in openCodeRuntime:getStatus:', message);
    return { success: false, error: message };
  }
}

async function handleInstall(
  _event: IpcMainInvokeEvent
): Promise<IpcResult<OpenCodeRuntimeStatus>> {
  try {
    return { success: true, data: await requireService().install() };
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error('Error in openCodeRuntime:install:', message);
    return { success: false, error: message };
  }
}

function handleInvalidateStatus(_event: IpcMainInvokeEvent): IpcResult<void> {
  try {
    requireService().invalidateStatusCache();
    return { success: true, data: undefined };
  } catch (error) {
    const message = getErrorMessage(error);
    logger.error('Error in openCodeRuntime:invalidateStatus:', message);
    return { success: false, error: message };
  }
}
