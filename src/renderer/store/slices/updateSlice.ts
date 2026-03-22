/**
 * Update slice - manages OTA auto-update state and actions.
 */

import { api } from '@renderer/api';
import { createLogger } from '@shared/utils/logger';

import type { AppState } from '../types';
import type { StateCreator } from 'zustand';

const logger = createLogger('Store:update');

const DISMISSED_VERSION_KEY = 'update:dismissed-version';

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
  dismissedUpdateVersion: string | null;

  // Actions
  checkForUpdates: () => void;
  downloadUpdate: () => void;
  installUpdate: () => void;
  openUpdateDialog: () => void;
  dismissUpdateDialog: () => void;
  dismissUpdateBanner: () => void;
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createUpdateSlice: StateCreator<AppState, [], [], UpdateSlice> = (set, get) => ({
  // Initial state
  updateStatus: 'idle',
  availableVersion: null,
  releaseNotes: null,
  downloadProgress: 0,
  updateError: null,
  showUpdateDialog: false,
  showUpdateBanner: false,
  dismissedUpdateVersion: localStorage.getItem(DISMISSED_VERSION_KEY),

  checkForUpdates: () => {
    set({ updateStatus: 'checking', updateError: null });
    api.updater.check().catch((error) => {
      logger.error('Failed to check for updates:', error);
      set({
        updateStatus: 'error',
        updateError: error instanceof Error ? error.message : 'Check failed',
      });
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

  openUpdateDialog: () => {
    set({ showUpdateDialog: true });
  },

  dismissUpdateDialog: () => {
    const version = get().availableVersion;
    if (version) {
      localStorage.setItem(DISMISSED_VERSION_KEY, version);
      set({ showUpdateDialog: false, dismissedUpdateVersion: version });
    } else {
      set({ showUpdateDialog: false });
    }
  },

  dismissUpdateBanner: () => {
    set({ showUpdateBanner: false });
  },
});
