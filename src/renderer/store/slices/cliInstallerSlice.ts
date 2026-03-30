/**
 * CLI Installer slice — manages CLI installation status and install/update progress.
 */

import { api } from '@renderer/api';
import { createLogger } from '@shared/utils/logger';

import type { AppState } from '../types';
import type { CliInstallationStatus } from '@shared/types';
import type { StateCreator } from 'zustand';

const logger = createLogger('Store:cliInstaller');

/** Max log lines to keep in UI (reserved for future use) */
const _MAX_LOG_LINES = 50;

// =============================================================================
// Slice Interface
// =============================================================================

export interface CliInstallerSlice {
  // State
  cliStatus: CliInstallationStatus | null;
  cliStatusLoading: boolean;
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
  fetchCliStatus: () => Promise<void>;
  invalidateCliStatus: () => Promise<void>;
  installCli: () => void;
}

let cliStatusInFlight: Promise<void> | null = null;

// =============================================================================
// Slice Creator
// =============================================================================

export const createCliInstallerSlice: StateCreator<AppState, [], [], CliInstallerSlice> = (
  set
) => ({
  // Initial state
  cliStatus: null,
  cliStatusLoading: false,
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

  fetchCliStatus: async () => {
    if (!api.cliInstaller) return;
    if (cliStatusInFlight) return cliStatusInFlight;

    cliStatusInFlight = (async () => {
      set({ cliStatusLoading: true, cliStatusError: null });
      try {
        const status = await api.cliInstaller.getStatus();
        set({ cliStatus: status });
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
