import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock api module
vi.mock('@renderer/api', () => ({
  api: {
    cliInstaller: {
      getStatus: vi.fn(),
      getProviderStatus: vi.fn(),
      verifyProviderModels: vi.fn(),
      invalidateStatus: vi.fn(),
      install: vi.fn(),
      onProgress: vi.fn(() => vi.fn()),
    },
    openCodeRuntime: {
      getStatus: vi.fn(),
      install: vi.fn(),
      invalidateStatus: vi.fn(),
      onProgress: vi.fn(() => vi.fn()),
    },
    // Minimal stubs for other api methods referenced by store slices
    getProjects: vi.fn(() => Promise.resolve([])),
    getSessions: vi.fn(() => Promise.resolve([])),
    notifications: {
      get: vi.fn(() =>
        Promise.resolve({
          notifications: [],
          total: 0,
          totalCount: 0,
          unreadCount: 0,
          hasMore: false,
        })
      ),
      getUnreadCount: vi.fn(() => Promise.resolve(0)),
      onNew: vi.fn(),
      onUpdated: vi.fn(),
      onClicked: vi.fn(),
    },
    config: { get: vi.fn(() => Promise.resolve({})) },
    updater: { check: vi.fn(), onStatus: vi.fn() },
    context: {
      getActive: vi.fn(() => Promise.resolve('local')),
      list: vi.fn(),
      onChanged: vi.fn(),
    },
    teams: {
      list: vi.fn(() => Promise.resolve([])),
      onTeamChange: vi.fn(),
      onProvisioningProgress: vi.fn(),
    },
    ssh: { onStatus: vi.fn() },
    onFileChange: vi.fn(),
    onTodoChange: vi.fn(),
    getAppVersion: vi.fn(() => Promise.resolve('1.0.0')),
  },
  isElectronMode: () => true,
}));

import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import {
  getIncompleteMultimodelProviderIds,
  getModelOnlyFallbackProviderIds,
  mergeCliStatusPreservingHydratedProviders,
  reconcileMultimodelProviderLoading,
} from '@renderer/store/slices/cliInstallerSlice';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';

import type { CliInstallationStatus } from '@shared/types';
import type { CliProviderId } from '@shared/types/cliInstaller';

function createMultimodelProvider(
  overrides: Partial<CliInstallationStatus['providers'][number]> & {
    providerId: CliProviderId;
    displayName: string;
  }
): CliInstallationStatus['providers'][number] {
  return {
    supported: true,
    authenticated: false,
    authMethod: null,
    verificationState: 'verified',
    statusMessage: null,
    models: [],
    modelVerificationState: 'idle',
    modelAvailability: [],
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    backend: null,
    connection: {
      supportsOAuth: false,
      supportsApiKey: false,
      configurableAuthModes: [],
      configuredAuthMode: null,
      apiKeyConfigured: false,
      apiKeySource: null,
    },
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    ...overrides,
  };
}

function createMultimodelStatus(
  providers: CliInstallationStatus['providers']
): CliInstallationStatus {
  const authenticatedProvider = providers.find((provider) => provider.authenticated) ?? null;

  return {
    flavor: 'agent_teams_orchestrator',
    displayName: 'Multimodel runtime',
    supportsSelfUpdate: false,
    showVersionDetails: false,
    showBinaryPath: true,
    installed: true,
    installedVersion: '0.0.3',
    binaryPath: '/Users/belief/.agent-teams/runtime-cache/0.0.3/darwin-arm64/claude-multimodel',
    latestVersion: null,
    updateAvailable: false,
    authLoggedIn: providers.some((provider) => provider.authenticated),
    authStatusChecking: false,
    authMethod: authenticatedProvider?.authMethod ?? null,
    providers,
  };
}

