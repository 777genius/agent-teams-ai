/**
 * IPC Handlers for CLI Installer Operations.
 *
 * Handlers:
 * - cliInstaller:getStatus: Get current CLI installation status
 * - cliInstaller:install: Start CLI install/update flow
 * - cliInstaller:progress: Progress events (main → renderer, not a handler)
 */

import { randomUUID } from 'node:crypto';

import {
  CLI_INSTALLER_GET_PROVIDER_STATUS,
  CLI_INSTALLER_GET_STATUS,
  CLI_INSTALLER_INSTALL,
  CLI_INSTALLER_INVALIDATE_STATUS,
  CLI_INSTALLER_VERIFY_PROVIDER_MODELS,
  // eslint-disable-next-line boundaries/element-types -- IPC channel constants shared between main and preload
} from '@preload/constants/ipcChannels';
import {
  CLI_PROVIDER_STATUS_DEFERRED_MESSAGE,
  parseCliProviderStatusIpcRequest,
} from '@shared/types/cliInstaller';
import {
  getCliProviderCatalogAuthorityFingerprint,
  getCliProviderProfileAuthorityFingerprint,
  isCliProviderAuthorityProjectRoot,
  normalizeCliProviderAuthorityProjectPath,
} from '@shared/utils/cliProviderAuthority';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import { CodexBinaryResolver } from '../services/infrastructure/codexAppServer';
import { ClaudeBinaryResolver } from '../services/team/ClaudeBinaryResolver';
import {
  invalidateAuthoritativeModelExecutionProofs,
  invalidateAuthoritativeModelExecutionProofsForProviderCatalog,
  invalidateAuthoritativeModelExecutionProofsForProviderProfile,
} from '../services/team/TeamLaunchExecutionProofAuthority';
import { getAuthorityScope } from '../services/team/TeamLaunchProviderAuthorityGeneration';

import type { CliInstallerService } from '../services';
import type {
  CliInstallationStatus,
  CliInstallerGetStatusOptions,
  CliInstallerProviderStatusMode,
  CliProviderId,
  CliProviderStatus,
  CliProviderStatusIpcRequest,
  CliProviderStatusIpcResponse,
  CliProviderStatusRequestOptions,
  IpcResult,
} from '@shared/types';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';

const logger = createLogger('IPC:cliInstaller');

let service: CliInstallerService;
interface ProviderObservationRequestFence {
  epoch: number;
  order: number;
}

const statusInFlight = new Map<CliInstallerProviderStatusMode, Promise<CliInstallationStatus>>();
interface ProviderStatusObservation {
  providerStatus: CliProviderStatus | null;
  observationGeneration: number;
  observationNonce: string;
  authorityScope: CliProviderStatusIpcResponse['authorityScope'];
}

const providerStatusInFlight = new Map<string, Promise<ProviderStatusObservation>>();
const providerRuntimeRequestTails = new Map<CliProviderId, Promise<void>>();
const providerRuntimeRequestQueue: Array<() => void> = [];
interface ObservedProjectProviderAuthority {
  providerId: CliProviderId;
  profileFingerprint: string;
  catalogFingerprint: string;
}

const observedProviderGlobalAccessFingerprintById = new Map<CliProviderId, string>();
const observedProjectProviderAuthorityByScope = new Map<string, ObservedProjectProviderAuthority>();
const observedProjectlessProviderProfileFingerprintById = new Map<CliProviderId, string>();
const latestCompletedProviderAuthorityOrderById = new Map<CliProviderId, number>();
const latestCompletedProviderCacheOrderById = new Map<CliProviderId, number>();
let activeProviderRuntimeRequestCount = 0;
let providerObservationFenceEpoch = 0;
let nextProviderObservationRequestOrder = 0;
const cachedStatus = new Map<
  CliInstallerProviderStatusMode,
  { value: CliInstallationStatus; at: number }
>();
let statusCacheGeneration = 0;
const STATUS_CACHE_TTL_MS = 5_000;
const MAX_PARALLEL_PROVIDER_RUNTIME_REQUESTS = 3;
const PARALLEL_PROVIDER_STATUS_ENV = 'CLAUDE_TEAM_PARALLEL_PROVIDER_STATUS';
const CLI_PROVIDER_IDS = new Set<unknown>(['anthropic', 'codex', 'gemini', 'opencode']);
const FRONTEND_MULTIMODEL_PROVIDER_IDS = new Set<CliProviderId>(['anthropic', 'codex', 'opencode']);
const INDEPENDENT_PROVIDER_RUNTIME_REQUEST_IDS = new Set<CliProviderId>(['opencode']);
const MAX_PROVIDER_STATUS_PROJECT_PATH_LENGTH = 4_096;
const MAX_OBSERVED_PROJECT_PROVIDER_AUTHORITIES = 128;

