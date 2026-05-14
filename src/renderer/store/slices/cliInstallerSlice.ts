/**
 * CLI Installer slice — manages CLI installation status and install/update progress.
 */

import { api } from '@renderer/api';
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

export const MULTIMODEL_PROVIDER_IDS: CliProviderId[] = [
  'anthropic',
  'codex',
  'gemini',
  'opencode',
];

export function createLoadingMultimodelCliStatus(): CliInstallationStatus {
  const providers: CliProviderStatus[] = (
    [
      { providerId: 'anthropic', displayName: 'Anthropic' },
      { providerId: 'codex', displayName: 'Codex' },
      { providerId: 'gemini', displayName: 'Gemini' },
      { providerId: 'opencode', displayName: 'OpenCode (75+ LLM providers)' },
    ] as const
  ).map((provider) => ({
    ...provider,
    supported: false,
    authenticated: false,
    authMethod: null,
    verificationState: 'unknown' as const,
    modelVerificationState: 'idle' as const,
    statusMessage: 'Checking...',
    models: [],
    modelAvailability: [],
    canLoginFromUi: provider.providerId !== 'opencode',
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

function isModelOnlyFallbackProviderStatus(provider: CliProviderStatus): boolean {
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

function isHydratedMultimodelProviderStatus(provider: CliProviderStatus | undefined): boolean {
  if (!provider) {
    return false;
  }

  if (isModelOnlyFallbackProviderStatus(provider)) {
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

function hasOpenCodeModels(provider: CliProviderStatus | undefined): boolean {
  return provider?.providerId === 'opencode' && provider.models.length > 0;
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

function shouldPreserveCurrentProviderStatus(
  currentProvider: CliProviderStatus | undefined,
  incomingProvider: CliProviderStatus
): boolean {
  if (!currentProvider) {
    return false;
  }

  if (hasOpenCodeModels(currentProvider) && isOpenCodeRuntimeMissingSnapshot(incomingProvider)) {
    return true;
  }

  return (
    isHydratedMultimodelProviderStatus(currentProvider) &&
    !isHydratedMultimodelProviderStatus(incomingProvider)
  );
}

export function getIncompleteMultimodelProviderIds(
  status: CliInstallationStatus | null
): CliProviderId[] {
  if (status?.flavor !== 'agent_teams_orchestrator' || !status.installed) {
    return [];
  }

  return status.providers
    .filter((provider) => !isHydratedMultimodelProviderStatus(provider))
    .map((provider) => provider.providerId);
}

export function getModelOnlyFallbackProviderIds(
  status: CliInstallationStatus | null
): CliProviderId[] {
  if (status?.flavor !== 'agent_teams_orchestrator' || !status.installed) {
    return [];
  }

  return status.providers
    .filter((provider) => isModelOnlyFallbackProviderStatus(provider))
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
  return status.providers.reduce<Partial<Record<CliProviderId, boolean>>>(
    (nextLoading, provider) => ({
      ...nextLoading,
      [provider.providerId]: incompleteProviderIds.has(provider.providerId),
    }),
    { ...currentLoading }
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
      return currentProvider;
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
      isHydratedMultimodelProviderStatus(currentProvider)
    ) {
      providers.push(currentProvider);
    }
  }

  const authenticatedProvider = providers.find((provider) => provider.authenticated) ?? null;

  const mergedProviders = areArraysEqual(providers, current.providers, Object.is)
    ? current.providers
    : providers;

  const merged: CliInstallationStatus = {
    ...incoming,
    providers: mergedProviders,
    authLoggedIn: mergedProviders.some((provider) => provider.authenticated),
    authMethod: authenticatedProvider?.authMethod ?? null,
  };

  if (isCliInstallationStatusContentEqual(current, merged)) {
    return current;
  }

  return merged;
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
  return Object.values(providerLoading).some((loading) => loading === true);
}

function getAuthenticatedProvider(providers: CliProviderStatus[]): CliProviderStatus | null {
  return providers.find((provider) => provider.authenticated) ?? null;
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
    authLoggedIn: providers.some((provider) => provider.authenticated),
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
      return 'OpenCode (75+ LLM providers)';
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
    )!;

  return {
    ...currentProvider,
    providerId: params.providerId,
    displayName: currentProvider.displayName ?? getProviderDisplayName(params.providerId),
    authenticated: false,
    authMethod: null,
    verificationState: 'error',
    statusMessage: params.message,
    detailMessage: null,
  };
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
  bootstrapCliStatus: (options?: { multimodelEnabled?: boolean }) => Promise<void>;
  fetchCliStatus: () => Promise<void>;
  fetchCliProviderStatus: (
    providerId: CliProviderId,
    options?: { silent?: boolean; epoch?: number; verifyModels?: boolean }
  ) => Promise<void>;
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
const cliProviderStatusInFlight = new Map<string, Promise<void>>();
let cliStatusEpoch = 0;
const cliProviderStatusSeq = new Map<CliProviderId, number>();
let openCodeRuntimeStatusInFlight: Promise<void> | null = null;
let codexRuntimeStatusInFlight: Promise<void> | null = null;

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
    if (!multimodelEnabled) {
      return get().fetchCliStatus();
    }

    const epoch = ++cliStatusEpoch;
    const providerLoading = Object.fromEntries(
      MULTIMODEL_PROVIDER_IDS.map((providerId) => [providerId, true])
    ) as Partial<Record<CliProviderId, boolean>>;

    set({
      cliStatus: createLoadingMultimodelCliStatus(),
      cliStatusLoading: true,
      cliProviderStatusLoading: providerLoading,
      cliStatusError: null,
    });

    try {
      const metadata = await api.cliInstaller.getStatus();
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

      const nextProviderLoading = Object.fromEntries(
        MULTIMODEL_PROVIDER_IDS.map((providerId) => [
          providerId,
          !isHydratedMultimodelProviderStatus(
            metadata.providers.find((provider) => provider.providerId === providerId)
          ),
        ])
      ) as Partial<Record<CliProviderId, boolean>>;
      const pendingProviderIds = MULTIMODEL_PROVIDER_IDS.filter(
        (providerId) => nextProviderLoading[providerId] === true
      );

      set((state) => {
        if (epoch !== cliStatusEpoch || !state.cliStatus) {
          return {};
        }

        const nextCliStatus = mergeCliStatusPreservingHydratedProviders(state.cliStatus, metadata);
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

      if (!metadata.installed) {
        if (epoch === cliStatusEpoch) {
          set({
            cliProviderStatusLoading: {},
          });
        }
        return;
      }

      if (pendingProviderIds.length === 0) {
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
      await Promise.allSettled(
        MULTIMODEL_PROVIDER_IDS.map((providerId) =>
          get().fetchCliProviderStatus(providerId, {
            silent: false,
            epoch,
          })
        )
      );
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
        if (status.installed) {
          for (const provider of status.providers) {
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
    if (!api.cliInstaller) return;
    if (get().cliStatus && !get().cliStatus?.installed) {
      return;
    }
    const verifyModels = options?.verifyModels === true && providerId !== 'opencode';
    const requestKey = `${providerId}:${verifyModels ? 'verify' : 'status'}`;
    const inFlight = cliProviderStatusInFlight.get(requestKey);
    if (inFlight) return inFlight;

    const requestEpoch = options?.epoch ?? cliStatusEpoch;
    const requestSeq = (cliProviderStatusSeq.get(providerId) ?? 0) + 1;
    const silent = options?.silent === true;
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
          const hasProvider = settledCliStatus.providers.some(
            (provider) => provider.providerId === providerId
          );
          const nextProviders = hasProvider
            ? settledCliStatus.providers.map((provider) =>
                provider.providerId === providerId ? providerStatus : provider
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
      } catch (error) {
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
      } finally {
        cliProviderStatusInFlight.delete(requestKey);
      }
    })();

    cliProviderStatusInFlight.set(requestKey, request);
    return request;
  },

  invalidateCliStatus: async () => {
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
        set({ openCodeRuntimeError: message });
      } finally {
        set({ openCodeRuntimeStatusLoading: false });
        openCodeRuntimeStatusInFlight = null;
      }
    })();

    return openCodeRuntimeStatusInFlight;
  },

  installOpenCodeRuntime: async () => {
    if (!api.openCodeRuntime) return;
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
      if (status.installed) {
        await api.openCodeRuntime.invalidateStatus();
        await refreshOpenCodeProviderStatusAfterRuntimeInstall(get);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to install OpenCode runtime';
      logger.error('Failed to install OpenCode runtime:', error);
      set({ openCodeRuntimeError: message });
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
    set({
      codexRuntimeStatusLoading: true,
      codexRuntimeError: null,
      codexRuntimeStatus: {
        installed: false,
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
      if (status.installed) {
        await api.codexRuntime.invalidateStatus();
        await refreshCodexProviderStatusAfterRuntimeInstall(get);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to install Codex runtime';
      logger.error('Failed to install Codex runtime:', error);
      set({ codexRuntimeError: message });
    } finally {
      set({ codexRuntimeStatusLoading: false });
    }
  },

  invalidateCodexRuntimeStatus: async () => {
    await api.codexRuntime?.invalidateStatus();
    set({ codexRuntimeStatus: null });
  },
});