describe('cliInstallerSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store state
    useStore.setState({
      cliStatus: null,
      cliStatusLoading: false,
      cliProviderStatusLoading: {},
      cliStatusError: null,
      cliInstallerState: 'idle',
      cliDownloadProgress: 0,
      cliDownloadTransferred: 0,
      cliDownloadTotal: 0,
      cliInstallerError: null,
      cliCompletedVersion: null,
      openCodeRuntimeStatus: null,
      openCodeRuntimeStatusLoading: false,
      openCodeRuntimeError: null,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('initial state', () => {
    it('has correct defaults', () => {
      const state = useStore.getState();
      expect(state.cliStatus).toBeNull();
      expect(state.cliInstallerState).toBe('idle');
      expect(state.cliDownloadProgress).toBe(0);
      expect(state.cliInstallerError).toBeNull();
    });
  });

  describe('mergeCliStatusPreservingHydratedProviders', () => {
    it('keeps cached OpenCode models without preserving stale runtime auth status', () => {
      const current = createMultimodelStatus([
        createMultimodelProvider({
          providerId: 'opencode',
          displayName: 'OpenCode',
          authenticated: true,
          authMethod: 'opencode_managed',
          models: ['opencode/minimax-m2.5-free'],
          canLoginFromUi: false,
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
        }),
      ]);
      const incoming = createMultimodelStatus([
        createMultimodelProvider({
          providerId: 'opencode',
          displayName: 'OpenCode',
          supported: false,
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          statusMessage: null,
          models: ['opencode/minimax-m2.5-free'],
          canLoginFromUi: false,
          capabilities: {
            teamLaunch: false,
            oneShot: false,
            extensions: createDefaultCliExtensionCapabilities(),
          },
          backend: null,
          availableBackends: [],
        }),
      ]);

      const merged = mergeCliStatusPreservingHydratedProviders(current, incoming);

      expect(merged.providers.find((provider) => provider.providerId === 'opencode')).toMatchObject(
        {
          supported: false,
          authenticated: false,
          authMethod: null,
          backend: null,
          models: ['opencode/minimax-m2.5-free'],
        }
      );
    });

    it('classifies model-only OpenCode fallback as incomplete for progress events', () => {
      const status = createMultimodelStatus([
        createMultimodelProvider({
          providerId: 'opencode',
          displayName: 'OpenCode',
          supported: false,
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          statusMessage: null,
          models: ['opencode/minimax-m2.5-free'],
          canLoginFromUi: false,
          capabilities: {
            teamLaunch: false,
            oneShot: false,
            extensions: createDefaultCliExtensionCapabilities(),
          },
          backend: null,
          availableBackends: [],
        }),
      ]);

      expect(getIncompleteMultimodelProviderIds(status)).toEqual(['opencode']);
      expect(getModelOnlyFallbackProviderIds(status)).toEqual(['opencode']);
    });

    it('classifies OpenCode summary-only model lists as incomplete until catalog hydration', () => {
      const status = createMultimodelStatus([
        createMultimodelProvider({
          providerId: 'opencode',
          displayName: 'OpenCode',
          authenticated: true,
          authMethod: 'opencode_managed',
          models: ['opencode/big-pickle'],
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          runtimeCapabilities: {
            modelCatalog: {
              dynamic: true,
              source: 'app-server',
            },
          },
        }),
      ]);

      expect(getIncompleteMultimodelProviderIds(status)).toEqual(['opencode']);
      expect(getModelOnlyFallbackProviderIds(status)).toEqual([]);
    });

    it('keeps connection-enriched checking placeholders incomplete until provider hydration finishes', () => {
      const status = createMultimodelStatus([
        createMultimodelProvider({
          providerId: 'opencode',
          displayName: 'OpenCode',
          supported: false,
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          statusMessage: 'Checking...',
          models: [],
          canLoginFromUi: false,
          capabilities: {
            teamLaunch: false,
            oneShot: false,
            extensions: createDefaultCliExtensionCapabilities(),
          },
          backend: null,
          availableBackends: [],
        }),
      ]);

      expect(getIncompleteMultimodelProviderIds(status)).toEqual(['opencode']);
      expect(getModelOnlyFallbackProviderIds(status)).toEqual([]);
    });

    it('clears loading for hydrated providers while keeping pending providers marked', () => {
      const status = createMultimodelStatus([
        createMultimodelProvider({
          providerId: 'anthropic',
          displayName: 'Anthropic',
          authenticated: true,
          authMethod: 'oauth_token',
          statusMessage: null,
          models: ['claude-sonnet-4-5'],
          backend: { kind: 'anthropic', label: 'Anthropic' },
        }),
        createMultimodelProvider({
          providerId: 'codex',
          displayName: 'Codex',
          supported: false,
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          statusMessage: 'Checking...',
          models: [],
          backend: null,
          availableBackends: [],
        }),
      ]);

      expect(
        reconcileMultimodelProviderLoading(status, {
          anthropic: true,
          codex: true,
          opencode: true,
        })
      ).toEqual({
        anthropic: false,
        codex: true,
        opencode: true,
      });
    });

    it('drops stale hidden Gemini loading from multimodel auth checking', () => {
      const status = createMultimodelStatus([
        createMultimodelProvider({
          providerId: 'anthropic',
          displayName: 'Anthropic',
          authenticated: true,
          authMethod: 'oauth_token',
          models: ['claude-sonnet-4-5'],
        }),
        createMultimodelProvider({
          providerId: 'codex',
          displayName: 'Codex',
          authenticated: true,
          authMethod: 'chatgpt',
          models: ['gpt-5.4'],
        }),
        createMultimodelProvider({
          providerId: 'opencode',
          displayName: 'OpenCode',
          authenticated: true,
          authMethod: 'opencode_managed',
          models: ['opencode/big-pickle'],
          canLoginFromUi: false,
        }),
      ]);

      expect(
        reconcileMultimodelProviderLoading(status, {
          anthropic: false,
          codex: false,
          gemini: true,
          opencode: false,
        })
      ).toEqual({
        anthropic: false,
        codex: false,
        opencode: false,
      });
    });

    it('keeps cached OpenCode models when a fresh runtime status reports missing CLI', () => {
      const current = createMultimodelStatus([
        createMultimodelProvider({
          providerId: 'opencode',
          displayName: 'OpenCode',
          authenticated: true,
          authMethod: 'opencode_managed',
          models: ['opencode/minimax-m2.5-free'],
          canLoginFromUi: false,
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
        }),
      ]);
      const incoming = createMultimodelStatus([
        createMultimodelProvider({
          providerId: 'opencode',
          displayName: 'OpenCode',
          supported: false,
          authenticated: false,
          authMethod: null,
          verificationState: 'error',
          statusMessage: 'OpenCode CLI not found',
          models: [],
          canLoginFromUi: false,
          capabilities: {
            teamLaunch: false,
            oneShot: false,
            extensions: createDefaultCliExtensionCapabilities(),
          },
          backend: null,
        }),
      ]);

      const merged = mergeCliStatusPreservingHydratedProviders(current, incoming);

      expect(merged.providers.find((provider) => provider.providerId === 'opencode')).toMatchObject(
        {
          authenticated: false,
          authMethod: null,
          verificationState: 'error',
          statusMessage: 'OpenCode CLI not found',
          models: ['opencode/minimax-m2.5-free'],
        }
      );
    });

    it('still allows real OpenCode runtime errors to replace previous ready status', () => {
      const current = createMultimodelStatus([
        createMultimodelProvider({
          providerId: 'opencode',
          displayName: 'OpenCode',
          authenticated: true,
          authMethod: 'opencode_managed',
          models: ['opencode/minimax-m2.5-free'],
          canLoginFromUi: false,
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
        }),
      ]);
      const incoming = createMultimodelStatus([
        createMultimodelProvider({
          providerId: 'opencode',
          displayName: 'OpenCode',
          supported: false,
          authenticated: false,
          authMethod: null,
          verificationState: 'error',
          statusMessage: 'Runtime not found.',
          models: [],
          canLoginFromUi: false,
          capabilities: {
            teamLaunch: false,
            oneShot: false,
            extensions: createDefaultCliExtensionCapabilities(),
          },
          backend: null,
        }),
      ]);

      const merged = mergeCliStatusPreservingHydratedProviders(current, incoming);

      expect(merged.providers.find((provider) => provider.providerId === 'opencode')).toMatchObject(
        {
          supported: false,
          authenticated: false,
          verificationState: 'error',
          statusMessage: 'Runtime not found.',
        }
      );
    });

    it('drops hydrated hidden Gemini when a fresh frontend status omits it', () => {
      const current = createMultimodelStatus([
        createMultimodelProvider({
          providerId: 'anthropic',
          displayName: 'Anthropic',
          authenticated: false,
          authMethod: null,
          models: ['claude-sonnet-4-5'],
        }),
        createMultimodelProvider({
          providerId: 'gemini',
          displayName: 'Gemini',
          authenticated: true,
          authMethod: 'gemini_api_key',
          models: ['gemini-2.5-pro'],
        }),
      ]);
      const incoming = createMultimodelStatus([
        createMultimodelProvider({
          providerId: 'anthropic',
          displayName: 'Anthropic',
          authenticated: false,
          authMethod: null,
          models: ['claude-sonnet-4-5'],
        }),
        createMultimodelProvider({
          providerId: 'codex',
          displayName: 'Codex',
          authenticated: false,
          authMethod: null,
          models: ['gpt-5.4'],
        }),
        createMultimodelProvider({
          providerId: 'opencode',
          displayName: 'OpenCode',
          authenticated: false,
          authMethod: null,
          models: ['opencode/big-pickle'],
          canLoginFromUi: false,
        }),
      ]);

      const merged = mergeCliStatusPreservingHydratedProviders(current, incoming);

      expect(merged.providers.map((provider) => provider.providerId)).toEqual([
        'anthropic',
        'codex',
        'opencode',
      ]);
      expect(merged.authLoggedIn).toBe(false);
      expect(merged.authMethod).toBeNull();
    });
  });

  describe('OpenCode runtime installer actions', () => {
    it('refreshes OpenCode provider status after a successful app-managed install', async () => {
      const placeholder = createMultimodelProvider({
        providerId: 'opencode',
        displayName: 'OpenCode',
        supported: false,
        authenticated: false,
        authMethod: null,
        verificationState: 'error',
        statusMessage: 'OpenCode CLI is not installed.',
        models: [],
        canLoginFromUi: false,
        capabilities: {
          teamLaunch: false,
          oneShot: false,
          extensions: createDefaultCliExtensionCapabilities(),
        },
        backend: null,
      });
      const refreshed = createMultimodelProvider({
        providerId: 'opencode',
        displayName: 'OpenCode',
        supported: true,
        authenticated: true,
        authMethod: 'opencode_managed',
        models: ['opencode/big-pickle'],
        canLoginFromUi: false,
        backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
      });

      useStore.setState({
        cliStatus: createMultimodelStatus([placeholder]),
      });
      vi.mocked(api.openCodeRuntime.install).mockResolvedValue({
        installed: true,
        binaryPath: '/Users/tester/App Support/runtimes/opencode/current/opencode',
        version: '1.14.48',
        source: 'app-managed',
        state: 'ready',
      });
      vi.mocked(api.cliInstaller.getProviderStatus).mockResolvedValue(refreshed);

      await useStore.getState().installOpenCodeRuntime();

      expect(api.openCodeRuntime.invalidateStatus).toHaveBeenCalledTimes(1);
      expect(api.cliInstaller.invalidateStatus).toHaveBeenCalledTimes(1);
      expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledWith('opencode');
      expect(useStore.getState().openCodeRuntimeStatus).toMatchObject({
        installed: true,
        source: 'app-managed',
        state: 'ready',
      });
      expect(
        useStore
          .getState()
          .cliStatus?.providers.find((provider) => provider.providerId === 'opencode')
      ).toMatchObject({
        supported: true,
        authenticated: true,
        models: ['opencode/big-pickle'],
      });
    });

    it('retries OpenCode provider refresh after install until models appear', async () => {
      vi.useFakeTimers();

      const stale = createMultimodelProvider({
        providerId: 'opencode',
        displayName: 'OpenCode',
        supported: false,
        authenticated: false,
        authMethod: null,
        verificationState: 'error',
        statusMessage: 'OpenCode CLI not found',
        models: [],
        canLoginFromUi: false,
        capabilities: {
          teamLaunch: false,
          oneShot: false,
          extensions: createDefaultCliExtensionCapabilities(),
        },
        backend: null,
      });
      const refreshed = createMultimodelProvider({
        providerId: 'opencode',
        displayName: 'OpenCode',
        supported: true,
        authenticated: true,
        authMethod: 'opencode_managed',
        models: ['opencode/big-pickle'],
        canLoginFromUi: false,
        backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
      });

      useStore.setState({
        cliStatus: createMultimodelStatus([stale]),
      });
      vi.mocked(api.openCodeRuntime.install).mockResolvedValue({
        installed: true,
        binaryPath: '/Users/tester/App Support/runtimes/opencode/current/opencode',
        version: '1.14.48',
        source: 'app-managed',
        state: 'ready',
      });
      vi.mocked(api.cliInstaller.getProviderStatus)
        .mockResolvedValueOnce(stale)
        .mockResolvedValueOnce(refreshed);

      const installPromise = useStore.getState().installOpenCodeRuntime();

      await vi.waitFor(() => {
        expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(1);
      });
      await vi.runOnlyPendingTimersAsync();
      await installPromise;

      expect(api.cliInstaller.invalidateStatus).toHaveBeenCalledTimes(2);
      expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(2);
      expect(
        useStore
          .getState()
          .cliStatus?.providers.find((provider) => provider.providerId === 'opencode')
      ).toMatchObject({
        supported: true,
        authenticated: true,
        models: ['opencode/big-pickle'],
      });
    });
  });

  describe('fetchCliStatus', () => {
    it('updates cliStatus from API', async () => {
      const mockStatus: CliInstallationStatus = {
        flavor: 'claude',
        displayName: 'Claude CLI',
        supportsSelfUpdate: true,
        showVersionDetails: true,
        showBinaryPath: true,
        installed: true,
        installedVersion: '2.1.59',
        binaryPath: '/usr/local/bin/claude',
        latestVersion: '2.1.59',
        updateAvailable: false,
        authLoggedIn: false,
        authStatusChecking: false,
        authMethod: null,
        providers: [],
      };
      vi.mocked(api.cliInstaller.getStatus).mockResolvedValue(mockStatus);

      await useStore.getState().fetchCliStatus();

      expect(useStore.getState().cliStatus).toEqual(mockStatus);
    });

    it('handles API errors gracefully', async () => {
      vi.mocked(api.cliInstaller.getStatus).mockRejectedValue(new Error('Network error'));

      await useStore.getState().fetchCliStatus();

      // Should not throw, status remains null
      expect(useStore.getState().cliStatus).toBeNull();
    });

    it('detects update available', async () => {
      const mockStatus: CliInstallationStatus = {
        flavor: 'claude',
        displayName: 'Claude CLI',
        supportsSelfUpdate: true,
        showVersionDetails: true,
        showBinaryPath: true,
        installed: true,
        installedVersion: '2.1.34',
        binaryPath: '/usr/local/bin/claude',
        latestVersion: '2.1.59',
        updateAvailable: true,
        authLoggedIn: true,
        authStatusChecking: false,
        authMethod: 'oauth_token',
        providers: [],
      };
      vi.mocked(api.cliInstaller.getStatus).mockResolvedValue(mockStatus);

      await useStore.getState().fetchCliStatus();

      expect(useStore.getState().cliStatus?.updateAvailable).toBe(true);
    });
  });

  describe('bootstrapCliStatus', () => {
    it('falls back to the full Claude status if multimodel bootstrap resolves a claude flavor', async () => {
      const mockStatus: CliInstallationStatus = {
        flavor: 'claude',
        displayName: 'Claude CLI',
        supportsSelfUpdate: true,
        showVersionDetails: true,
        showBinaryPath: true,
        installed: true,
        installedVersion: '2.1.100',
        binaryPath: '/Users/belief/.local/bin/claude',
        latestVersion: '2.1.100',
        updateAvailable: false,
        authLoggedIn: true,
        authStatusChecking: false,
        authMethod: 'oauth_token',
        providers: [],
      };
      vi.mocked(api.cliInstaller.getStatus).mockResolvedValue(mockStatus);

      await useStore.getState().bootstrapCliStatus({ multimodelEnabled: true });

      expect(useStore.getState().cliStatus).toEqual(mockStatus);
      expect(useStore.getState().cliStatusLoading).toBe(false);
      expect(api.cliInstaller.getProviderStatus).not.toHaveBeenCalled();
    });

    it('does not fetch provider status when the multimodel runtime fails its health check', async () => {
      const mockStatus: CliInstallationStatus = {
        flavor: 'agent_teams_orchestrator',
        displayName: 'agent_teams_orchestrator',
        supportsSelfUpdate: false,
        showVersionDetails: false,
        showBinaryPath: true,
        installed: false,
        installedVersion: null,
        binaryPath: '/Users/tester/.claude/local/node_modules/.bin/claude',
        launchError: 'spawn EACCES',
        latestVersion: null,
        updateAvailable: false,
        authLoggedIn: false,
        authStatusChecking: false,
        authMethod: null,
        providers: [
          {
            providerId: 'anthropic',
            displayName: 'Anthropic',
            supported: false,
            authenticated: false,
            authMethod: null,
            verificationState: 'error',
            statusMessage: 'Runtime found, but startup health check failed.',
            models: [],
            canLoginFromUi: false,
            capabilities: {
              teamLaunch: false,
              oneShot: false,
              extensions: createDefaultCliExtensionCapabilities(),
            },
            backend: null,
          },
        ],
      };
      vi.mocked(api.cliInstaller.getStatus).mockResolvedValue(mockStatus);

      await useStore.getState().bootstrapCliStatus({ multimodelEnabled: true });

      expect(useStore.getState().cliStatus).toEqual(mockStatus);
      expect(useStore.getState().cliStatusLoading).toBe(false);
      expect(useStore.getState().cliProviderStatusLoading).toEqual({});
      expect(api.cliInstaller.getProviderStatus).not.toHaveBeenCalled();
    });

    it('reuses hydrated provider statuses from bootstrap metadata without duplicate provider probes', async () => {
      const mockStatus: CliInstallationStatus = {
        flavor: 'agent_teams_orchestrator',
        displayName: 'Multimodel runtime',
        supportsSelfUpdate: false,
        showVersionDetails: false,
        showBinaryPath: true,
        installed: true,
        installedVersion: '0.0.3',
        binaryPath: '/Users/belief/.agent-teams/runtime-cache/0.0.3/darwin-arm64/claude-multimodel',
        latestVersion: null,
        updateAvailable: false,
        authLoggedIn: true,
        authStatusChecking: false,
        authMethod: 'oauth_token',
        providers: [
          createMultimodelProvider({
            providerId: 'anthropic',
            displayName: 'Anthropic',
            authenticated: true,
            authMethod: 'oauth_token',
            statusMessage: 'Connected',
          }),
          createMultimodelProvider({
            providerId: 'codex',
            displayName: 'Codex',
            authenticated: true,
            authMethod: 'chatgpt',
            statusMessage: 'ChatGPT account ready',
          }),
          createMultimodelProvider({
            providerId: 'gemini',
            displayName: 'Gemini',
            statusMessage: 'Ready',
          }),
          createMultimodelProvider({
            providerId: 'opencode',
            displayName: 'OpenCode',
            authenticated: true,
            authMethod: 'opencode_managed',
            statusMessage: 'OpenCode ready',
            canLoginFromUi: false,
          }),
        ],
      };
      vi.mocked(api.cliInstaller.getStatus).mockResolvedValue(mockStatus);

      await useStore.getState().bootstrapCliStatus({ multimodelEnabled: true });

      expect(useStore.getState().cliStatus).toMatchObject({
        ...mockStatus,
        launchError: null,
      });
      expect(useStore.getState().cliProviderStatusLoading).toEqual({
        anthropic: false,
        codex: false,
        opencode: false,
      });
      expect(api.cliInstaller.getProviderStatus).not.toHaveBeenCalled();
    });

    it('drops global loading once metadata is ready and keeps only unresolved providers loading', async () => {
      let resolveCodexStatus!: (value: CliInstallationStatus['providers'][number]) => void;
      const pendingCodexStatus = new Promise<CliInstallationStatus['providers'][number]>(
        (resolve) => {
          resolveCodexStatus = resolve;
        }
      );
      const mockStatus: CliInstallationStatus = {
        flavor: 'agent_teams_orchestrator',
        displayName: 'Multimodel runtime',
        supportsSelfUpdate: false,
        showVersionDetails: false,
        showBinaryPath: true,
        installed: true,
        installedVersion: '0.0.3',
        binaryPath: '/Users/belief/.agent-teams/runtime-cache/0.0.3/darwin-arm64/claude-multimodel',
        latestVersion: null,
        updateAvailable: false,
        authLoggedIn: true,
        authStatusChecking: true,
        authMethod: 'oauth_token',
        providers: [
          createMultimodelProvider({
            providerId: 'anthropic',
            displayName: 'Anthropic',
            authenticated: true,
            authMethod: 'oauth_token',
            statusMessage: 'Connected',
          }),
          createMultimodelProvider({
            providerId: 'codex',
            displayName: 'Codex',
            supported: false,
            authenticated: false,
            authMethod: null,
            verificationState: 'unknown',
            statusMessage: 'Checking...',
            models: [],
            backend: null,
            connection: null,
            availableBackends: [],
          }),
          createMultimodelProvider({
            providerId: 'gemini',
            displayName: 'Gemini',
            statusMessage: 'Ready',
          }),
          createMultimodelProvider({
            providerId: 'opencode',
            displayName: 'OpenCode',
            authenticated: true,
            authMethod: 'opencode_managed',
            statusMessage: 'OpenCode ready',
            canLoginFromUi: false,
          }),
        ],
      };
      vi.mocked(api.cliInstaller.getStatus).mockResolvedValue(mockStatus);
      vi.mocked(api.cliInstaller.getProviderStatus).mockImplementation(async (providerId) => {
        if (providerId === 'codex') {
          return pendingCodexStatus;
        }
        throw new Error(`Unexpected provider status request for ${providerId}`);
      });

      const bootstrapPromise = useStore.getState().bootstrapCliStatus({ multimodelEnabled: true });

      await vi.waitFor(() => {
        expect(useStore.getState().cliStatusLoading).toBe(false);
      });

      expect(useStore.getState().cliProviderStatusLoading).toEqual({
        anthropic: false,
        codex: true,
        opencode: false,
      });
      expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(1);
      expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledWith('codex');

      resolveCodexStatus(
        createMultimodelProvider({
          providerId: 'codex',
          displayName: 'Codex',
          authenticated: true,
          authMethod: 'chatgpt',
          statusMessage: 'ChatGPT account ready',
        })
      );
      await bootstrapPromise;

      expect(useStore.getState().cliProviderStatusLoading).toEqual({
        anthropic: false,
        codex: false,
        opencode: false,
      });
      expect(
        useStore.getState().cliStatus?.providers.find((provider) => provider.providerId === 'codex')
      ).toMatchObject({
        authenticated: true,
        statusMessage: 'ChatGPT account ready',
      });
    });

    it('refreshes OpenCode when bootstrap metadata only has fallback models', async () => {
      const mockStatus: CliInstallationStatus = {
        flavor: 'agent_teams_orchestrator',
        displayName: 'Multimodel runtime',
        supportsSelfUpdate: false,
        showVersionDetails: false,
        showBinaryPath: true,
        installed: true,
        installedVersion: '0.0.3',
        binaryPath: '/Users/belief/.agent-teams/runtime-cache/0.0.3/darwin-arm64/claude-multimodel',
        latestVersion: null,
        updateAvailable: false,
        authLoggedIn: true,
        authStatusChecking: true,
        authMethod: 'oauth_token',
        providers: [
          createMultimodelProvider({
            providerId: 'anthropic',
            displayName: 'Anthropic',
            authenticated: true,
            authMethod: 'oauth_token',
            statusMessage: 'Connected',
          }),
          createMultimodelProvider({
            providerId: 'codex',
            displayName: 'Codex',
            statusMessage: 'Codex unavailable',
          }),
          createMultimodelProvider({
            providerId: 'gemini',
            displayName: 'Gemini',
            statusMessage: 'Ready',
          }),
          createMultimodelProvider({
            providerId: 'opencode',
            displayName: 'OpenCode',
            supported: false,
            authenticated: false,
            authMethod: null,
            verificationState: 'unknown',
            statusMessage: null,
            models: ['opencode/minimax-m2.5-free'],
            canLoginFromUi: false,
            capabilities: {
              teamLaunch: false,
              oneShot: false,
              extensions: createDefaultCliExtensionCapabilities(),
            },
            backend: null,
            availableBackends: [],
          }),
        ],
      };
      vi.mocked(api.cliInstaller.getStatus).mockResolvedValue(mockStatus);
      vi.mocked(api.cliInstaller.getProviderStatus).mockImplementation((providerId) => {
        if (providerId === 'opencode') {
          return Promise.resolve(
            createMultimodelProvider({
              providerId: 'opencode',
              displayName: 'OpenCode',
              authenticated: true,
              authMethod: 'opencode_managed',
              statusMessage: null,
              models: ['opencode/minimax-m2.5-free'],
              canLoginFromUi: false,
              backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
            })
          );
        }
        return Promise.reject(new Error(`Unexpected provider status request for ${providerId}`));
      });

      await useStore.getState().bootstrapCliStatus({ multimodelEnabled: true });

      expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(1);
      expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledWith('opencode');
      expect(useStore.getState().cliProviderStatusLoading).toEqual({
        anthropic: false,
        codex: false,
        opencode: false,
      });
      expect(
        useStore
          .getState()
          .cliStatus?.providers.find((provider) => provider.providerId === 'opencode')
      ).toMatchObject({
        supported: true,
        authenticated: true,
        authMethod: 'opencode_managed',
        backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
      });
    });

    it('refreshes OpenCode when bootstrap metadata has summary-only big-pickle models', async () => {
      const mockStatus = createMultimodelStatus([
        createMultimodelProvider({
          providerId: 'anthropic',
          displayName: 'Anthropic',
          authenticated: true,
          authMethod: 'oauth_token',
          models: ['claude-sonnet-4-5'],
          backend: { kind: 'anthropic', label: 'Anthropic' },
        }),
        createMultimodelProvider({
          providerId: 'codex',
          displayName: 'Codex',
          authenticated: true,
          authMethod: 'chatgpt',
          models: ['gpt-5.4'],
          backend: { kind: 'codex-native', label: 'Codex' },
        }),
        createMultimodelProvider({
          providerId: 'opencode',
          displayName: 'OpenCode',
          authenticated: true,
          authMethod: 'opencode_managed',
          models: ['opencode/big-pickle'],
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          runtimeCapabilities: {
            modelCatalog: {
              dynamic: true,
              source: 'app-server',
            },
          },
        }),
      ]);
      vi.mocked(api.cliInstaller.getStatus).mockResolvedValue(mockStatus);
      vi.mocked(api.cliInstaller.getProviderStatus).mockImplementation((providerId) => {
        if (providerId === 'opencode') {
          return Promise.resolve(
            createMultimodelProvider({
              providerId: 'opencode',
              displayName: 'OpenCode',
              authenticated: true,
              authMethod: 'opencode_managed',
              models: [
                'opencode/big-pickle',
                'openai/gpt-5.4',
                'openrouter/openai/gpt-oss-20b:free',
              ],
              modelCatalogRefreshState: 'ready',
              modelCatalog: {
                schemaVersion: 1,
                providerId: 'opencode',
                source: 'app-server',
                status: 'ready',
                fetchedAt: '2026-05-20T00:00:00.000Z',
                staleAt: '2026-05-20T00:10:00.000Z',
                defaultModelId: 'opencode/big-pickle',
                defaultLaunchModel: 'opencode/big-pickle',
                models: [
                  {
                    id: 'opencode/big-pickle',
                    launchModel: 'opencode/big-pickle',
                    displayName: 'opencode/big-pickle',
                    hidden: false,
                    supportedReasoningEfforts: [],
                    defaultReasoningEffort: null,
                    inputModalities: ['text'],
                    supportsPersonality: true,
                    isDefault: true,
                    upgrade: false,
                    source: 'app-server',
                    badgeLabel: 'Free',
                  },
                  {
                    id: 'openai/gpt-5.4',
                    launchModel: 'openai/gpt-5.4',
                    displayName: 'openai/gpt-5.4',
                    hidden: false,
                    supportedReasoningEfforts: [],
                    defaultReasoningEffort: null,
                    inputModalities: ['text'],
                    supportsPersonality: true,
                    isDefault: false,
                    upgrade: false,
                    source: 'app-server',
                  },
                  {
                    id: 'openrouter/openai/gpt-oss-20b:free',
                    launchModel: 'openrouter/openai/gpt-oss-20b:free',
                    displayName: 'openrouter/openai/gpt-oss-20b:free',
                    hidden: false,
                    supportedReasoningEfforts: [],
                    defaultReasoningEffort: null,
                    inputModalities: ['text'],
                    supportsPersonality: true,
                    isDefault: false,
                    upgrade: false,
                    source: 'app-server',
                    badgeLabel: 'Free',
                  },
                ],
                diagnostics: {
                  configReadState: 'ready',
                  appServerState: 'healthy',
                },
              },
              backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
              runtimeCapabilities: {
                modelCatalog: {
                  dynamic: true,
                  source: 'app-server',
                },
              },
            })
          );
        }
        return Promise.reject(new Error(`Unexpected provider status request for ${providerId}`));
      });

      await useStore.getState().bootstrapCliStatus({ multimodelEnabled: true });

      expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledTimes(1);
      expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledWith('opencode');
      const opencode = useStore
        .getState()
        .cliStatus?.providers.find((provider) => provider.providerId === 'opencode');
      expect(opencode?.models).toEqual([
        'opencode/big-pickle',
        'openai/gpt-5.4',
        'openrouter/openai/gpt-oss-20b:free',
      ]);
      expect(opencode?.modelCatalog?.models).toHaveLength(3);
    });
  });

  describe('installCli', () => {
    it('sets state to checking and calls API', () => {
      vi.mocked(api.cliInstaller.install).mockResolvedValue(undefined);

      useStore.getState().installCli();

      expect(useStore.getState().cliInstallerState).toBe('checking');
      expect(useStore.getState().cliInstallerError).toBeNull();
      expect(api.cliInstaller.install).toHaveBeenCalled();
    });

    it('resets download progress on new install', () => {
      useStore.setState({
        cliDownloadProgress: 50,
        cliDownloadTransferred: 100_000_000,
        cliDownloadTotal: 200_000_000,
      });

      vi.mocked(api.cliInstaller.install).mockResolvedValue(undefined);

      useStore.getState().installCli();

      expect(useStore.getState().cliDownloadProgress).toBe(0);
      expect(useStore.getState().cliDownloadTransferred).toBe(0);
      expect(useStore.getState().cliDownloadTotal).toBe(0);
    });
  });

  describe('fetchCliProviderStatus', () => {
    it('materializes provider fetch failures into provider-scoped error state', async () => {
      useStore.setState({
        cliStatus: createMultimodelStatus([
          createMultimodelProvider({
            providerId: 'anthropic',
            displayName: 'Anthropic',
            verificationState: 'unknown',
            statusMessage: 'Checking...',
          }),
          createMultimodelProvider({
            providerId: 'codex',
            displayName: 'Codex',
            authenticated: true,
            authMethod: 'chatgpt',
            statusMessage: 'ChatGPT account ready',
          }),
        ]),
      });
      vi.mocked(api.cliInstaller.getProviderStatus).mockRejectedValue(
        new Error('Failed to refresh anthropic status')
      );

      await useStore.getState().fetchCliProviderStatus('anthropic');

      expect(useStore.getState().cliProviderStatusLoading).toEqual({
        anthropic: false,
      });
      expect(useStore.getState().cliStatusError).toBe('Failed to refresh anthropic status');
      expect(
        useStore
          .getState()
          .cliStatus?.providers.find((provider) => provider.providerId === 'anthropic')
      ).toMatchObject({
        displayName: 'Anthropic',
        authenticated: false,
        authMethod: null,
        verificationState: 'error',
        statusMessage: 'Failed to refresh anthropic status',
      });
      expect(useStore.getState().cliStatus?.authStatusChecking).toBe(false);
    });

    it('ignores hidden Gemini provider failures without keeping global auth checking active', async () => {
      useStore.setState({
        cliStatus: createMultimodelStatus([
          createMultimodelProvider({
            providerId: 'anthropic',
            displayName: 'Anthropic',
            authenticated: true,
            authMethod: 'oauth_token',
            models: ['claude-sonnet-4-5'],
          }),
        ]),
      });
      vi.mocked(api.cliInstaller.getProviderStatus).mockRejectedValue(
        new Error('Gemini status unavailable')
      );

      await useStore.getState().fetchCliProviderStatus('gemini');

      expect(useStore.getState().cliProviderStatusLoading).toEqual({
        gemini: false,
      });
      expect(useStore.getState().cliStatus?.authLoggedIn).toBe(true);
      expect(useStore.getState().cliStatus?.authStatusChecking).toBe(false);
      expect(
        useStore
          .getState()
          .cliStatus?.providers.find((provider) => provider.providerId === 'gemini')
      ).toBeUndefined();
    });

    it('ignores hidden Gemini provider success responses in multimodel frontend state', async () => {
      useStore.setState({
        cliStatus: createMultimodelStatus([
          createMultimodelProvider({
            providerId: 'anthropic',
            displayName: 'Anthropic',
            authenticated: false,
            authMethod: null,
            models: ['claude-sonnet-4-5'],
          }),
        ]),
      });
      vi.mocked(api.cliInstaller.getProviderStatus).mockResolvedValue(
        createMultimodelProvider({
          providerId: 'gemini',
          displayName: 'Gemini',
          authenticated: true,
          authMethod: 'gemini_api_key',
          models: ['gemini-2.5-pro'],
        })
      );

      await useStore.getState().fetchCliProviderStatus('gemini');

      expect(useStore.getState().cliProviderStatusLoading).toEqual({
        gemini: false,
      });
      expect(useStore.getState().cliStatus?.authLoggedIn).toBe(false);
      expect(useStore.getState().cliStatus?.authMethod).toBeNull();
      expect(
        useStore
          .getState()
          .cliStatus?.providers.find((provider) => provider.providerId === 'gemini')
      ).toBeUndefined();
    });

    it('marks authStatusChecking true while a multimodel provider refresh is in flight and clears it on success', async () => {
      let resolveProviderStatus!: (value: CliInstallationStatus['providers'][number]) => void;
      const pendingProviderStatus = new Promise<CliInstallationStatus['providers'][number]>(
        (resolve) => {
          resolveProviderStatus = resolve;
        }
      );

      useStore.setState({
        cliStatus: createMultimodelStatus([
          createMultimodelProvider({
            providerId: 'anthropic',
            displayName: 'Anthropic',
            authenticated: true,
            authMethod: 'oauth_token',
            statusMessage: 'Connected',
          }),
        ]),
      });
      vi.mocked(api.cliInstaller.getProviderStatus).mockImplementation(async (providerId) => {
        if (providerId === 'anthropic') {
          return pendingProviderStatus;
        }

        throw new Error(`Unexpected provider status request for ${providerId}`);
      });

      const refreshPromise = useStore.getState().fetchCliProviderStatus('anthropic');

      await vi.waitFor(() => {
        expect(useStore.getState().cliStatus?.authStatusChecking).toBe(true);
      });

      expect(useStore.getState().cliProviderStatusLoading).toEqual({
        anthropic: true,
      });

      resolveProviderStatus(
        createMultimodelProvider({
          providerId: 'anthropic',
          displayName: 'Anthropic',
          authenticated: true,
          authMethod: 'oauth_token',
          statusMessage: 'Connected',
        })
      );
      await refreshPromise;

      expect(useStore.getState().cliProviderStatusLoading).toEqual({
        anthropic: false,
      });
      expect(useStore.getState().cliStatus?.authStatusChecking).toBe(false);
    });

    it('keeps cached catalog on summary-only provider refresh without stale auth', async () => {
      const currentProvider = createMultimodelProvider({
        providerId: 'codex',
        displayName: 'Codex',
        authenticated: true,
        authMethod: 'chatgpt',
        statusMessage: 'ChatGPT account ready',
        models: ['gpt-5.4'],
        modelCatalogRefreshState: 'ready',
        modelCatalog: {
          schemaVersion: 1,
          providerId: 'codex',
          source: 'app-server',
          status: 'ready',
          fetchedAt: '2026-05-17T00:00:00.000Z',
          staleAt: '2026-05-17T00:10:00.000Z',
          defaultModelId: 'gpt-5.4',
          defaultLaunchModel: 'gpt-5.4',
          models: [
            {
              id: 'gpt-5.4',
              launchModel: 'gpt-5.4',
              displayName: 'GPT-5.4',
              hidden: false,
              supportedReasoningEfforts: ['medium'],
              defaultReasoningEffort: 'medium',
              inputModalities: ['text'],
              supportsPersonality: false,
              isDefault: true,
              upgrade: false,
              source: 'app-server',
            },
          ],
          diagnostics: {
            configReadState: 'skipped',
            appServerState: 'healthy',
          },
        },
      });

      useStore.setState({
        cliStatus: createMultimodelStatus([currentProvider]),
      });
      vi.mocked(api.cliInstaller.getProviderStatus).mockResolvedValue(
        createMultimodelProvider({
          providerId: 'codex',
          displayName: 'Codex',
          authenticated: false,
          authMethod: null,
          statusMessage: 'Not connected',
          models: [],
          modelCatalog: null,
          modelCatalogRefreshState: 'loading',
          runtimeCapabilities: {
            modelCatalog: {
              dynamic: true,
              source: 'app-server',
            },
          },
        })
      );

      await useStore.getState().fetchCliProviderStatus('codex');

      const provider = useStore
        .getState()
        .cliStatus?.providers.find((candidate) => candidate.providerId === 'codex');
      expect(provider).toMatchObject({
        authenticated: false,
        authMethod: null,
        statusMessage: 'Not connected',
        models: ['gpt-5.4'],
        modelCatalogRefreshState: 'ready',
      });
      expect(provider?.modelCatalog?.defaultModelId).toBe('gpt-5.4');
    });

    it('keeps OpenCode refresh status-only even when model verification is requested', async () => {
      const nextProvider = createMultimodelProvider({
        providerId: 'opencode',
        displayName: 'OpenCode',
        authenticated: true,
        authMethod: 'opencode_managed',
        canLoginFromUi: false,
        models: ['openrouter/openai/gpt-oss-20b:free'],
        modelAvailability: [],
        backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
      });

      useStore.setState({
        cliStatus: createMultimodelStatus([
          createMultimodelProvider({
            providerId: 'opencode',
            displayName: 'OpenCode',
            authenticated: true,
            authMethod: 'opencode_managed',
            canLoginFromUi: false,
            models: ['openrouter/openai/gpt-oss-20b:free'],
            modelAvailability: [
              {
                modelId: 'openrouter/openai/gpt-oss-20b:free',
                status: 'unknown',
                reason: 'old bulk check failed',
                checkedAt: '2026-04-25T00:00:00.000Z',
              },
            ],
            backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          }),
        ]),
      });
      vi.mocked(api.cliInstaller.getProviderStatus).mockResolvedValue(nextProvider);

      await useStore.getState().fetchCliProviderStatus('opencode', { verifyModels: true });

      expect(api.cliInstaller.verifyProviderModels).not.toHaveBeenCalled();
      expect(api.cliInstaller.getProviderStatus).toHaveBeenCalledWith('opencode');
      expect(
        useStore
          .getState()
          .cliStatus?.providers.find((provider) => provider.providerId === 'opencode')
          ?.modelAvailability
      ).toEqual([]);
    });
  });

  describe('progress event handling', () => {
    it('updates download progress from events', () => {
      useStore.setState({
        cliInstallerState: 'downloading',
        cliDownloadProgress: 50,
        cliDownloadTransferred: 100_000_000,
        cliDownloadTotal: 200_000_000,
      });

      const state = useStore.getState();
      expect(state.cliInstallerState).toBe('downloading');
      expect(state.cliDownloadProgress).toBe(50);
    });

    it('tracks completed version', () => {
      useStore.setState({
        cliInstallerState: 'completed',
        cliCompletedVersion: '2.1.59',
      });

      expect(useStore.getState().cliCompletedVersion).toBe('2.1.59');
    });

    it('tracks error state', () => {
      useStore.setState({
        cliInstallerState: 'error',
        cliInstallerError: 'SHA256 checksum mismatch',
      });

      expect(useStore.getState().cliInstallerState).toBe('error');
      expect(useStore.getState().cliInstallerError).toBe('SHA256 checksum mismatch');
    });
  });
});
