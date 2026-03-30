/**
 * IPC Handlers for CLI Installer Operations.
 *
 * Handlers:
 * - cliInstaller:getStatus: Get current CLI installation status
 * - cliInstaller:install: Start CLI install/update flow
 * - cliInstaller:progress: Progress events (main → renderer, not a handler)
 */

import {
  CLI_INSTALLER_GET_STATUS,
  CLI_INSTALLER_INSTALL,
  CLI_INSTALLER_INVALIDATE_STATUS,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants shared between main and preload
} from '@preload/constants/ipcChannels';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import type { CliInstallerService } from '../services';
import type { CliInstallationStatus, IpcResult } from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('IPC:cliInstaller');

let service: CliInstallerService;
let statusInFlight: Promise<CliInstallationStatus> | null = null;
let cachedStatus: { value: CliInstallationStatus; at: number } | null = null;
const STATUS_CACHE_TTL_MS = 5_000;

/**
 * Initializes CLI installer handlers with the service instance.
 */
export function initializeCliInstallerHandlers(installerService: CliInstallerService): void {
  service = installerService;
}

/**
 * Registers all CLI installer IPC handlers.
 */
export function registerCliInstallerHandlers(ipcMain: IpcMain): void {
  ipcMain.handle(CLI_INSTALLER_GET_STATUS, handleGetStatus);
  ipcMain.handle(CLI_INSTALLER_INSTALL, handleInstall);
  ipcMain.handle(CLI_INSTALLER_INVALIDATE_STATUS, handleInvalidateStatus);

  logger.info('CLI installer handlers registered');
}

/**
 * Removes all CLI installer IPC handlers.
 */
export function removeCliInstallerHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(CLI_INSTALLER_GET_STATUS);
  ipcMain.removeHandler(CLI_INSTALLER_INSTALL);
  ipcMain.removeHandler(CLI_INSTALLER_INVALIDATE_STATUS);

  logger.info('CLI installer handlers removed');
}

// =============================================================================
// Handler Implementations
// =============================================================================

async function handleGetStatus(
  _event: IpcMainInvokeEvent
): Promise<IpcResult<CliInstallationStatus>> {
  try {
    if (cachedStatus && Date.now() - cachedStatus.at < STATUS_CACHE_TTL_MS) {
      return { success: true, data: cachedStatus.value };
    }

    if (!statusInFlight) {
      const startedAt = Date.now();
      statusInFlight = service
        .getStatus()
        .then((status) => {
          cachedStatus = { value: status, at: Date.now() };
          return status;
        })
        .catch((err) => {
          cachedStatus = null;
          throw err;
        })
        .finally(() => {
          const ms = Date.now() - startedAt;
          if (ms >= 2000) {
            logger.warn(`cliInstaller:getStatus slow ms=${ms}`);
          }
          statusInFlight = null;
        });
    }

    const status = await statusInFlight;
    return { success: true, data: status };
  } catch (error) {
    const msg = getErrorMessage(error);
    logger.error('Error in cliInstaller:getStatus:', msg);
    return { success: false, error: msg };
  }
}

async function handleInstall(_event: IpcMainInvokeEvent): Promise<IpcResult<void>> {
  try {
    await service.install();
    return { success: true, data: undefined };
  } catch (error) {
    const msg = getErrorMessage(error);
    logger.error('Error in cliInstaller:install:', msg);
    return { success: false, error: msg };
  }
}

function handleInvalidateStatus(_event: IpcMainInvokeEvent): IpcResult<void> {
  cachedStatus = null;
  return { success: true, data: undefined };
}