function resetProviderObservationRequestFence(): void {
  providerObservationFenceEpoch += 1;
  nextProviderObservationRequestOrder = 0;
  latestCompletedProviderAuthorityOrderById.clear();
  latestCompletedProviderCacheOrderById.clear();
}

function beginProviderObservationRequest(): ProviderObservationRequestFence {
  nextProviderObservationRequestOrder += 1;
  return {
    epoch: providerObservationFenceEpoch,
    order: nextProviderObservationRequestOrder,
  };
}

function claimProviderObservationCompletion(
  providerStatus: CliProviderStatus,
  requestFence: ProviderObservationRequestFence
): boolean {
  if (requestFence.epoch !== providerObservationFenceEpoch) {
    return false;
  }

  const providerId = providerStatus.providerId;
  const latestAuthorityOrder = latestCompletedProviderAuthorityOrderById.get(providerId) ?? 0;
  if (isSemanticProviderAuthorityObservation(providerStatus)) {
    // Catalog/cache-only results cannot suppress an authority observation. Only
    // a newer completed authority observation participates in this dimension.
    if (requestFence.order < latestAuthorityOrder) {
      return false;
    }
    latestCompletedProviderAuthorityOrderById.set(providerId, requestFence.order);
    return true;
  }

  // Every non-authoritative result can mutate cached provider data. Keep those
  // mutations ordered with each other, while a newer authority result also
  // fences older cache data from patching the authority/cache state it established.
  const latestCacheOrder = latestCompletedProviderCacheOrderById.get(providerId) ?? 0;
  if (requestFence.order < latestAuthorityOrder || requestFence.order < latestCacheOrder) {
    return false;
  }
  latestCompletedProviderCacheOrderById.set(providerId, requestFence.order);
  return true;
}

function assertProviderObservationRequestCurrent(
  requestFence: ProviderObservationRequestFence
): void {
  if (requestFence.epoch !== providerObservationFenceEpoch) {
    throw new Error('Provider status observation was invalidated before completion');
  }
}

function clearObservedProviderAuthorities(): void {
  observedProviderGlobalAccessFingerprintById.clear();
  observedProjectProviderAuthorityByScope.clear();
  observedProjectlessProviderProfileFingerprintById.clear();
}

function resetCliInstallerHandlerState(): void {
  statusCacheGeneration += 1;
  resetProviderObservationRequestFence();
  cachedStatus.clear();
  statusInFlight.clear();
  providerStatusInFlight.clear();
  clearObservedProviderAuthorities();
}

function normalizeProviderStatusRequest(request: unknown): CliProviderStatusIpcRequest {
  const candidate = parseCliProviderStatusIpcRequest(request);
  const projectPath = candidate.projectPath;
  if (projectPath === undefined || projectPath === null || projectPath === '') {
    return { purpose: candidate.purpose, requestNonce: candidate.requestNonce };
  }
  if (
    typeof projectPath !== 'string' ||
    projectPath.length > MAX_PROVIDER_STATUS_PROJECT_PATH_LENGTH
  ) {
    throw new Error('Provider status project path is invalid');
  }

  const trimmedProjectPath = projectPath.trim();
  if (!trimmedProjectPath) {
    return { purpose: candidate.purpose, requestNonce: candidate.requestNonce };
  }
  const normalizedProjectPath = normalizeCliProviderAuthorityProjectPath(trimmedProjectPath);
  if (isCliProviderAuthorityProjectRoot(normalizedProjectPath)) {
    throw new Error('Provider status project path cannot be a filesystem root');
  }
  return {
    projectPath: normalizedProjectPath,
    purpose: candidate.purpose,
    requestNonce: candidate.requestNonce,
  };
}

function normalizeProviderId(providerId: unknown): CliProviderId {
  if (!CLI_PROVIDER_IDS.has(providerId)) {
    throw new Error('Provider id is invalid');
  }
  return providerId as CliProviderId;
}

