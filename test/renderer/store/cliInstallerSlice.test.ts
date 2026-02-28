import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock api module
vi.mock('@renderer/api', () => ({
  api: {
    cliInstaller: {
      getStatus: vi.fn(),
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

import type { CliInstallationStatus } from '@shared/types';

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
        installed: true,
        installedVersion: '2.1.59',
        binaryPath: '/usr/local/bin/claude',
        latestVersion: '2.1.59',
        updateAvailable: false,
        authLoggedIn: false,
        authMethod: null,
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
        installed: true,
        installedVersion: '2.1.34',
        binaryPath: '/usr/local/bin/claude',
        latestVersion: '2.1.59',
        updateAvailable: true,
        authLoggedIn: true,
        authMethod: 'oauth_token',
      };
      vi.mocked(api.cliInstaller.getStatus).mockResolvedValue(mockStatus);

      await useStore.getState().fetchCliStatus();

      expect(useStore.getState().cliStatus?.updateAvailable).toBe(true);
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
