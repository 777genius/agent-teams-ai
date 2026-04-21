/**
 * IPC Handlers for CLI Installer Operations.
 *
 * Handlers:
 * - cliInstaller:getStatus: Get current CLI installation status
 * - cliInstaller:install: Start CLI install/update flow
 * - cliInstaller:progress: Progress events (main → renderer, not a handler)
 */

import {
  CLI_INSTALLER_GET_PROVIDER_STATUS,
  CLI_INSTALLER_GET_STATUS,
  CLI_INSTALLER_INSTALL,
  CLI_INSTALLER_INVALIDATE_STATUS,
  CLI_INSTALLER_VERIFY_PROVIDER_MODELS,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants shared between main and preload
} from '@preload/constants/ipcChannels';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import { ClaudeBinaryResolver } from '../services/team/ClaudeBinaryResolver';

import type { CliInstallerService } from '../services';
import type {
  CliInstallationStatus,
  CliProviderId,
  CliProviderStatus,
  IpcResult,
} from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('IPC:cliInstaller');

let service: CliInstallerService;
let statusInFlight: Promise<CliInstallationStatus> | null = null;
const providerStatusInFlight = new Map<CliProviderId, Promise<CliProviderStatus | null>>();
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
  ipcMain.handle(CLI_INSTALLER_GET_PROVIDER_STATUS, handleGetProviderStatus);
  ipcMain.handle(CLI_INSTALLER_VERIFY_PROVIDER_MODELS, handleVerifyProviderModels);
  ipcMain.handle(CLI_INSTALLER_INSTALL, handleInstall);
  ipcMain.handle(CLI_INSTALLER_INVALIDATE_STATUS, handleInvalidateStatus);

  logger.info('CLI installer handlers registered');
}

/**
 * Removes all CLI installer IPC handlers.
 */
export function removeCliInstallerHandlers(ipcMain: IpcMain): void {
  ipcMain.removeHandler(CLI_INSTALLER_GET_STATUS);
  ipcMain.removeHandler(CLI_INSTALLER_GET_PROVIDER_STATUS);
  ipcMain.removeHandler(CLI_INSTALLER_VERIFY_PROVIDER_MODELS);
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
    const latestSnapshot = service.getLatestStatusSnapshot();
    if (cachedStatus && Date.now() - cachedStatus.at < STATUS_CACHE_TTL_MS) {
      if (latestSnapshot) {
        cachedStatus = { value: latestSnapshot, at: Date.now() };
        return { success: true, data: latestSnapshot };
      }
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

function patchCachedProviderStatus(providerStatus: CliProviderStatus | null): void {
  if (!cachedStatus || !providerStatus) {
    return;
  }

  const hasProvider = cachedStatus.value.providers.some(
    (provider) => provider.providerId === providerStatus.providerId
  );
  const nextProviders = hasProvider
    ? cachedStatus.value.providers.map((provider) =>
        provider.providerId === providerStatus.providerId ? providerStatus : provider
      )
    : [...cachedStatus.value.providers, providerStatus];
  const authenticatedProvider = nextProviders.find((provider) => provider.authenticated) ?? null;

  cachedStatus = {
    value: {
      ...cachedStatus.value,
      providers: nextProviders,
      authLoggedIn: nextProviders.some((provider) => provider.authenticated),
      authMethod: authenticatedProvider?.authMethod ?? null,
    },
    at: Date.now(),
  };
}

async function handleGetProviderStatus(
  _event: IpcMainInvokeEvent,
  providerId: CliProviderId
): Promise<IpcResult<CliProviderStatus | null>> {
  try {
    const inFlight = providerStatusInFlight.get(providerId);
    if (inFlight) {
      const status = await inFlight;
      return { success: true, data: status };
    }

    const request = service
      .getProviderStatus(providerId)
      .then((status) => {
        patchCachedProviderStatus(status);
        return status;
      })
      .finally(() => {
        providerStatusInFlight.delete(providerId);
      });

    providerStatusInFlight.set(providerId, request);
    const status = await request;
    return { success: true, data: status };
  } catch (error) {
    const msg = getErrorMessage(error);
    logger.error(`Error in cliInstaller:getProviderStatus(${providerId}):`, msg);
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

async function handleVerifyProviderModels(
  _event: IpcMainInvokeEvent,
  providerId: CliProviderId
): Promise<IpcResult<CliProviderStatus | null>> {
  try {
    const status = await service.verifyProviderModels(providerId);
    patchCachedProviderStatus(status);
    return { success: true, data: status };
  } catch (error) {
    const msg = getErrorMessage(error);
    logger.error(`Error in cliInstaller:verifyProviderModels(${providerId}):`, msg);
    return { success: false, error: msg };
  }
}

function handleInvalidateStatus(_event: IpcMainInvokeEvent): IpcResult<void> {
  cachedStatus = null;
  providerStatusInFlight.clear();
  ClaudeBinaryResolver.clearCache();
  service.invalidateStatusCache();
  return { success: true, data: undefined };
}
