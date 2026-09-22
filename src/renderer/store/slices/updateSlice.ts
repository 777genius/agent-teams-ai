/**
 * Update slice - manages OTA auto-update state and actions.
 */

import { api } from '@renderer/api';
import { createLogger } from '@shared/utils/logger';
import { isVersionOlder, normalizeVersion } from '@shared/utils/version';

import type { AppState } from '../types';
import type { UpdaterStatus } from '@shared/types';
import type { StateCreator } from 'zustand';

const logger = createLogger('Store:update');

const DISMISSED_VERSION_KEY = 'update:dismissed-version';
const CURRENT_APP_VERSION =
  typeof __APP_VERSION__ === 'string' ? normalizeVersion(__APP_VERSION__) : '0.0.0';

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
  handleUpdaterStatus: (status: UpdaterStatus) => void;
  openUpdateDialog: () => void;
  closeUpdateDialog: () => void;
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
    set((state) =>
      state.updateStatus === 'available' ||
      state.updateStatus === 'downloading' ||
      state.updateStatus === 'downloaded'
        ? { updateError: null }
        : { updateStatus: 'checking', updateError: null }
    );
    api.updater.check().catch((error) => {
      logger.error('Failed to check for updates:', error);
      const updateError = error instanceof Error ? error.message : 'Check failed';
      set((state) =>
        state.updateStatus === 'available' || state.updateStatus === 'downloaded'
          ? { updateError }
          : { updateStatus: 'error', updateError }
      );
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

  handleUpdaterStatus: (status) => {
    switch (status.type) {
      case 'checking': {
        const current = get().updateStatus;
        if (current !== 'available' && current !== 'downloaded' && current !== 'downloading') {
          set({ updateStatus: 'checking', updateError: null });
        }
        break;
      }
      case 'available': {
        const current = get();
        if (current.updateStatus === 'downloading' || current.updateStatus === 'downloaded') {
          break;
        }

        const nextVersion = status.version ? normalizeVersion(status.version) : null;
        if (!nextVersion || !isVersionOlder(CURRENT_APP_VERSION, nextVersion)) {
          break;
        }

        const isSameKnownVersion =
          current.updateStatus === 'available' && current.availableVersion === nextVersion;
        set({
          updateStatus: 'available',
          availableVersion: nextVersion,
          releaseNotes: status.releaseNotes ?? null,
          updateError: null,
          showUpdateDialog: nextVersion !== current.dismissedUpdateVersion,
          showUpdateBanner: isSameKnownVersion ? current.showUpdateBanner : true,
        });
        break;
      }
      case 'not-available': {
        const current = get().updateStatus;
        if (current !== 'available' && current !== 'downloading' && current !== 'downloaded') {
          set({
            updateStatus: 'not-available',
            availableVersion: null,
            releaseNotes: null,
            updateError: null,
            showUpdateDialog: false,
            showUpdateBanner: false,
          });
        }
        break;
      }
      case 'downloading':
        set({
          updateStatus: 'downloading',
          downloadProgress: status.progress?.percent ?? 0,
          updateError: null,
          showUpdateBanner: true,
        });
        break;
      case 'downloaded': {
        if (
          status.version &&
          !isVersionOlder(CURRENT_APP_VERSION, normalizeVersion(status.version))
        ) {
          break;
        }
        set({
          updateStatus: 'downloaded',
          downloadProgress: 100,
          updateError: null,
          showUpdateBanner: true,
          availableVersion: status.version
            ? normalizeVersion(status.version)
            : get().availableVersion,
        });
        break;
      }
      case 'error': {
        const current = get().updateStatus;
        const updateError = status.error ?? 'Unknown error';
        if (current === 'available' || current === 'downloaded') {
          set({ updateError });
          break;
        }
        set({ updateStatus: 'error', updateError });
        break;
      }
    }
  },

  openUpdateDialog: () => {
    set({ showUpdateDialog: true });
  },

  closeUpdateDialog: () => {
    set({ showUpdateDialog: false });
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
