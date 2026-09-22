/**
 * IPC Handlers for Update Operations.
 *
 * Handlers:
 * - updater:check: Check for available updates
 * - updater:download: Download the available update
 * - updater:install: Quit and install the downloaded update
 */

import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import { type IpcMain, type IpcMainInvokeEvent } from 'electron';

import type { UpdaterService } from '../services';

const logger = createLogger('IPC:updater');

let updaterService: UpdaterService;

/**
 * Initializes updater handlers with the service instance.
 */
export function initializeUpdaterHandlers(service: UpdaterService): void {
  updaterService = service;
}

/**
 * Registers all updater-related IPC handlers.
 */
export function registerUpdaterHandlers(ipcMain: IpcMain): void {
  ipcMain.handle('updater:check', handleCheck);
  ipcMain.handle('updater:download', handleDownload);
  ipcMain.handle('updater:install', handleInstall);

  logger.info('Updater handlers registered');
}

/**
 * Removes all updater IPC handlers.
 */
export function removeUpdaterHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler('updater:check');
  ipcMain.removeHandler('updater:download');
  ipcMain.removeHandler('updater:install');

  logger.info('Updater handlers removed');
}

// =============================================================================
// Handler Implementations
// =============================================================================

async function handleCheck(_event: IpcMainInvokeEvent): Promise<void> {
  try {
    await updaterService.checkForUpdates();
  } catch (error) {
    logger.error('Error in updater:check:', getErrorMessage(error));
  }
}

async function handleDownload(_event: IpcMainInvokeEvent): Promise<void> {
  try {
    await updaterService.downloadUpdate();
  } catch (error) {
    logger.error('Error in updater:download:', getErrorMessage(error));
  }
}

async function handleInstall(_event: IpcMainInvokeEvent): Promise<void> {
  try {
    await updaterService.quitAndInstall();
  } catch (error) {
    logger.error('Error in updater:install:', getErrorMessage(error));
  }
}
