/**
 * Update slice - manages OTA auto-update state and actions.
 */

import { api } from '@renderer/api';
import { createLogger } from '@shared/utils/logger';

import type { AppState } from '../types';
import type { StateCreator } from 'zustand';

const logger = createLogger('Store:update');

// =============================================================================
// Slice Interface
// =============================================================================

export interface UpdateSlice {
  // State
  updateStatus:
    | 'idle'
    | 'checking'
    | 'available'
    | 'not-available'
    | 'downloading'
    | 'downloaded'
    | 'error';
  availableVersion: string | null;
  releaseNotes: string | null;
  downloadProgress: number;
  updateError: string | null;
  showUpdateDialog: boolean;
  showUpdateBanner: boolean;

  // Actions
  checkForUpdates: () => void;
  downloadUpdate: () => void;
  installUpdate: () => void;
  dismissUpdateDialog: () => void;
  dismissUpdateBanner: () => void;
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createUpdateSlice: StateCreator<AppState, [], [], UpdateSlice> = (set) => ({
  // Initial state
  updateStatus: 'idle',
  availableVersion: null,
  releaseNotes: null,
  downloadProgress: 0,
  updateError: null,
  showUpdateDialog: false,
  showUpdateBanner: false,

  checkForUpdates: () => {
    set({ updateStatus: 'checking', updateError: null });
    api.updater.check().catch((error) => {
      logger.error('Failed to check for updates:', error);
      set({ updateStatus: 'error', updateError: error instanceof Error ? error.message : 'Check failed' });
    });
  },

  downloadUpdate: () => {
    set({ showUpdateDialog: false, showUpdateBanner: true, downloadProgress: 0 });
    api.updater.download().catch((error) => {
      logger.error('Failed to download update:', error);
    });
  },

  installUpdate: () => {
    api.updater.install().catch((error) => {
      logger.error('Failed to install update:', error);
    });
  },

  dismissUpdateDialog: () => {
    set({ showUpdateDialog: false });
  },

  dismissUpdateBanner: () => {
    set({ showUpdateBanner: false });
  },
});
