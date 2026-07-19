/**
 * IPC Handlers for CLI Installer Operations.
 *
 * Handlers:
 * - cliInstaller:getStatus: Get current CLI installation status
 * - cliInstaller:install: Start CLI install/update flow
 * - cliInstaller:progress: Progress events (main → renderer, not a handler)
 */

import path from 'node:path';

import {
  CLI_INSTALLER_GET_PROVIDER_STATUS,
  CLI_INSTALLER_GET_STATUS,
  CLI_INSTALLER_INSTALL,
  CLI_INSTALLER_INVALIDATE_STATUS,
  CLI_INSTALLER_VERIFY_PROVIDER_MODELS,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants shared between main and preload
} from '@preload/constants/ipcChannels';
import { CLI_PROVIDER_STATUS_DEFERRED_MESSAGE } from '@shared/types/cliInstaller';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import { CodexBinaryResolver } from '../services/infrastructure/codexAppServer';
import { ClaudeBinaryResolver } from '../services/team/ClaudeBinaryResolver';

import type { CliInstallerService } from '../services';
import type {
  CliInstallationStatus,
  CliInstallerGetStatusOptions,
  CliInstallerProviderStatusMode,
  CliProviderId,
  CliProviderStatus,
  CliProviderStatusRequestOptions,
  IpcResult,
} from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('IPC:cliInstaller');

let service: CliInstallerService;
const statusInFlight = new Map<CliInstallerProviderStatusMode, Promise<CliInstallationStatus>>();
const providerStatusInFlight = new Map<string, Promise<CliProviderStatus | null>>();
const providerRuntimeRequestTails = new Map<CliProviderId, Promise<void>>();
const providerRuntimeRequestQueue: Array<() => void> = [];
let activeProviderRuntimeRequestCount = 0;
const cachedStatus = new Map<
  CliInstallerProviderStatusMode,
  { value: CliInstallationStatus; at: number }
>();
let statusCacheGeneration = 0;
const STATUS_CACHE_TTL_MS = 5_000;
const MAX_PARALLEL_PROVIDER_RUNTIME_REQUESTS = 3;
const PARALLEL_PROVIDER_STATUS_ENV = 'CLAUDE_TEAM_PARALLEL_PROVIDER_STATUS';
const FRONTEND_MULTIMODEL_PROVIDER_IDS = new Set<CliProviderId>(['anthropic', 'codex', 'opencode']);
const INDEPENDENT_PROVIDER_RUNTIME_REQUEST_IDS = new Set<CliProviderId>(['opencode']);
const MAX_PROVIDER_STATUS_PROJECT_PATH_LENGTH = 4_096;

function normalizeProviderStatusOptions(options: unknown): CliProviderStatusRequestOptions {
  if (options === undefined || options === null) {
    return {};
  }
  if (typeof options !== 'object' || Array.isArray(options)) {
    throw new Error('Provider status options must be an object');
  }

  const projectPath = (options as { projectPath?: unknown }).projectPath;
  if (projectPath === undefined || projectPath === null || projectPath === '') {
    return {};
  }
  if (
    typeof projectPath !== 'string' ||
    projectPath.length > MAX_PROVIDER_STATUS_PROJECT_PATH_LENGTH
  ) {
    throw new Error('Provider status project path is invalid');
  }

  const trimmedProjectPath = projectPath.trim();
  if (!trimmedProjectPath) {
    return {};
  }
  if (!path.isAbsolute(trimmedProjectPath)) {
    throw new Error('Provider status project path must be absolute');
  }

  const resolvedProjectPath = path.resolve(trimmedProjectPath);
  if (resolvedProjectPath === path.parse(resolvedProjectPath).root) {
    throw new Error('Provider status project path cannot be a filesystem root');
  }
  return { projectPath: resolvedProjectPath };
}

function getProviderStatusRequestKey(
  providerId: CliProviderId,
  options: CliProviderStatusRequestOptions
): string {
  return `${providerId}\0${options.projectPath ?? ''}`;
}

function isFrontendMultimodelProviderId(providerId: CliProviderId): boolean {
  return FRONTEND_MULTIMODEL_PROVIDER_IDS.has(providerId);
}

function getCachedStatusAuthenticatedProvider(
  providers: CliProviderStatus[]
): CliProviderStatus | null {
  return (
    providers.find(
      (provider) => isFrontendMultimodelProviderId(provider.providerId) && provider.authenticated
    ) ?? null
  );
}

