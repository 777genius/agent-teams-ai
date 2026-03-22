/**
 * UpdaterService - Wraps electron-updater's autoUpdater for OTA updates.
 *
 * Forwards update lifecycle events to the renderer via IPC.
 * Auto-download is disabled so users must confirm before downloading.
 */

import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

import type { UpdaterStatus } from '@shared/types';
import type { BrowserWindow } from 'electron';

const logger = createLogger('UpdaterService');

export class UpdaterService {
  private mainWindow: BrowserWindow | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;

  constructor() {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;

    this.bindEvents();
  }

  /**
   * Set the main window reference for sending status events.
   */
  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  /**
   * Check for available updates.
   */
  async checkForUpdates(): Promise<void> {
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      logger.error('Check for updates failed:', getErrorMessage(error));
      this.sendStatus({ type: 'error', error: getErrorMessage(error) });
    }
  }

  /**
   * Download the available update.
   */
  async downloadUpdate(): Promise<void> {
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      logger.error('Download update failed:', getErrorMessage(error));
      this.sendStatus({ type: 'error', error: getErrorMessage(error) });
    }
  }

  /**
   * Quit the app and install the downloaded update.
   * On Windows (NSIS): isSilent=true runs the installer with /S (no wizard);
   * isForceRunAfter=true launches the app after install. Other platforms ignore these.
   */
  quitAndInstall(): void {
    autoUpdater.quitAndInstall(true, true);
  }

  /**
   * Start periodic update checks at the given interval (default: 1 hour).
   * Uses unref() so the timer does not prevent process exit.
   */
  startPeriodicCheck(intervalMs: number = 3_600_000): void {
    this.stopPeriodicCheck();
    this.periodicTimer = setInterval(() => void this.checkForUpdates(), intervalMs);
    this.periodicTimer.unref();
    logger.info(`Periodic update check started (interval: ${Math.round(intervalMs / 60_000)}min)`);
  }

  /**
   * Stop periodic update checks.
   */
  stopPeriodicCheck(): void {
    if (this.periodicTimer !== null) {
      clearInterval(this.periodicTimer);
      this.periodicTimer = null;
    }
  }

  private sendStatus(status: UpdaterStatus): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send('updater:status', status);
    }
  }

  private bindEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      logger.info('Checking for update...');
      this.sendStatus({ type: 'checking' });
    });

    autoUpdater.on('update-available', (info) => {
      logger.info('Update available:', info.version);
      this.sendStatus({
        type: 'available',
        version: info.version,
        releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
      });
    });

    autoUpdater.on('update-not-available', () => {
      logger.info('No update available');
      this.sendStatus({ type: 'not-available' });
    });

    autoUpdater.on('download-progress', (progress) => {
      this.sendStatus({
        type: 'downloading',
        progress: {
          percent: progress.percent,
          transferred: progress.transferred,
          total: progress.total,
        },
      });
    });

    autoUpdater.on('update-downloaded', (info) => {
      logger.info('Update downloaded:', info.version);
      this.sendStatus({
        type: 'downloaded',
        version: info.version,
      });
    });

    autoUpdater.on('error', (error) => {
      logger.error('Updater error:', getErrorMessage(error));
      this.sendStatus({
        type: 'error',
        error: getErrorMessage(error),
      });
    });
  }
}
