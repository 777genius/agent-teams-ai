/**
 * CLI Installer slice — manages CLI installation status and install/update progress.
 */

import { api } from '@renderer/api';
import { createLogger } from '@shared/utils/logger';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';

import type { AppState } from '../types';
import type { CliInstallationStatus, CliProviderId, CliProviderStatus } from '@shared/types';
import type { StateCreator } from 'zustand';

const logger = createLogger('Store:cliInstaller');

/** Max log lines to keep in UI (reserved for future use) */
const _MAX_LOG_LINES = 50;
export const MULTIMODEL_PROVIDER_IDS: CliProviderId[] = ['anthropic', 'codex', 'gemini'];

export function createLoadingMultimodelCliStatus(): CliInstallationStatus {
  const providers: CliProviderStatus[] = (
    [
      { providerId: 'anthropic', displayName: 'Anthropic' },
      { providerId: 'codex', displayName: 'Codex' },
      { providerId: 'gemini', displayName: 'Gemini' },
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
    canLoginFromUi: true,
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

function isHydratedMultimodelProviderStatus(provider: CliProviderStatus | undefined): boolean {
  if (!provider) {
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
    (provider.availableBackends?.length ?? 0) === 0 &&
    provider.connection == null
  );
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

  // Actions
  bootstrapCliStatus: (options?: { multimodelEnabled?: boolean }) => Promise<void>;
  fetchCliStatus: () => Promise<void>;
  fetchCliProviderStatus: (
    providerId: CliProviderId,
    options?: { silent?: boolean; epoch?: number; verifyModels?: boolean }
  ) => Promise<void>;
  invalidateCliStatus: () => Promise<void>;
  installCli: () => void;
}

let cliStatusInFlight: Promise<void> | null = null;
const cliProviderStatusInFlight = new Map<string, Promise<void>>();
let cliStatusEpoch = 0;
const cliProviderStatusSeq = new Map<CliProviderId, number>();

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

          return {
            cliStatus: metadata,
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

        return {
          cliStatus: {
            ...metadata,
            launchError: metadata.launchError ?? null,
            authStatusChecking: metadata.installed && pendingProviderIds.length > 0,
          },
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
        set({ cliStatus: status, cliProviderStatusLoading: {} });
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
    const verifyModels = options?.verifyModels === true;
    const requestKey = `${providerId}:${verifyModels ? 'verify' : 'status'}`;
    const inFlight = cliProviderStatusInFlight.get(requestKey);
    if (inFlight) return inFlight;

    const requestEpoch = options?.epoch ?? cliStatusEpoch;
    const requestSeq = (cliProviderStatusSeq.get(providerId) ?? 0) + 1;
    const silent = options?.silent === true;
    cliProviderStatusSeq.set(providerId, requestSeq);

    const request = (async () => {
      if (!silent) {
        set((state) => ({
          cliStatusError: null,
          cliProviderStatusLoading: {
            ...state.cliProviderStatusLoading,
            [providerId]: true,
          },
        }));
      }

      try {
        const providerStatus = verifyModels
          ? await api.cliInstaller.verifyProviderModels(providerId)
          : await api.cliInstaller.getProviderStatus(providerId);
        set((state) => {
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

          if (!providerStatus || !state.cliStatus) {
            return { cliProviderStatusLoading: nextLoading };
          }

          const hasProvider = state.cliStatus.providers.some(
            (provider) => provider.providerId === providerId
          );
          const nextProviders = hasProvider
            ? state.cliStatus.providers.map((provider) =>
                provider.providerId === providerId ? providerStatus : provider
              )
            : [...state.cliStatus.providers, providerStatus];
          const authenticatedProvider =
            nextProviders.find((provider) => provider.authenticated) ?? null;

          return {
            cliStatus: {
              ...state.cliStatus,
              providers: nextProviders,
              authLoggedIn: nextProviders.some((provider) => provider.authenticated),
              authMethod: authenticatedProvider?.authMethod ?? null,
            },
            cliProviderStatusLoading: nextLoading,
          };
        });
      } catch (error) {
        const message =
          error instanceof Error ? error.message : `Failed to refresh ${providerId} status`;
        logger.error(`Failed to fetch ${providerId} CLI status:`, error);
        set((state) => {
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

          return {
            cliStatusError: message,
            cliProviderStatusLoading: nextLoading,
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
});
