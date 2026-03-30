/**
 * UpdaterService - Wraps electron-updater's autoUpdater for OTA updates.
 *
 * Forwards update lifecycle events to the renderer via IPC.
 * Auto-download is disabled so users must confirm before downloading.
 *
 * Before notifying the renderer about a new version, verifies that the
 * platform-specific installer asset actually exists in the GitHub release.
 * This prevents showing "update available" while CI is still uploading
 * artifacts for the current platform.
 */

import { safeSendToRenderer } from '@main/utils/safeWebContentsSend';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import { isVersionOlder, normalizeVersion } from '@shared/utils/version';
import electronUpdater from 'electron-updater';

const { autoUpdater } = electronUpdater;

import { app, net } from 'electron';

import type { UpdaterStatus } from '@shared/types';
import type { BrowserWindow } from 'electron';

const logger = createLogger('UpdaterService');

const REPO_OWNER = '777genius';
const REPO_NAME = 'claude_agent_teams_ui';

/**
 * Build the expected download URL for the platform-specific installer asset.
 * Returns null if the current platform is unrecognized.
 */
function getExpectedAssetUrl(version: string): string | null {
  const base = `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download/v${version}`;

  switch (process.platform) {
    case 'darwin':
      return process.arch === 'arm64'
        ? `${base}/Claude.Agent.Teams.UI-${version}-arm64.dmg`
        : `${base}/Claude.Agent.Teams.UI-${version}.dmg`;
    case 'win32':
      return `${base}/Claude.Agent.Teams.UI.Setup.${version}.exe`;
    case 'linux':
      return `${base}/Claude.Agent.Teams.UI-${version}.AppImage`;
    default:
      return null;
  }
}

/**
 * Check if a remote URL exists using a HEAD request.
 * Follows redirects (GitHub releases use 302 → S3).
 */
async function assetExists(url: string): Promise<boolean> {
  try {
    const response = await net.fetch(url, { method: 'HEAD' });
    return response.ok;
  } catch {
    return false;
  }
}

export class UpdaterService {
  private mainWindow: BrowserWindow | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private downloadedVersion: string | null = null;

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
    if (!this.downloadedVersion || !this.isNewerThanCurrent(this.downloadedVersion)) {
      logger.warn(
        `Refusing to install non-newer update. current=${app.getVersion()} downloaded=${this.downloadedVersion ?? 'unknown'}`
      );
      this.sendStatus({
        type: 'error',
        error: 'Refused to install a non-newer app version.',
      });
      return;
    }

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
    safeSendToRenderer(this.mainWindow, 'updater:status', status);
  }

  private isNewerThanCurrent(candidateVersion: string): boolean {
    return isVersionOlder(normalizeVersion(app.getVersion()), normalizeVersion(candidateVersion));
  }

  /**
   * Verify that the platform-specific asset exists before notifying the renderer.
   * If CI hasn't finished uploading the artifact for this OS yet, suppress the
   * notification — the next periodic check will retry.
   */
  private async verifyAndNotify(info: {
    version: string;
    releaseNotes?: string | unknown;
  }): Promise<void> {
    if (!this.isNewerThanCurrent(info.version)) {
      logger.warn(
        `Suppressing non-newer update notification. current=${app.getVersion()} candidate=${info.version}`
      );
      return;
    }

    const url = getExpectedAssetUrl(info.version);
    if (url) {
      const exists = await assetExists(url);
      if (!exists) {
        logger.warn(
          `Asset not yet available for ${process.platform}/${process.arch}, suppressing update notification (${url})`
        );
        return;
      }
    }

    this.sendStatus({
      type: 'available',
      version: info.version,
      releaseNotes: typeof info.releaseNotes === 'string' ? info.releaseNotes : undefined,
    });
  }

  private bindEvents(): void {
    autoUpdater.on('checking-for-update', () => {
      logger.info('Checking for update...');
      this.sendStatus({ type: 'checking' });
    });

    autoUpdater.on('update-available', (info) => {
      logger.info('Update available:', info.version);
      void this.verifyAndNotify(info);
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
      if (!this.isNewerThanCurrent(info.version)) {
        logger.warn(
          `Ignoring downloaded non-newer update. current=${app.getVersion()} downloaded=${info.version}`
        );
        return;
      }

      this.downloadedVersion = info.version;
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
