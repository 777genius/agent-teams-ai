/**
 * CLI Installer slice — manages CLI installation status and install/update progress.
 */

import {
  classifyAnalyticsError,
  elapsedMsSince,
  recordProviderConnectionEnd,
  recordRuntimeInstallEnd,
} from '@renderer/analytics/productAnalytics';
import { api } from '@renderer/api';
import { isGeminiUiFrozen } from '@renderer/utils/geminiUiFreeze';
import {
  CLI_PROVIDER_STATUS_DEFERRED_MESSAGE,
  CLI_PROVIDER_STATUS_UNAVAILABLE_MESSAGE,
} from '@shared/types/cliInstaller';
import { createLogger } from '@shared/utils/logger';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';

import type { AppState } from '../types';
import type { CodexRuntimeStatus } from '@features/codex-runtime-installer/contracts';
import type {
  CliInstallationStatus,
  CliProviderId,
  CliProviderStatus,
  OpenCodeRuntimeStatus,
} from '@shared/types';
import type { StateCreator } from 'zustand';

const logger = createLogger('Store:cliInstaller');

/** Max log lines to keep in UI (reserved for future use) */
const _MAX_LOG_LINES = 50;
const OPENCODE_PROVIDER_INSTALL_REFRESH_ATTEMPTS = 3;
const OPENCODE_PROVIDER_INSTALL_REFRESH_RETRY_DELAY_MS = 700;
const CODEX_PROVIDER_INSTALL_REFRESH_ATTEMPTS = 3;
const CODEX_PROVIDER_INSTALL_REFRESH_RETRY_DELAY_MS = 700;
const CODEX_CATALOG_LOADING_REFRESH_ATTEMPTS = 3;
const CODEX_CATALOG_LOADING_REFRESH_RETRY_DELAY_MS = 2_000;

export const MULTIMODEL_PROVIDER_IDS: CliProviderId[] = isGeminiUiFrozen()
  ? ['anthropic', 'codex', 'opencode']
  : ['anthropic', 'codex', 'gemini', 'opencode'];
const MULTIMODEL_PROVIDER_ID_SET = new Set<CliProviderId>(MULTIMODEL_PROVIDER_IDS);

function isActiveMultimodelProviderId(providerId: CliProviderId): boolean {
  return MULTIMODEL_PROVIDER_ID_SET.has(providerId);
}