function getProviderStatusRequestKey(
  providerId: CliProviderId,
  request: CliProviderStatusIpcRequest
): string {
  return `${providerId}\0${request.projectPath ?? ''}\0${request.purpose}`;
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
  resetCliInstallerHandlerState();
  service = installerService;
  invalidateAuthoritativeModelExecutionProofs();
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

  invalidateAuthoritativeModelExecutionProofs();
  resetCliInstallerHandlerState();

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
        const requestFence = beginProviderObservationRequest();
        for (const providerStatus of latestSnapshot.providers) {
          if (!claimProviderObservationCompletion(providerStatus, requestFence)) {
            throw new Error(
              `Provider status observation for ${providerStatus.providerId} was superseded before completion`
            );
          }
          observeProviderAuthority(providerStatus, null);
        }
        cachedStatus.set(cacheKey, { value: latestSnapshot, at: Date.now() });
        return { success: true, data: latestSnapshot };
      }
      return { success: true, data: cached.value };
    }

    if (!statusInFlight.has(cacheKey)) {
      const startedAt = Date.now();
      const generation = statusCacheGeneration;
      const requestFence = beginProviderObservationRequest();
      const request = service
        .getStatus(normalizedOptions)
        .then((status) => {
          if (generation !== statusCacheGeneration) {
            // Invalidation revokes this completion's authority to mutate shared
            // observations or caches, but the caller still owns the service result.
            return status;
          }
          assertProviderObservationRequestCurrent(requestFence);
          const supersededProviderIds: CliProviderId[] = [];
          for (const providerStatus of status.providers) {
            if (!claimProviderObservationCompletion(providerStatus, requestFence)) {
              supersededProviderIds.push(providerStatus.providerId);
              continue;
            }
            observeProviderAuthority(providerStatus, null);
          }
          if (supersededProviderIds.length > 0) {
            throw new Error(
              `Provider status observation for ${supersededProviderIds.join(', ')} was superseded before completion`
            );
          }
          if (canUseStatusForCacheKey(cacheKey, status)) {
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
  observeProviderAuthority(providerStatus, null);

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

function isSemanticProviderAuthorityObservation(providerStatus: CliProviderStatus): boolean {
  // Missing legacy outcomes are ambiguous (including deferred/partial service
  // paths), so fail closed instead of inferring semantic authority from fields.
  return providerStatus.statusCheckOutcome === 'authoritative';
}

function getProviderGlobalAccessFingerprint(providerStatus: CliProviderStatus): string {
  return JSON.stringify({
    providerId: providerStatus.providerId,
    supported: providerStatus.supported,
    authenticated: providerStatus.authenticated,
    authMethod: providerStatus.authMethod,
    teamLaunch: providerStatus.capabilities.teamLaunch,
  });
}

function rememberProjectProviderAuthority(
  scopeKey: string,
  observation: ObservedProjectProviderAuthority
): void {
  if (
    !observedProjectProviderAuthorityByScope.has(scopeKey) &&
    observedProjectProviderAuthorityByScope.size >= MAX_OBSERVED_PROJECT_PROVIDER_AUTHORITIES
  ) {
    const oldest = observedProjectProviderAuthorityByScope.entries().next().value as
      | [string, ObservedProjectProviderAuthority]
      | undefined;
    if (oldest) {
      observedProjectProviderAuthorityByScope.delete(oldest[0]);
      // Forgetting a comparison baseline must fail closed for proofs that could
      // otherwise outlive it. A provider-wide bump avoids creating unbounded
      // per-project generation tombstones.
      invalidateAuthoritativeModelExecutionProofsForProviderProfile(oldest[1].providerId);
    }
  }
  observedProjectProviderAuthorityByScope.set(scopeKey, observation);
}

function observeProviderAuthority(
  providerStatus: CliProviderStatus,
  projectPath: string | null
): void {
  if (!isSemanticProviderAuthorityObservation(providerStatus)) return;
  const globalAccessFingerprint = getProviderGlobalAccessFingerprint(providerStatus);
  const previousGlobalAccessFingerprint = observedProviderGlobalAccessFingerprintById.get(
    providerStatus.providerId
  );
  if (
    previousGlobalAccessFingerprint !== undefined &&
    previousGlobalAccessFingerprint !== globalAccessFingerprint
  ) {
    invalidateAuthoritativeModelExecutionProofsForProviderProfile(providerStatus.providerId);
  }
  observedProviderGlobalAccessFingerprintById.set(
    providerStatus.providerId,
    globalAccessFingerprint
  );

  const profileFingerprint = getCliProviderProfileAuthorityFingerprint(providerStatus);
  if (!projectPath) {
    const previousProfileFingerprint = observedProjectlessProviderProfileFingerprintById.get(
      providerStatus.providerId
    );
    if (
      previousProfileFingerprint !== undefined &&
      previousProfileFingerprint !== profileFingerprint
    ) {
      invalidateAuthoritativeModelExecutionProofsForProviderProfile(providerStatus.providerId);
    }
    observedProjectlessProviderProfileFingerprintById.set(
      providerStatus.providerId,
      profileFingerprint
    );
    return;
  }

  const scopeKey = `${providerStatus.providerId}\0${projectPath}`;
  const catalogFingerprint = getCliProviderCatalogAuthorityFingerprint(providerStatus);
  const previousAuthority = observedProjectProviderAuthorityByScope.get(scopeKey);
  if (
    previousAuthority !== undefined &&
    (previousAuthority.profileFingerprint !== profileFingerprint ||
      previousAuthority.catalogFingerprint !== catalogFingerprint)
  ) {
    invalidateAuthoritativeModelExecutionProofsForProviderCatalog(
      providerStatus.providerId,
      projectPath
    );
  }
  rememberProjectProviderAuthority(scopeKey, {
    providerId: providerStatus.providerId,
    profileFingerprint,
    catalogFingerprint,
  });
}

async function handleGetProviderStatus(
  _event: IpcMainInvokeEvent,
  rawProviderId: unknown,
  rawRequest?: unknown
): Promise<IpcResult<CliProviderStatusIpcResponse>> {
  try {
    const providerId = normalizeProviderId(rawProviderId);
    const providerRequest = normalizeProviderStatusRequest(rawRequest);
    const requestKey = getProviderStatusRequestKey(providerId, providerRequest);
    const inFlight = providerStatusInFlight.get(requestKey);
    if (inFlight) {
      const observation = await inFlight;
      if (observation.observationGeneration !== statusCacheGeneration) {
        throw new Error('Provider status observation was invalidated before completion');
      }
      return {
        success: true,
        data: {
          ...observation,
          purpose: providerRequest.purpose,
          requestNonce: providerRequest.requestNonce,
        },
      };
    }

    const generation = statusCacheGeneration;
    const requestFence = beginProviderObservationRequest();
    const currentService = service;
    const serviceOptions: CliProviderStatusRequestOptions = providerRequest.projectPath
      ? { projectPath: providerRequest.projectPath }
      : {};
    const observationNonce = randomUUID();
    const observationPromise = runProviderRuntimeRequest(providerId, () =>
      currentService.getProviderStatus(providerId, serviceOptions)
    )
      .then((status) => {
        if (generation !== statusCacheGeneration) {
          throw new Error('Provider status observation was invalidated before completion');
        }
        assertProviderObservationRequestCurrent(requestFence);
        if (status && !claimProviderObservationCompletion(status, requestFence)) {
          throw new Error(
            `Provider status observation for ${providerId} was superseded before completion`
          );
        }
        if (status) {
          observeProviderAuthority(status, serviceOptions.projectPath ?? null);
          if (!serviceOptions.projectPath) patchCachedProviderStatus(status);
        }
        return {
          providerStatus: status,
          observationGeneration: generation,
          observationNonce,
          authorityScope:
            providerRequest.purpose === 'launch-proof' &&
            serviceOptions.projectPath &&
            status?.statusCheckOutcome === 'authoritative'
              ? getAuthorityScope(providerId, serviceOptions.projectPath)
              : null,
        };
      })
      .finally(() => {
        if (providerStatusInFlight.get(requestKey) === observationPromise) {
          providerStatusInFlight.delete(requestKey);
        }
      });

    providerStatusInFlight.set(requestKey, observationPromise);
    const observation = await observationPromise;
    if (observation.observationGeneration !== statusCacheGeneration) {
      throw new Error('Provider status observation was invalidated before completion');
    }
    return {
      success: true,
      data: {
        ...observation,
        purpose: providerRequest.purpose,
        requestNonce: providerRequest.requestNonce,
      },
    };
  } catch (error) {
    const msg = getErrorMessage(error);
    logger.error(`Error in cliInstaller:getProviderStatus(${String(rawProviderId)}):`, msg);
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
  rawProviderId: unknown
): Promise<IpcResult<CliProviderStatus | null>> {
  try {
    const providerId = normalizeProviderId(rawProviderId);
    const generation = statusCacheGeneration;
    const requestFence = beginProviderObservationRequest();
    const currentService = service;
    const status = await runProviderRuntimeRequest(providerId, () =>
      currentService.verifyProviderModels(providerId)
    );
    if (generation !== statusCacheGeneration) {
      // Preserve the response contract for work that already started while
      // suppressing every stale cache and authority side effect below.
      return { success: true, data: status };
    }
    assertProviderObservationRequestCurrent(requestFence);
    if (status && !claimProviderObservationCompletion(status, requestFence)) {
      throw new Error(
        `Provider model observation for ${providerId} was superseded before completion`
      );
    }
    if (status) {
      observeProviderAuthority(status, null);
      patchCachedProviderStatus(status);
    }
    return { success: true, data: status };
  } catch (error) {
    const msg = getErrorMessage(error);
    logger.error(`Error in cliInstaller:verifyProviderModels(${String(rawProviderId)}):`, msg);
    return { success: false, error: msg };
  }
}

function handleInvalidateStatus(_event: IpcMainInvokeEvent): IpcResult<void> {
  invalidateAuthoritativeModelExecutionProofs();
  resetCliInstallerHandlerState();
  ClaudeBinaryResolver.clearCache();
  CodexBinaryResolver.clearCache();
  service.invalidateStatusCache();
  return { success: true, data: undefined };
}