function normalizeGetStatusOptions(options: unknown): Required<CliInstallerGetStatusOptions> {
  if (
    typeof options === 'object' &&
    options !== null &&
    (options as CliInstallerGetStatusOptions).providerStatusMode === 'defer'
  ) {
    return { providerStatusMode: 'defer' };
  }

  return { providerStatusMode: 'full' };
}

function isDeferredProviderStatusSnapshot(status: CliInstallationStatus): boolean {
  return (
    status.flavor === 'agent_teams_orchestrator' &&
    status.providers.length > 0 &&
    status.providers.every(
      (provider) =>
        provider.supported === false &&
        provider.authenticated === false &&
        provider.verificationState === 'unknown' &&
        provider.statusMessage === CLI_PROVIDER_STATUS_DEFERRED_MESSAGE
    )
  );
}

function hasDeferredProviderStatus(status: CliInstallationStatus): boolean {
  return (
    status.flavor === 'agent_teams_orchestrator' &&
    status.providers.some(
      (provider) => provider.statusMessage === CLI_PROVIDER_STATUS_DEFERRED_MESSAGE
    )
  );
}

function canUseStatusForCacheKey(
  cacheKey: CliInstallerProviderStatusMode,
  status: CliInstallationStatus
): boolean {
  if (cacheKey === 'defer') {
    return true;
  }

  return (
    !status.authStatusChecking &&
    !hasDeferredProviderStatus(status) &&
    !isDeferredProviderStatusSnapshot(status)
  );
}

function resetProviderRuntimeRequestLimiter(): void {
  if (activeProviderRuntimeRequestCount === 0 && providerRuntimeRequestQueue.length === 0) {
    providerRuntimeRequestTails.clear();
  }
}

function getProviderRuntimeRequestLimit(): number {
  return process.env[PARALLEL_PROVIDER_STATUS_ENV] === '1'
    ? MAX_PARALLEL_PROVIDER_RUNTIME_REQUESTS
    : 1;
}

function acquireProviderRuntimeRequestSlot(): Promise<void> {
  if (activeProviderRuntimeRequestCount < getProviderRuntimeRequestLimit()) {
    activeProviderRuntimeRequestCount += 1;
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    providerRuntimeRequestQueue.push(() => {
      activeProviderRuntimeRequestCount += 1;
      resolve();
    });
  });
}

function releaseProviderRuntimeRequestSlot(): void {
  activeProviderRuntimeRequestCount = Math.max(0, activeProviderRuntimeRequestCount - 1);
  const next = providerRuntimeRequestQueue.shift();
  if (next) {
    next();
  }
}

async function runWithProviderRuntimeSlot<T>(operation: () => Promise<T>): Promise<T> {
  await acquireProviderRuntimeRequestSlot();
  try {
    return await operation();
  } finally {
    releaseProviderRuntimeRequestSlot();
  }
}

function runProviderRuntimeRequest<T>(
  providerId: CliProviderId,
  operation: () => Promise<T>
): Promise<T> {
  const previousProviderRequest = providerRuntimeRequestTails.get(providerId) ?? Promise.resolve();
  const runOperation = (): Promise<T> =>
    INDEPENDENT_PROVIDER_RUNTIME_REQUEST_IDS.has(providerId)
      ? operation()
      : runWithProviderRuntimeSlot(operation);
  const request = previousProviderRequest.then(
    () => runOperation(),
    () => runOperation()
  );
  const tail = request.then(
    () => undefined,
    () => undefined
  );

  providerRuntimeRequestTails.set(providerId, tail);
  void tail.finally(() => {
    if (providerRuntimeRequestTails.get(providerId) === tail) {
      providerRuntimeRequestTails.delete(providerId);
    }
  });

  return request;
}

/**
 * Initializes CLI installer handlers with the service instance.
 */