export function createLoadingMultimodelCliStatus(): CliInstallationStatus {
  const providers: CliProviderStatus[] = MULTIMODEL_PROVIDER_IDS.map((providerId) => ({
    providerId,
    displayName: getProviderDisplayName(providerId),
    supported: false,
    authenticated: false,
    authMethod: null,
    verificationState: 'unknown' as const,
    modelVerificationState: 'idle' as const,
    modelCatalogRefreshState: 'idle' as const,
    statusMessage: 'Checking...',
    models: [],
    modelAvailability: [],
    canLoginFromUi: providerId !== 'opencode',
    capabilities: {
      teamLaunch: false,
      oneShot: false,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    backend: null,
  }));

  return {
    flavor: 'agent_teams_orchestrator',
    displayName: 'Multimodel runtime',
    supportsSelfUpdate: false,
    showVersionDetails: false,
    showBinaryPath: false,
    installed: true,
    installedVersion: null,
    binaryPath: null,
    launchError: null,
    latestVersion: null,
    updateAvailable: false,
    authLoggedIn: false,
    authStatusChecking: true,
    authMethod: null,
    providers,
  };
}

function isModelOnlyFallbackProviderStatus(provider: CliProviderStatus | undefined): boolean {
  if (!provider) {
    return false;
  }

  return (
    provider.supported === false &&
    provider.authenticated === false &&
    provider.authMethod === null &&
    provider.verificationState === 'unknown' &&
    provider.models.length > 0 &&
    provider.backend == null &&
    (provider.availableBackends?.length ?? 0) === 0 &&
    provider.capabilities.teamLaunch === false
  );
}

function isOpenCodeSummaryOnlyCatalogStatus(provider: CliProviderStatus | undefined): boolean {
  if (provider?.providerId !== 'opencode') {
    return false;
  }

  if (provider.modelCatalog?.providerId === 'opencode') {
    return false;
  }

  if (provider.modelCatalogRefreshState === 'error') {
    return false;
  }

  return provider.runtimeCapabilities?.modelCatalog?.dynamic === true;
}

function isDeferredMultimodelProviderStatus(provider: CliProviderStatus | undefined): boolean {
  return (
    provider?.supported === false &&
    provider.authenticated === false &&
    provider.authMethod === null &&
    provider.verificationState === 'unknown' &&
    provider.statusMessage === CLI_PROVIDER_STATUS_DEFERRED_MESSAGE
  );
}

function isHydratedMultimodelProviderStatus(provider: CliProviderStatus | undefined): boolean {
  if (!provider) {
    return false;
  }

  if (isDeferredMultimodelProviderStatus(provider)) {
    return false;
  }

  if (isModelOnlyFallbackProviderStatus(provider)) {
    return false;
  }

  if (isOpenCodeSummaryOnlyCatalogStatus(provider)) {
    return false;
  }

  return !(
    provider.supported === false &&
    provider.authenticated === false &&
    provider.authMethod === null &&
    provider.verificationState === 'unknown' &&
    provider.statusMessage === 'Checking...' &&
    provider.models.length === 0 &&
    provider.backend == null &&
    (provider.availableBackends?.length ?? 0) === 0
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function clearCliProviderStatusInFlight(providerId: CliProviderId): void {
  cliProviderStatusInFlight.delete(`${providerId}:status`);
  cliProviderStatusInFlight.delete(`${providerId}:verify`);
}

function getProviderStatus(
  status: CliInstallationStatus | null | undefined,
  providerId: CliProviderId
): CliProviderStatus | undefined {
  return status?.providers.find((provider) => provider.providerId === providerId);
}

function isCodexCatalogLoadingSnapshot(provider: CliProviderStatus | undefined): boolean {
  return (
    provider?.providerId === 'codex' &&
    provider.modelCatalog == null &&
    provider.modelCatalogRefreshState === 'loading' &&
    provider.runtimeCapabilities?.modelCatalog?.dynamic === true
  );
}

function hasOpenCodeModels(provider: CliProviderStatus | undefined): boolean {
  return (
    provider?.providerId === 'opencode' &&
    provider.models.length > 0 &&
    !isOpenCodeSummaryOnlyCatalogStatus(provider)
  );
}

function hasCodexRuntimeReady(provider: CliProviderStatus | undefined): boolean {
  return (
    provider?.providerId === 'codex' &&
    provider.availableBackends?.some((backend) => backend.id === 'codex-native') === true
  );
}

function isOpenCodeRuntimeMissingSnapshot(provider: CliProviderStatus | undefined): boolean {
  if (!provider || provider.providerId !== 'opencode' || provider.models.length > 0) {
    return false;
  }

  const message = `${provider.statusMessage ?? ''} ${provider.detailMessage ?? ''}`.toLowerCase();
  return (
    provider.verificationState === 'error' &&
    message.includes('opencode cli') &&
    (message.includes('not found') ||
      message.includes('not installed') ||
      message.includes('missing'))
  );
}

function isProviderStatusUnavailableSnapshot(provider: CliProviderStatus | undefined): boolean {
  return (
    provider?.verificationState === 'error' &&
    provider.statusMessage === CLI_PROVIDER_STATUS_UNAVAILABLE_MESSAGE
  );
}

function shouldKeepConnectedProviderDuringStatusUnavailable(
  currentProvider: CliProviderStatus | undefined,
  incomingProvider: CliProviderStatus | undefined
): boolean {
  if (!currentProvider || !incomingProvider) {
    return false;
  }

  return (
    isHydratedMultimodelProviderStatus(currentProvider) &&
    currentProvider.authenticated &&
    isProviderStatusUnavailableSnapshot(incomingProvider)
  );
}

function shouldPreserveCurrentProviderStatus(
  currentProvider: CliProviderStatus | undefined,
  incomingProvider: CliProviderStatus
): boolean {
  if (!currentProvider) {
    return false;
  }

  if (shouldKeepConnectedProviderDuringStatusUnavailable(currentProvider, incomingProvider)) {
    return true;
  }

  if (hasOpenCodeModels(currentProvider) && isOpenCodeRuntimeMissingSnapshot(incomingProvider)) {
    return true;
  }

  return (
    isHydratedMultimodelProviderStatus(currentProvider) &&
    !isHydratedMultimodelProviderStatus(incomingProvider)
  );
}

function mergeProviderCatalogCache(
  incomingProvider: CliProviderStatus,
  currentProvider: CliProviderStatus
): CliProviderStatus {
  const modelCatalog = incomingProvider.modelCatalog ?? currentProvider.modelCatalog ?? null;
  const incomingRefreshState = incomingProvider.modelCatalogRefreshState ?? null;
  const shouldPreserveCurrentModels =
    incomingProvider.models.length === 0 ||
    (incomingProvider.providerId === 'opencode' &&
      incomingProvider.modelCatalog == null &&
      incomingProvider.runtimeCapabilities?.modelCatalog?.dynamic === true &&
      currentProvider.models.length > incomingProvider.models.length);
  return {
    ...incomingProvider,
    models: shouldPreserveCurrentModels ? currentProvider.models : incomingProvider.models,
    modelCatalog,
    modelCatalogRefreshState:
      modelCatalog && incomingRefreshState !== 'error'
        ? 'ready'
        : (incomingRefreshState ?? currentProvider.modelCatalogRefreshState),
    runtimeCapabilities:
      incomingProvider.runtimeCapabilities ?? currentProvider.runtimeCapabilities ?? null,
  };
}

function mergePreservedHydratedProviderStatus(
  incomingProvider: CliProviderStatus,
  currentProvider: CliProviderStatus
): CliProviderStatus {
  if (shouldKeepConnectedProviderDuringStatusUnavailable(currentProvider, incomingProvider)) {
    return currentProvider;
  }

  if (isDeferredMultimodelProviderStatus(incomingProvider)) {
    return currentProvider;
  }

  return mergeProviderCatalogCache(incomingProvider, currentProvider);
}

export function getIncompleteMultimodelProviderIds(
  status: CliInstallationStatus | null
): CliProviderId[] {
  if (status?.flavor !== 'agent_teams_orchestrator' || !status.installed) {
    return [];
  }

  return status.providers
    .filter(
      (provider) =>
        isActiveMultimodelProviderId(provider.providerId) &&
        !isHydratedMultimodelProviderStatus(provider)
    )
    .map((provider) => provider.providerId);
}

export function getModelOnlyFallbackProviderIds(
  status: CliInstallationStatus | null
): CliProviderId[] {
  if (status?.flavor !== 'agent_teams_orchestrator' || !status.installed) {
    return [];
  }

  return status.providers
    .filter(
      (provider) =>
        isActiveMultimodelProviderId(provider.providerId) &&
        isModelOnlyFallbackProviderStatus(provider)
    )
    .map((provider) => provider.providerId);
}

export function reconcileMultimodelProviderLoading(
  status: CliInstallationStatus | null,
  currentLoading: Partial<Record<CliProviderId, boolean>>
): Partial<Record<CliProviderId, boolean>> {
  if (status?.flavor !== 'agent_teams_orchestrator' || !status.installed) {
    return {};
  }

  const incompleteProviderIds = new Set(getIncompleteMultimodelProviderIds(status));
  const providersById = new Map(
    status.providers.map((provider) => [provider.providerId, provider])
  );
  return MULTIMODEL_PROVIDER_IDS.reduce<Partial<Record<CliProviderId, boolean>>>(
    (nextLoading, providerId) => {
      const provider = providersById.get(providerId);
      return {
        ...nextLoading,
        [providerId]: provider
          ? incompleteProviderIds.has(providerId)
          : currentLoading[providerId] === true,
      };
    },
    {}
  );
}

function areArraysEqual<T>(
  a: readonly T[],
  b: readonly T[],
  isEqual: (left: T, right: T) => boolean
): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i += 1) {
    if (!isEqual(a[i], b[i])) return false;
  }
  return true;
}

/**
 * Content-level equality for cloned IPC DTO values. The provider snapshot is
 * serialised by `CliInstallerService.cloneCliInstallationStatus()` and
 * `publishStatusSnapshot()` before reaching the renderer, so every nested
 * array/object arrives as a fresh reference even when nothing changed. These
 * values are plain JSON-serialisable DTOs, so a stringify-based comparator is
 * acceptable: false negatives are fine (we just produce a new merged status
 * unnecessarily), but false positives are not (we must never preserve stale
 * data).
 */
function areDtoValuesEqual<T>(a: T | null | undefined, b: T | null | undefined): boolean {
  if (a === b) return true;
  if (a == null || b == null) return a == null && b == null;
  return JSON.stringify(a) === JSON.stringify(b);
}

function areExtensionCapabilitiesEqual(
  a: CliProviderStatus['capabilities']['extensions']['plugins'],
  b: CliProviderStatus['capabilities']['extensions']['plugins']
): boolean {
  if (a === b) return true;
  return (
    a.status === b.status &&
    a.ownership === b.ownership &&
    (a.reason ?? null) === (b.reason ?? null)
  );
}

function areProviderCapabilitiesEqual(
  a: CliProviderStatus['capabilities'],
  b: CliProviderStatus['capabilities']
): boolean {
  if (a === b) return true;
  return (
    a.teamLaunch === b.teamLaunch &&
    a.oneShot === b.oneShot &&
    areExtensionCapabilitiesEqual(a.extensions.plugins, b.extensions.plugins) &&
    areExtensionCapabilitiesEqual(a.extensions.mcp, b.extensions.mcp) &&
    areExtensionCapabilitiesEqual(a.extensions.skills, b.extensions.skills) &&
    areExtensionCapabilitiesEqual(a.extensions.apiKeys, b.extensions.apiKeys)
  );
}

function areProviderBackendsEqual(
  a: CliProviderStatus['backend'],
  b: CliProviderStatus['backend']
): boolean {
  if (a === b) return true;
  if (a == null || b == null) return false;
  return (
    a.kind === b.kind &&
    a.label === b.label &&
    (a.endpointLabel ?? null) === (b.endpointLabel ?? null) &&
    (a.projectId ?? null) === (b.projectId ?? null) &&
    (a.authMethodDetail ?? null) === (b.authMethodDetail ?? null)
  );
}

/**
 * Content-level equality check for a single CliProviderStatus.
 *
 * Compares all scalar fields explicitly, the well-typed nested structures
 * (capabilities, backend) via dedicated comparators, and the cloned DTO
 * fields (modelCatalog, modelAvailability, runtimeCapabilities,
 * subscriptionRateLimits, connection, availableBackends,
 * externalRuntimeDiagnostics) by content. This is necessary because the
 * IPC path (`CliInstallerService.cloneCliInstallationStatus()` then
 * `publishStatusSnapshot()`) hands the renderer freshly-deserialised
 * provider objects on every tick — reference equality on those nested
 * fields would never hold even when the snapshot is structurally
 * identical.
 */
function areProviderStatusContentEqual(a: CliProviderStatus, b: CliProviderStatus): boolean {
  if (a === b) return true;
  return (
    a.providerId === b.providerId &&
    a.displayName === b.displayName &&
    a.supported === b.supported &&
    a.authenticated === b.authenticated &&
    a.authMethod === b.authMethod &&
    a.verificationState === b.verificationState &&
    (a.modelVerificationState ?? null) === (b.modelVerificationState ?? null) &&
    (a.modelCatalogRefreshState ?? null) === (b.modelCatalogRefreshState ?? null) &&
    (a.statusMessage ?? null) === (b.statusMessage ?? null) &&
    (a.detailMessage ?? null) === (b.detailMessage ?? null) &&
    a.canLoginFromUi === b.canLoginFromUi &&
    (a.selectedBackendId ?? null) === (b.selectedBackendId ?? null) &&
    (a.resolvedBackendId ?? null) === (b.resolvedBackendId ?? null) &&
    areArraysEqual(a.models, b.models, (left, right) => left === right) &&
    areProviderCapabilitiesEqual(a.capabilities, b.capabilities) &&
    areProviderBackendsEqual(a.backend ?? null, b.backend ?? null) &&
    areDtoValuesEqual(a.modelCatalog ?? null, b.modelCatalog ?? null) &&
    areDtoValuesEqual(a.modelAvailability ?? [], b.modelAvailability ?? []) &&
    areDtoValuesEqual(a.runtimeCapabilities ?? null, b.runtimeCapabilities ?? null) &&
    areDtoValuesEqual(a.subscriptionRateLimits ?? null, b.subscriptionRateLimits ?? null) &&
    areDtoValuesEqual(a.connection ?? null, b.connection ?? null) &&
    areDtoValuesEqual(a.availableBackends ?? [], b.availableBackends ?? []) &&
    areDtoValuesEqual(a.externalRuntimeDiagnostics ?? [], b.externalRuntimeDiagnostics ?? [])
  );
}

function isCliInstallationStatusContentEqual(
  a: CliInstallationStatus,
  b: CliInstallationStatus
): boolean {
  return (
    a.flavor === b.flavor &&
    a.displayName === b.displayName &&
    a.supportsSelfUpdate === b.supportsSelfUpdate &&
    a.showVersionDetails === b.showVersionDetails &&
    a.showBinaryPath === b.showBinaryPath &&
    a.installed === b.installed &&
    a.installedVersion === b.installedVersion &&
    a.binaryPath === b.binaryPath &&
    (a.launchError ?? null) === (b.launchError ?? null) &&
    a.latestVersion === b.latestVersion &&
    a.updateAvailable === b.updateAvailable &&
    a.authLoggedIn === b.authLoggedIn &&
    a.authStatusChecking === b.authStatusChecking &&
    a.authMethod === b.authMethod &&
    areArraysEqual(a.providers, b.providers, Object.is)
  );
}

export function mergeCliStatusPreservingHydratedProviders(
  current: CliInstallationStatus | null,
  incoming: CliInstallationStatus
): CliInstallationStatus {
  if (
    current?.flavor !== 'agent_teams_orchestrator' ||
    incoming.flavor !== 'agent_teams_orchestrator'
  ) {
    if (current && isCliInstallationStatusContentEqual(current, incoming)) {
      return current;
    }
    return incoming;
  }

  const currentProvidersById = new Map(
    current.providers.map((provider) => [provider.providerId, provider])
  );
  const incomingProviderIds = new Set(incoming.providers.map((provider) => provider.providerId));
  const providers = incoming.providers.map((incomingProvider) => {
    const currentProvider = currentProvidersById.get(incomingProvider.providerId);
    if (!currentProvider) {
      return incomingProvider;
    }
    if (shouldPreserveCurrentProviderStatus(currentProvider, incomingProvider)) {
      return mergePreservedHydratedProviderStatus(incomingProvider, currentProvider);
    }
    // Preserve the current reference when content is identical so the
    // providers array stays reference-stable across steady-state IPC polls.
    if (areProviderStatusContentEqual(currentProvider, incomingProvider)) {
      return currentProvider;
    }
    return incomingProvider;
  });

  for (const currentProvider of current.providers) {
    if (
      !incomingProviderIds.has(currentProvider.providerId) &&
      isActiveMultimodelProviderId(currentProvider.providerId) &&
      isHydratedMultimodelProviderStatus(currentProvider)
    ) {
      providers.push(currentProvider);
    }
  }

  const authenticatedProvider = getAuthenticatedProvider(providers);

  const mergedProviders = areArraysEqual(providers, current.providers, Object.is)
    ? current.providers
    : providers;

  const merged: CliInstallationStatus = {
    ...incoming,
    providers: mergedProviders,
    authLoggedIn: mergedProviders.some(
      (provider) => isActiveMultimodelProviderId(provider.providerId) && provider.authenticated
    ),
    authMethod: authenticatedProvider?.authMethod ?? null,
  };

  if (isCliInstallationStatusContentEqual(current, merged)) {
    return current;
  }

  return merged;
}

function shouldRecordProviderConnectionOutcome(
  previousProvider: CliProviderStatus | undefined,
  nextProvider: CliProviderStatus | null
): boolean {
  if (!nextProvider) {
    return true;
  }

  if (!previousProvider || !isHydratedMultimodelProviderStatus(previousProvider)) {
    return true;
  }

  return (
    previousProvider.authenticated !== nextProvider.authenticated ||
    previousProvider.authMethod !== nextProvider.authMethod ||
    (previousProvider.verificationState !== nextProvider.verificationState &&
      nextProvider.verificationState === 'error')
  );
}

function shouldRecordProviderConnectionError(
  previousProvider: CliProviderStatus | undefined
): boolean {
  return !previousProvider || previousProvider.verificationState !== 'error';
}

export async function refreshOpenCodeProviderStatusAfterRuntimeInstall(
  get: () => Pick<CliInstallerSlice, 'cliStatus' | 'fetchCliProviderStatus'>
): Promise<void> {
  if (!api.cliInstaller) {
    return;
  }

  for (let attempt = 1; attempt <= OPENCODE_PROVIDER_INSTALL_REFRESH_ATTEMPTS; attempt += 1) {
    await api.cliInstaller.invalidateStatus();
    clearCliProviderStatusInFlight('opencode');
    const epoch = ++cliStatusEpoch;
    await get().fetchCliProviderStatus('opencode', { silent: false, epoch });

    if (hasOpenCodeModels(getProviderStatus(get().cliStatus, 'opencode'))) {
      return;
    }

    if (attempt < OPENCODE_PROVIDER_INSTALL_REFRESH_ATTEMPTS) {
      await sleep(OPENCODE_PROVIDER_INSTALL_REFRESH_RETRY_DELAY_MS);
    }
  }
}

export async function refreshCodexProviderStatusAfterRuntimeInstall(
  get: () => Pick<CliInstallerSlice, 'cliStatus' | 'fetchCliProviderStatus'>
): Promise<void> {
  if (!api.cliInstaller) {
    return;
  }

  for (let attempt = 1; attempt <= CODEX_PROVIDER_INSTALL_REFRESH_ATTEMPTS; attempt += 1) {
    await api.cliInstaller.invalidateStatus();
    clearCliProviderStatusInFlight('codex');
    const epoch = ++cliStatusEpoch;
    await get().fetchCliProviderStatus('codex', { silent: false, epoch });

    if (hasCodexRuntimeReady(getProviderStatus(get().cliStatus, 'codex'))) {
      return;
    }

    if (attempt < CODEX_PROVIDER_INSTALL_REFRESH_ATTEMPTS) {
      await sleep(CODEX_PROVIDER_INSTALL_REFRESH_RETRY_DELAY_MS);
    }
  }
}

function isMultimodelCliStatus(
  status: CliInstallationStatus | null | undefined
): status is CliInstallationStatus & { flavor: 'agent_teams_orchestrator' } {
  return status?.flavor === 'agent_teams_orchestrator';
}

function hasActiveProviderStatusLoading(
  providerLoading: Partial<Record<CliProviderId, boolean>>
): boolean {
  return MULTIMODEL_PROVIDER_IDS.some((providerId) => providerLoading[providerId] === true);
}

function getAuthenticatedProvider(providers: CliProviderStatus[]): CliProviderStatus | null {
  return (
    providers.find(
      (provider) => isActiveMultimodelProviderId(provider.providerId) && provider.authenticated
    ) ?? null
  );
}

function buildMultimodelCliAuthState(params: {
  status: CliInstallationStatus;
  providers?: CliProviderStatus[];
  providerLoading?: Partial<Record<CliProviderId, boolean>>;
}): Pick<CliInstallationStatus, 'authLoggedIn' | 'authMethod' | 'authStatusChecking'> {
  const providers = params.providers ?? params.status.providers;
  const providerLoading = params.providerLoading ?? {};
  const authenticatedProvider = getAuthenticatedProvider(providers);

  return {
    authLoggedIn: providers.some(
      (provider) => isActiveMultimodelProviderId(provider.providerId) && provider.authenticated
    ),
    authMethod: authenticatedProvider?.authMethod ?? null,
    authStatusChecking: params.status.installed && hasActiveProviderStatusLoading(providerLoading),
  };
}

function getProviderDisplayName(providerId: CliProviderId): string {
  switch (providerId) {
    case 'anthropic':
      return 'Anthropic';
    case 'codex':
      return 'Codex';
    case 'gemini':
      return 'Gemini';
    case 'opencode':
      return 'OpenCode (200+ models)';
  }
}

function createProviderStatusErrorSnapshot(params: {
  providerId: CliProviderId;
  message: string;
  currentProvider?: CliProviderStatus;
}): CliProviderStatus {
  const currentProvider =
    params.currentProvider ??
    createLoadingMultimodelCliStatus().providers.find(
      (provider) => provider.providerId === params.providerId
    ) ??
    ({
      providerId: params.providerId,
      displayName: getProviderDisplayName(params.providerId),
      supported: false,
      authenticated: false,
      authMethod: null,
      verificationState: 'unknown',
      modelVerificationState: 'idle',
      modelCatalogRefreshState: 'idle',
      statusMessage: 'Checking...',
      models: [],
      modelAvailability: [],
      canLoginFromUi: params.providerId !== 'opencode',
      capabilities: {
        teamLaunch: false,
        oneShot: false,
        extensions: createDefaultCliExtensionCapabilities(),
      },
      backend: null,
    } satisfies CliProviderStatus);

  const errorProvider: CliProviderStatus = {
    ...currentProvider,
    providerId: params.providerId,
    displayName: currentProvider.displayName ?? getProviderDisplayName(params.providerId),
    authenticated: false,
    authMethod: null,
    verificationState: 'error' as const,
    modelCatalogRefreshState: 'error' as const,
    statusMessage: params.message,
    detailMessage: null,
  };

  if (shouldKeepConnectedProviderDuringStatusUnavailable(currentProvider, errorProvider)) {
    return currentProvider;
  }

  return errorProvider;
}

// =============================================================================
// Slice Interface
// =============================================================================

export interface CliInstallerSlice {
  // State
  cliStatus: CliInstallationStatus | null;
  cliStatusLoading: boolean;
  cliProviderStatusLoading: Partial<Record<CliProviderId, boolean>>;
  cliStatusError: string | null;
  cliInstallerState:
    | 'idle'
    | 'checking'
    | 'downloading'
    | 'verifying'
    | 'installing'
    | 'completed'
    | 'error';
  cliDownloadProgress: number;
  cliDownloadTransferred: number;
  cliDownloadTotal: number;
  cliInstallerError: string | null;
  cliInstallerDetail: string | null;
  cliInstallerLogs: string[];
  cliInstallerRawChunks: string[];
  cliCompletedVersion: string | null;
  openCodeRuntimeStatus: OpenCodeRuntimeStatus | null;
  openCodeRuntimeStatusLoading: boolean;
  openCodeRuntimeError: string | null;
  codexRuntimeStatus: CodexRuntimeStatus | null;
  codexRuntimeStatusLoading: boolean;
  codexRuntimeError: string | null;

  // Actions
  bootstrapCliStatus: (options?: {
    multimodelEnabled?: boolean;
    providerStatusMode?: 'full' | 'defer';
  }) => Promise<void>;
  fetchCliStatus: () => Promise<void>;
  fetchCliProviderStatus: (
    providerId: CliProviderId,
    options?: { silent?: boolean; epoch?: number; verifyModels?: boolean }
  ) => Promise<boolean>;
  invalidateCliStatus: () => Promise<void>;
  installCli: () => void;
  fetchOpenCodeRuntimeStatus: () => Promise<void>;
  installOpenCodeRuntime: () => Promise<void>;
  invalidateOpenCodeRuntimeStatus: () => Promise<void>;
  fetchCodexRuntimeStatus: () => Promise<void>;
  installCodexRuntime: () => Promise<void>;
  invalidateCodexRuntimeStatus: () => Promise<void>;
}

let cliStatusInFlight: Promise<void> | null = null;
const cliProviderStatusInFlight = new Map<string, Promise<boolean>>();
let cliStatusEpoch = 0;
const cliProviderStatusSeq = new Map<CliProviderId, number>();
const codexCatalogLoadingRefreshAttempts = new Map<CliProviderId, number>();
const codexCatalogLoadingRefreshTimers = new Map<CliProviderId, ReturnType<typeof setTimeout>>();
let openCodeRuntimeStatusInFlight: Promise<void> | null = null;
let codexRuntimeStatusInFlight: Promise<void> | null = null;

function clearCodexCatalogLoadingRefresh(providerId: CliProviderId): void {
  const timer = codexCatalogLoadingRefreshTimers.get(providerId);
  if (timer) {
    clearTimeout(timer);
    codexCatalogLoadingRefreshTimers.delete(providerId);
  }
  codexCatalogLoadingRefreshAttempts.delete(providerId);
}

function scheduleCodexCatalogLoadingRefresh(
  get: () => Pick<CliInstallerSlice, 'cliStatus' | 'fetchCliProviderStatus'>,
  providerId: CliProviderId
): void {
  const provider = getProviderStatus(get().cliStatus, providerId);
  if (!isCodexCatalogLoadingSnapshot(provider)) {
    clearCodexCatalogLoadingRefresh(providerId);
    return;
  }

  if (codexCatalogLoadingRefreshTimers.has(providerId)) {
    return;
  }

  const attempts = codexCatalogLoadingRefreshAttempts.get(providerId) ?? 0;
  if (attempts >= CODEX_CATALOG_LOADING_REFRESH_ATTEMPTS) {
    return;
  }

  codexCatalogLoadingRefreshAttempts.set(providerId, attempts + 1);
  const timer = setTimeout(() => {
    codexCatalogLoadingRefreshTimers.delete(providerId);
    const latestProvider = getProviderStatus(get().cliStatus, providerId);
    if (!isCodexCatalogLoadingSnapshot(latestProvider)) {
      codexCatalogLoadingRefreshAttempts.delete(providerId);
      return;
    }

    void get().fetchCliProviderStatus(providerId, { silent: true });
  }, CODEX_CATALOG_LOADING_REFRESH_RETRY_DELAY_MS);
  (timer as ReturnType<typeof setTimeout> & { unref?: () => void }).unref?.();
  codexCatalogLoadingRefreshTimers.set(providerId, timer);
}

function scheduleCodexCatalogLoadingRefreshes(
  get: () => Pick<CliInstallerSlice, 'cliStatus' | 'fetchCliProviderStatus'>
): void {
  scheduleCodexCatalogLoadingRefresh(get, 'codex');
}

function createFailedOpenCodeRuntimeStatus(
  previousStatus: OpenCodeRuntimeStatus | null,
  message: string
): OpenCodeRuntimeStatus {
  return {
    installed: previousStatus?.installed ?? false,
    ...(previousStatus?.binaryPath ? { binaryPath: previousStatus.binaryPath } : {}),
    ...(previousStatus?.version ? { version: previousStatus.version } : {}),
    source: previousStatus?.source ?? 'missing',
    state: 'failed',
    progress: {
      phase: 'failed',
      detail: message,
    },
    error: message,
  };
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createCliInstallerSlice: StateCreator<AppState, [], [], CliInstallerSlice> = (
  set,
  get
) => ({
  // Initial state
  cliStatus: null,
  cliStatusLoading: false,
  cliProviderStatusLoading: {},
  cliStatusError: null,
  cliInstallerState: 'idle',
  cliDownloadProgress: 0,
  cliDownloadTransferred: 0,
  cliDownloadTotal: 0,
  cliInstallerError: null,
  cliInstallerDetail: null,
  cliInstallerLogs: [],
  cliInstallerRawChunks: [],
  cliCompletedVersion: null,
  openCodeRuntimeStatus: null,
  openCodeRuntimeStatusLoading: false,
  openCodeRuntimeError: null,
  codexRuntimeStatus: null,
  codexRuntimeStatusLoading: false,
  codexRuntimeError: null,

  bootstrapCliStatus: async (options) => {
    if (!api.cliInstaller) return;
    const multimodelEnabled = options?.multimodelEnabled ?? true;
    const providerStatusMode = options?.providerStatusMode ?? 'full';
    const hydrateProviders = providerStatusMode !== 'defer';
    if (!multimodelEnabled) {
      return get().fetchCliStatus();
    }

    const epoch = ++cliStatusEpoch;
    const currentStatus = get().cliStatus;
    const initialStatus =
      providerStatusMode === 'defer' && currentStatus?.flavor === 'agent_teams_orchestrator'
        ? currentStatus
        : createLoadingMultimodelCliStatus();
    const shouldMarkIncompleteProvidersLoading = hydrateProviders || providerStatusMode === 'defer';
    const providerLoading = Object.fromEntries(
      MULTIMODEL_PROVIDER_IDS.map((providerId) => [
        providerId,
        shouldMarkIncompleteProvidersLoading &&
          initialStatus.installed &&
          !isHydratedMultimodelProviderStatus(
            initialStatus.providers.find((provider) => provider.providerId === providerId)
          ),
      ])
    ) as Partial<Record<CliProviderId, boolean>>;

    set({
      cliStatus: initialStatus,
      cliStatusLoading: true,
      cliProviderStatusLoading: providerLoading,
      cliStatusError: null,
    });

    try {
      const metadata = await api.cliInstaller.getStatus(
        providerStatusMode === 'defer' ? { providerStatusMode } : undefined
      );
      if (metadata.flavor !== 'agent_teams_orchestrator') {
        set((state) => {
          if (epoch !== cliStatusEpoch) {
            return {};
          }

          const mergedMetadata = mergeCliStatusPreservingHydratedProviders(
            state.cliStatus,
            metadata
          );

          return {
            cliStatus: mergedMetadata,
            cliStatusLoading: false,
            cliProviderStatusLoading: {},
            cliStatusError: state.cliStatusError,
          };
        });
        return;
      }

      let pendingProviderIds: CliProviderId[] = [];

      set((state) => {
        if (epoch !== cliStatusEpoch || !state.cliStatus) {
          return {};
        }

        const nextCliStatus = mergeCliStatusPreservingHydratedProviders(state.cliStatus, metadata);
        const nextProviderLoading = Object.fromEntries(
          MULTIMODEL_PROVIDER_IDS.map((providerId) => [
            providerId,
            !isHydratedMultimodelProviderStatus(
              nextCliStatus.providers.find((provider) => provider.providerId === providerId)
            ),
          ])
        ) as Partial<Record<CliProviderId, boolean>>;
        pendingProviderIds = MULTIMODEL_PROVIDER_IDS.filter(
          (providerId) => nextProviderLoading[providerId] === true
        );
        const nextAuthState = isMultimodelCliStatus(nextCliStatus)
          ? buildMultimodelCliAuthState({
              status: nextCliStatus,
              providerLoading: nextProviderLoading,
            })
          : null;

        return {
          cliStatus: nextAuthState
            ? {
                ...nextCliStatus,
                launchError: metadata.launchError ?? null,
                ...nextAuthState,
              }
            : nextCliStatus,
          cliStatusLoading: false,
          cliProviderStatusLoading: nextProviderLoading,
        };
      });

      scheduleCodexCatalogLoadingRefreshes(get);

      if (!metadata.installed) {
        if (epoch === cliStatusEpoch) {
          set({
            cliProviderStatusLoading: {},
          });
        }
        return;
      }

      if (!hydrateProviders || pendingProviderIds.length === 0) {
        return;
      }

      await Promise.allSettled(
        pendingProviderIds.map((providerId) =>
          get().fetchCliProviderStatus(providerId, {
            silent: false,
            epoch,
          })
        )
      );
      return;
    } catch (error) {
      logger.warn('Failed to hydrate CLI metadata during provider-first bootstrap:', error);
    }

    try {
      if (hydrateProviders) {
        await Promise.allSettled(
          MULTIMODEL_PROVIDER_IDS.map((providerId) =>
            get().fetchCliProviderStatus(providerId, {
              silent: false,
              epoch,
            })
          )
        );
      }
    } finally {
      if (epoch === cliStatusEpoch) {
        set({ cliStatusLoading: false });
      }
    }
  },

  fetchCliStatus: async () => {
    if (!api.cliInstaller) return;
    if (cliStatusInFlight) return cliStatusInFlight;

    const epoch = ++cliStatusEpoch;
    cliStatusInFlight = (async () => {
      set({ cliStatusLoading: true, cliStatusError: null });
      try {
        const status = await api.cliInstaller.getStatus();
        if (epoch !== cliStatusEpoch) {
          return;
        }
        set((state) => {
          const nextCliStatus = mergeCliStatusPreservingHydratedProviders(state.cliStatus, status);
          return {
            cliStatus: isMultimodelCliStatus(nextCliStatus)
              ? {
                  ...nextCliStatus,
                  ...buildMultimodelCliAuthState({
                    status: nextCliStatus,
                    providerLoading: {},
                  }),
                }
              : nextCliStatus,
            cliProviderStatusLoading: {},
          };
        });
        scheduleCodexCatalogLoadingRefreshes(get);
        if (status.installed) {
          for (const provider of status.providers) {
            if (!isActiveMultimodelProviderId(provider.providerId)) {
              continue;
            }
            void get().fetchCliProviderStatus(provider.providerId, {
              silent: true,
              epoch,
            });
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to check CLI status';
        logger.error('Failed to fetch CLI status:', error);
        set({ cliStatusError: message });
      } finally {
        set({ cliStatusLoading: false });
        cliStatusInFlight = null;
      }
    })();

    return cliStatusInFlight;
  },

  fetchCliProviderStatus: async (providerId, options) => {
    if (!api.cliInstaller) return false;
    if (get().cliStatus && !get().cliStatus?.installed) {
      return false;
    }
    const verifyModels = options?.verifyModels === true && providerId !== 'opencode';
    const requestKey = `${providerId}:${verifyModels ? 'verify' : 'status'}`;
    const inFlight = cliProviderStatusInFlight.get(requestKey);
    if (inFlight) return inFlight;

    const requestEpoch = options?.epoch ?? cliStatusEpoch;
    const requestSeq = (cliProviderStatusSeq.get(providerId) ?? 0) + 1;
    const silent = options?.silent === true;
    const requestStartedAtMs = Date.now();
    const previousProviderStatus = getProviderStatus(get().cliStatus, providerId);
    cliProviderStatusSeq.set(providerId, requestSeq);

    const request = (async () => {
      if (!silent) {
        set((state) => {
          const nextLoading = {
            ...state.cliProviderStatusLoading,
            [providerId]: true,
          };

          return {
            cliStatusError: null,
            cliProviderStatusLoading: nextLoading,
            cliStatus:
              state.cliStatus && isMultimodelCliStatus(state.cliStatus)
                ? {
                    ...state.cliStatus,
                    ...buildMultimodelCliAuthState({
                      status: state.cliStatus,
                      providerLoading: nextLoading,
                    }),
                  }
                : state.cliStatus,
          };
        });
      }

      try {
        const providerStatus = verifyModels
          ? await api.cliInstaller.verifyProviderModels(providerId)
          : await api.cliInstaller.getProviderStatus(providerId);
        if (
          !silent &&
          !verifyModels &&
          shouldRecordProviderConnectionOutcome(previousProviderStatus, providerStatus)
        ) {
          const providerErrorClass = providerStatus?.authenticated
            ? 'none'
            : classifyAnalyticsError(
                `${providerStatus?.statusMessage ?? ''} ${providerStatus?.detailMessage ?? ''}`
              );
          recordProviderConnectionEnd({
            provider: providerStatus?.providerId ?? providerId,
            authMethod: providerStatus?.authMethod,
            success: providerStatus?.authenticated === true,
            errorClass: providerErrorClass,
            durationMs: elapsedMsSince(requestStartedAtMs),
          });
        }
        set((state) => {
          const currentCliStatus = state.cliStatus;
          const nextLoading = silent
            ? state.cliProviderStatusLoading
            : {
                ...state.cliProviderStatusLoading,
                [providerId]: false,
              };

          if (
            requestEpoch !== cliStatusEpoch ||
            cliProviderStatusSeq.get(providerId) !== requestSeq
          ) {
            return { cliProviderStatusLoading: nextLoading };
          }

          if (!providerStatus || !currentCliStatus) {
            return { cliProviderStatusLoading: nextLoading };
          }

          const settledCliStatus: CliInstallationStatus = currentCliStatus;
          if (
            isMultimodelCliStatus(settledCliStatus) &&
            !isActiveMultimodelProviderId(providerId)
          ) {
            return {
              cliProviderStatusLoading: nextLoading,
              cliStatus: {
                ...settledCliStatus,
                ...buildMultimodelCliAuthState({
                  status: settledCliStatus,
                  providerLoading: nextLoading,
                }),
              },
            };
          }

          const hasProvider = settledCliStatus.providers.some(
            (provider) => provider.providerId === providerId
          );
          const nextProviders = hasProvider
            ? settledCliStatus.providers.map((provider) =>
                provider.providerId === providerId
                  ? mergeProviderCatalogCache(providerStatus, provider)
                  : provider
              )
            : [...settledCliStatus.providers, providerStatus];
          const nextCliStatus = isMultimodelCliStatus(settledCliStatus)
            ? {
                ...settledCliStatus,
                providers: nextProviders,
                ...buildMultimodelCliAuthState({
                  status: settledCliStatus,
                  providers: nextProviders,
                  providerLoading: nextLoading,
                }),
              }
            : {
                ...settledCliStatus,
                providers: nextProviders,
                authLoggedIn: nextProviders.some((provider) => provider.authenticated),
                authMethod: getAuthenticatedProvider(nextProviders)?.authMethod ?? null,
              };

          return {
            cliStatus: nextCliStatus,
            cliProviderStatusLoading: nextLoading,
          };
        });
        scheduleCodexCatalogLoadingRefresh(get, providerId);
        return true;
      } catch (error) {
        if (
          !silent &&
          !verifyModels &&
          shouldRecordProviderConnectionError(previousProviderStatus)
        ) {
          recordProviderConnectionEnd({
            provider: providerId,
            success: false,
            errorClass: classifyAnalyticsError(error),
            durationMs: elapsedMsSince(requestStartedAtMs),
          });
        }
        const message =
          error instanceof Error ? error.message : `Failed to refresh ${providerId} status`;
        logger.error(`Failed to fetch ${providerId} CLI status:`, error);
        set((state) => {
          const currentCliStatus = state.cliStatus;
          const nextLoading = silent
            ? state.cliProviderStatusLoading
            : {
                ...state.cliProviderStatusLoading,
                [providerId]: false,
              };

          if (
            requestEpoch !== cliStatusEpoch ||
            cliProviderStatusSeq.get(providerId) !== requestSeq
          ) {
            return { cliProviderStatusLoading: nextLoading };
          }

          if (!currentCliStatus) {
            return {
              cliStatusError: message,
              cliProviderStatusLoading: nextLoading,
            };
          }

          const settledCliStatus: CliInstallationStatus = currentCliStatus;
          if (
            isMultimodelCliStatus(settledCliStatus) &&
            !isActiveMultimodelProviderId(providerId)
          ) {
            return {
              cliProviderStatusLoading: nextLoading,
              cliStatus: {
                ...settledCliStatus,
                ...buildMultimodelCliAuthState({
                  status: settledCliStatus,
                  providerLoading: nextLoading,
                }),
              },
            };
          }

          const currentProvider =
            settledCliStatus.providers.find((provider) => provider.providerId === providerId) ??
            undefined;
          const nextProviders = settledCliStatus.providers.some(
            (provider) => provider.providerId === providerId
          )
            ? settledCliStatus.providers.map((provider) =>
                provider.providerId === providerId
                  ? createProviderStatusErrorSnapshot({
                      providerId,
                      message,
                      currentProvider,
                    })
                  : provider
              )
            : [
                ...currentCliStatus.providers,
                createProviderStatusErrorSnapshot({
                  providerId,
                  message,
                  currentProvider,
                }),
              ];

          return {
            cliStatusError: message,
            cliProviderStatusLoading: nextLoading,
            cliStatus: isMultimodelCliStatus(settledCliStatus)
              ? {
                  ...settledCliStatus,
                  providers: nextProviders,
                  ...buildMultimodelCliAuthState({
                    status: settledCliStatus,
                    providers: nextProviders,
                    providerLoading: nextLoading,
                  }),
                }
              : {
                  ...settledCliStatus,
                  providers: nextProviders,
                  authLoggedIn: nextProviders.some((provider) => provider.authenticated),
                  authMethod: getAuthenticatedProvider(nextProviders)?.authMethod ?? null,
                },
          };
        });
        clearCodexCatalogLoadingRefresh(providerId);
        return false;
      } finally {
        cliProviderStatusInFlight.delete(requestKey);
      }
    })();

    cliProviderStatusInFlight.set(requestKey, request);
    return request;
  },

  invalidateCliStatus: async () => {
    clearCodexCatalogLoadingRefresh('codex');
    await api.cliInstaller?.invalidateStatus();
  },

  installCli: () => {
    set({
      cliInstallerState: 'checking',
      cliInstallerError: null,
      cliInstallerDetail: null,
      cliInstallerLogs: [],
      cliInstallerRawChunks: [],
      cliDownloadProgress: 0,
      cliDownloadTransferred: 0,
      cliDownloadTotal: 0,
      cliCompletedVersion: null,
    });
    api.cliInstaller.install().catch((error) => {
      logger.error('Failed to install CLI:', error);
    });
  },

  fetchOpenCodeRuntimeStatus: async () => {
    if (!api.openCodeRuntime) return;
    if (openCodeRuntimeStatusInFlight) return openCodeRuntimeStatusInFlight;

    openCodeRuntimeStatusInFlight = (async () => {
      set({ openCodeRuntimeStatusLoading: true, openCodeRuntimeError: null });
      try {
        const status = await api.openCodeRuntime.getStatus();
        set({ openCodeRuntimeStatus: status, openCodeRuntimeError: status.error ?? null });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to check OpenCode runtime status';
        logger.error('Failed to fetch OpenCode runtime status:', error);
        set({
          openCodeRuntimeStatus: createFailedOpenCodeRuntimeStatus(
            get().openCodeRuntimeStatus,
            message
          ),
          openCodeRuntimeError: message,
        });
      } finally {
        set({ openCodeRuntimeStatusLoading: false });
        openCodeRuntimeStatusInFlight = null;
      }
    })();

    return openCodeRuntimeStatusInFlight;
  },

  installOpenCodeRuntime: async () => {
    if (!api.openCodeRuntime) return;
    const installStartedAtMs = Date.now();
    set({
      openCodeRuntimeStatusLoading: true,
      openCodeRuntimeError: null,
      openCodeRuntimeStatus: {
        installed: false,
        source: 'missing',
        state: 'checking',
        progress: {
          phase: 'checking',
          detail: 'Resolving latest OpenCode package...',
        },
      },
    });
    try {
      const status = await api.openCodeRuntime.install();
      set({ openCodeRuntimeStatus: status, openCodeRuntimeError: status.error ?? null });
      recordRuntimeInstallEnd({
        runtime: 'opencode',
        success: status.installed,
        source: status.source,
        errorClass: status.installed ? 'none' : classifyAnalyticsError(status.error),
        durationMs: elapsedMsSince(installStartedAtMs),
      });
      if (status.installed) {
        await api.openCodeRuntime.invalidateStatus();
        await refreshOpenCodeProviderStatusAfterRuntimeInstall(get);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to install OpenCode runtime';
      logger.error('Failed to install OpenCode runtime:', error);
      set({
        openCodeRuntimeStatus: createFailedOpenCodeRuntimeStatus(
          get().openCodeRuntimeStatus,
          message
        ),
        openCodeRuntimeError: message,
      });
      recordRuntimeInstallEnd({
        runtime: 'opencode',
        success: false,
        source: 'unknown',
        errorClass: classifyAnalyticsError(error),
        durationMs: elapsedMsSince(installStartedAtMs),
      });
    } finally {
      set({ openCodeRuntimeStatusLoading: false });
    }
  },

  invalidateOpenCodeRuntimeStatus: async () => {
    await api.openCodeRuntime?.invalidateStatus();
    set({ openCodeRuntimeStatus: null });
  },

  fetchCodexRuntimeStatus: async () => {
    if (!api.codexRuntime) return;
    if (codexRuntimeStatusInFlight) return codexRuntimeStatusInFlight;

    codexRuntimeStatusInFlight = (async () => {
      set({ codexRuntimeStatusLoading: true, codexRuntimeError: null });
      try {
        const status = await api.codexRuntime.getStatus();
        set({ codexRuntimeStatus: status, codexRuntimeError: status.error ?? null });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : 'Failed to check Codex runtime status';
        logger.error('Failed to fetch Codex runtime status:', error);
        set({ codexRuntimeError: message });
      } finally {
        set({ codexRuntimeStatusLoading: false });
        codexRuntimeStatusInFlight = null;
      }
    })();

    return codexRuntimeStatusInFlight;
  },

  installCodexRuntime: async () => {
    if (!api.codexRuntime) return;
    const installStartedAtMs = Date.now();
    set({
      codexRuntimeStatusLoading: true,
      codexRuntimeError: null,
      codexRuntimeStatus: {
        installed: false,
        latestVersion: null,
        updateAvailable: false,
        source: 'missing',
        state: 'checking',
        progress: {
          phase: 'checking',
          detail: 'Resolving latest Codex package...',
        },
      },
    });
    try {
      const status = await api.codexRuntime.install();
      set({ codexRuntimeStatus: status, codexRuntimeError: status.error ?? null });
      recordRuntimeInstallEnd({
        runtime: 'codex',
        success: status.installed,
        source: status.source,
        errorClass: status.installed ? 'none' : classifyAnalyticsError(status.error),
        durationMs: elapsedMsSince(installStartedAtMs),
      });
      if (status.installed) {
        await api.codexRuntime.invalidateStatus();
        await refreshCodexProviderStatusAfterRuntimeInstall(get);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to install Codex runtime';
      logger.error('Failed to install Codex runtime:', error);
      set({ codexRuntimeError: message });
      recordRuntimeInstallEnd({
        runtime: 'codex',
        success: false,
        source: 'unknown',
        errorClass: classifyAnalyticsError(error),
        durationMs: elapsedMsSince(installStartedAtMs),
      });
    } finally {
      set({ codexRuntimeStatusLoading: false });
    }
  },

  invalidateCodexRuntimeStatus: async () => {
    await api.codexRuntime?.invalidateStatus();
    set({ codexRuntimeStatus: null });
  },
});
