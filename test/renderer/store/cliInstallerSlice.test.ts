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
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';

import type { CliInstallationStatus } from '@shared/types';

function createMultimodelProvider(
  overrides: Partial<CliInstallationStatus['providers'][number]> & {
    providerId: 'anthropic' | 'codex' | 'gemini';
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
    connection: null,
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    ...overrides,
  };
}

describe('cliInstallerSlice', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Reset store state
    useStore.setState({
      cliStatus: null,
      cliInstallerState: 'idle',
      cliDownloadProgress: 0,
      cliDownloadTransferred: 0,
      cliDownloadTotal: 0,
      cliInstallerError: null,
      cliCompletedVersion: null,
    });
  });

  afterEach(() => {
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
        gemini: false,
      });
      expect(api.cliInstaller.getProviderStatus).not.toHaveBeenCalled();
    });

    it('drops global loading once metadata is ready and keeps only unresolved providers loading', async () => {
      let resolveCodexStatus!: (
        value: CliInstallationStatus['providers'][number]
      ) => void;
      const pendingCodexStatus = new Promise<CliInstallationStatus['providers'][number]>((resolve) => {
        resolveCodexStatus = resolve;
      });
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
        gemini: false,
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
        gemini: false,
      });
      expect(useStore.getState().cliStatus?.providers.find((provider) => provider.providerId === 'codex'))
        .toMatchObject({
          authenticated: true,
          statusMessage: 'ChatGPT account ready',
        });
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