export function initializeCliInstallerHandlers(installerService: CliInstallerService): void {
  service = installerService;
  resetProviderRuntimeRequestLimiter();
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
  _event: IpcMainInvokeEvent,
  options?: CliInstallerGetStatusOptions
): Promise<IpcResult<CliInstallationStatus>> {
  try {
    const normalizedOptions = normalizeGetStatusOptions(options);
    const cacheKey = normalizedOptions.providerStatusMode;
    const latestSnapshot = service.getLatestStatusSnapshot();
    const cached = cachedStatus.get(cacheKey);
    if (cached && Date.now() - cached.at < STATUS_CACHE_TTL_MS) {
      if (latestSnapshot && canUseStatusForCacheKey(cacheKey, latestSnapshot)) {
        cachedStatus.set(cacheKey, { value: latestSnapshot, at: Date.now() });
        return { success: true, data: latestSnapshot };
      }
      return { success: true, data: cached.value };
    }

    if (!statusInFlight.has(cacheKey)) {
      const startedAt = Date.now();
      const generation = statusCacheGeneration;
      const request = service
        .getStatus(normalizedOptions)
        .then((status) => {
          if (generation === statusCacheGeneration && canUseStatusForCacheKey(cacheKey, status)) {
            cachedStatus.set(cacheKey, { value: status, at: Date.now() });
          }
          return status;
        })
        .catch((err) => {
          if (generation === statusCacheGeneration) {
            cachedStatus.delete(cacheKey);
          }
          throw err;
        })
        .finally(() => {
          const ms = Date.now() - startedAt;
          if (ms >= 2000) {
            logger.warn(`cliInstaller:getStatus slow ms=${ms}`);
          }
          if (statusInFlight.get(cacheKey) === request) {
            statusInFlight.delete(cacheKey);
          }
        });
      statusInFlight.set(cacheKey, request);
    }

    const status = await statusInFlight.get(cacheKey)!;
    return { success: true, data: status };
  } catch (error) {
    const msg = getErrorMessage(error);
    logger.error('Error in cliInstaller:getStatus:', msg);
    return { success: false, error: msg };
  }
}

function patchCachedProviderStatus(providerStatus: CliProviderStatus | null): void {
  if (!providerStatus) {
    return;
  }

  for (const [cacheKey, cached] of cachedStatus) {
    if (
      cached.value.flavor === 'agent_teams_orchestrator' &&
      !isFrontendMultimodelProviderId(providerStatus.providerId)
    ) {
      continue;
    }

    const hasProvider = cached.value.providers.some(
      (provider) => provider.providerId === providerStatus.providerId
    );
    const nextProviders = hasProvider
      ? cached.value.providers.map((provider) =>
          provider.providerId === providerStatus.providerId ? providerStatus : provider
        )
      : [...cached.value.providers, providerStatus];
    const authenticatedProvider =
      cached.value.flavor === 'agent_teams_orchestrator'
        ? getCachedStatusAuthenticatedProvider(nextProviders)
        : (nextProviders.find((provider) => provider.authenticated) ?? null);

    cachedStatus.set(cacheKey, {
      value: {
        ...cached.value,
        providers: nextProviders,
        authLoggedIn:
          cached.value.flavor === 'agent_teams_orchestrator'
            ? authenticatedProvider !== null
            : nextProviders.some((provider) => provider.authenticated),
        authMethod: authenticatedProvider?.authMethod ?? null,
      },
      at: Date.now(),
    });
  }
}

async function handleGetProviderStatus(
  _event: IpcMainInvokeEvent,
  providerId: CliProviderId,
  rawOptions?: unknown
): Promise<IpcResult<CliProviderStatus | null>> {
  try {
    const options = normalizeProviderStatusOptions(rawOptions);
    const requestKey = getProviderStatusRequestKey(providerId, options);
    const inFlight = providerStatusInFlight.get(requestKey);
    if (inFlight) {
      const status = await inFlight;
      return { success: true, data: status };
    }

    const generation = statusCacheGeneration;
    const currentService = service;
    const request = runProviderRuntimeRequest(providerId, () =>
      currentService.getProviderStatus(providerId, options)
    )
      .then((status) => {
        if (generation === statusCacheGeneration) {
          patchCachedProviderStatus(status);
        }
        return status;
      })
      .finally(() => {
        if (providerStatusInFlight.get(requestKey) === request) {
          providerStatusInFlight.delete(requestKey);
        }
      });

    providerStatusInFlight.set(requestKey, request);
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
    const generation = statusCacheGeneration;
    const currentService = service;
    const status = await runProviderRuntimeRequest(providerId, () =>
      currentService.verifyProviderModels(providerId)
    );
    if (generation === statusCacheGeneration) {
      patchCachedProviderStatus(status);
    }
    return { success: true, data: status };
  } catch (error) {
    const msg = getErrorMessage(error);
    logger.error(`Error in cliInstaller:verifyProviderModels(${providerId}):`, msg);
    return { success: false, error: msg };
  }
}

function handleInvalidateStatus(_event: IpcMainInvokeEvent): IpcResult<void> {
  statusCacheGeneration += 1;
  cachedStatus.clear();
  statusInFlight.clear();
  providerStatusInFlight.clear();
  ClaudeBinaryResolver.clearCache();
  CodexBinaryResolver.clearCache();
  service.invalidateStatusCache();
  return { success: true, data: undefined };
}
