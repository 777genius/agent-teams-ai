/**
 * Update slice - manages OTA auto-update state and actions.
 */

import { api } from '@renderer/api';
import { createLogger } from '@shared/utils/logger';
import { classifyUpdaterFailure } from '@shared/utils/updaterRecovery';
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
  updateOperation: 'check' | 'download' | 'install' | null;
  showUpdateDialog: boolean;
  showUpdateBanner: boolean;
  dismissedUpdateVersion: string | null;

  // Actions
  checkForUpdates: () => void;
  downloadUpdate: () => void;
  installUpdate: () => void;
  retryUpdate: () => void;
  handleUpdaterStatus: (status: UpdaterStatus) => void;
  openUpdateDialog: () => void;
  closeUpdateDialog: () => void;
  dismissUpdateDialog: () => void;
  dismissUpdateBanner: () => void;
}

// =============================================================================
// Slice Creator
// =============================================================================

export const createUpdateSlice: StateCreator<AppState, [], [], UpdateSlice> = (set, get) => {
  let attempt = 0;

  const fail = (error: unknown, operation: number): void => {
    if (operation !== attempt) return;
    get().handleUpdaterStatus({
      type: 'error',
      error: error instanceof Error ? error.message : String(error),
    });
  };

  return {
    // Initial state
    updateStatus: 'idle',
    availableVersion: null,
    releaseNotes: null,
    downloadProgress: 0,
    updateError: null,
    updateOperation: null,
    showUpdateDialog: false,
    showUpdateBanner: false,
    dismissedUpdateVersion: localStorage.getItem(DISMISSED_VERSION_KEY),

    checkForUpdates: () => {
      const current = get().updateStatus;
      if (current === 'downloading' || current === 'downloaded') return;
      const operation = ++attempt;
      set({ updateStatus: 'checking', updateError: null, updateOperation: 'check' });
      void api.updater.check().catch((error: unknown) => {
        logger.error('Failed to check for updates:', error);
        fail(error, operation);
      });
    },

    downloadUpdate: () => {
      const current = get();
      if (!current.availableVersion || current.updateStatus !== 'available') return;
      const operation = ++attempt;
      set({
        updateStatus: 'downloading',
        updateOperation: 'download',
        updateError: null,
        showUpdateDialog: false,
        showUpdateBanner: true,
        downloadProgress: 0,
      });
      void api.updater.download().catch((error: unknown) => {
        logger.error('Failed to download update:', error);
        fail(error, operation);
      });
    },

    installUpdate: () => {
      const current = get();
      if (
        current.updateStatus !== 'downloaded' ||
        current.updateError ||
        current.updateOperation === 'install'
      )
        return;
      const operation = ++attempt;
      set({ updateOperation: 'install', updateError: null });
      void api.updater.install().catch((error: unknown) => {
        logger.error('Failed to install update:', error);
        fail(error, operation);
      });
    },

    retryUpdate: () => {
      const current = get();
      if (
        current.updateStatus !== 'error' ||
        !current.updateError ||
        classifyUpdaterFailure(current.updateError) !== 'network'
      )
        return;
      if (current.availableVersion && current.updateOperation === 'download') {
        set({ updateStatus: 'available' });
        get().downloadUpdate();
      } else {
        get().checkForUpdates();
      }
    },

    handleUpdaterStatus: (status) => {
      switch (status.type) {
        case 'checking': {
          const current = get().updateStatus;
          if (current !== 'downloaded' && current !== 'downloading' && current !== 'error') {
            set({ updateStatus: 'checking', updateError: null, updateOperation: 'check' });
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

          // A periodic check confirms availability, not recovery from a failed install.
          if (current.updateStatus === 'error') {
            set({
              availableVersion: nextVersion,
              releaseNotes: status.releaseNotes ?? current.releaseNotes,
            });
            break;
          }
          attempt++;
          const isSameKnownVersion = current.availableVersion === nextVersion;
          set({
            updateStatus: 'available',
            availableVersion: nextVersion,
            releaseNotes: status.releaseNotes ?? null,
            updateError: null,
            updateOperation: null,
            showUpdateDialog: nextVersion !== current.dismissedUpdateVersion,
            showUpdateBanner: isSameKnownVersion ? current.showUpdateBanner : true,
          });
          break;
        }
        case 'not-available': {
          const current = get();
          if (current.updateStatus === 'downloading' || current.updateStatus === 'downloaded')
            break;
          // An unrelated periodic result must not hide a recovery dialog.
          if (current.updateStatus === 'error') break;
          attempt++;
          if (current.availableVersion) {
            set({ updateStatus: 'available', updateError: null, updateOperation: null });
          } else {
            set({
              updateStatus: 'not-available',
              availableVersion: null,
              releaseNotes: null,
              updateError: null,
              updateOperation: null,
              showUpdateDialog: false,
              showUpdateBanner: false,
            });
          }
          break;
        }
        case 'downloading':
          set({
            updateStatus: 'downloading',
            updateOperation: 'download',
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
          attempt++;
          set({
            updateStatus: 'downloaded',
            updateOperation: null,
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
          set({
            updateStatus: 'error',
            updateError: status.error || 'Unknown error',
            downloadProgress: 0,
            showUpdateDialog: true,
            showUpdateBanner: true,
          });
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
  };
};
