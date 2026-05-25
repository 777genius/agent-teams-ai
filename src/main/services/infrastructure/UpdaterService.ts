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
import {
  formatUpdaterReleaseNotes,
  getUpdaterReleaseNoteForVersion,
} from '@shared/utils/releaseNotes';
import { isVersionOlder, normalizeVersion } from '@shared/utils/version';
import { app, net } from 'electron';
import electronUpdater from 'electron-updater';

import {
  getExpectedReleaseAssetUrls,
  getLatestMacMetadataUrls,
  getReleaseApiUrls,
  isLatestMacMetadataCompatible,
  shouldSkipReleaseForUpdater,
} from './updaterReleaseMetadata';

import type { GithubReleaseMetadata } from './updaterReleaseMetadata';
import type { UpdaterStatus } from '@shared/types';
import type { BrowserWindow } from 'electron';

const logger = createLogger('UpdaterService');
const { autoUpdater } = electronUpdater;

function shouldSkipDevUpdateCheck(): boolean {
  return (
    !app.isPackaged &&
    (autoUpdater as { forceDevUpdateConfig?: boolean }).forceDevUpdateConfig !== true
  );
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

async function assetExistsInAnyRepo(urls: readonly string[]): Promise<boolean> {
  for (const url of urls) {
    if (await assetExists(url)) {
      return true;
    }
  }
  return false;
}

async function fetchText(url: string): Promise<string | null> {
  try {
    const response = await net.fetch(url, { method: 'GET' });
    if (!response.ok) {
      return null;
    }
    return await response.text();
  } catch {
    return null;
  }
}

async function fetchJson<T>(url: string): Promise<T | null> {
  try {
    const response = await net.fetch(url, {
      method: 'GET',
      headers: { Accept: 'application/vnd.github+json' },
    });
    if (!response.ok) {
      return null;
    }
    return (await response.json()) as T;
  } catch {
    return null;
  }
}

export class UpdaterService {
  private mainWindow: BrowserWindow | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private downloadedVersion: string | null = null;
  private beforeQuitAndInstall: (() => Promise<void>) | null = null;

  constructor() {
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.fullChangelog = true;

    this.bindEvents();
  }

  /**
   * Set the main window reference for sending status events.
   */
  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  setBeforeQuitAndInstall(handler: (() => Promise<void>) | null): void {
    this.beforeQuitAndInstall = handler;
  }

  /**
   * Check for available updates.
   */
  async checkForUpdates(): Promise<void> {
    if (shouldSkipDevUpdateCheck()) {
      return;
    }

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
  async quitAndInstall(): Promise<void> {
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

    await this.beforeQuitAndInstall?.();
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

  private async hasCompatibleMacFeed(version: string): Promise<boolean> {
    if (process.platform !== 'darwin') {
      return true;
    }
    if (process.arch !== 'arm64' && process.arch !== 'x64') {
      return false;
    }

    const metadataUrls = getLatestMacMetadataUrls(version);
    for (const metadataUrl of metadataUrls) {
      const metadataText = await fetchText(metadataUrl);
      if (metadataText && isLatestMacMetadataCompatible(metadataText, version, process.arch)) {
        return true;
      }
    }

    logger.warn(`latest-mac.yml is not compatible or available for ${version}`);
    return false;
  }

  private async isSkippedRelease(version: string): Promise<boolean> {
    const metadataUrls = getReleaseApiUrls(version);
    for (const metadataUrl of metadataUrls) {
      const release = await fetchJson<GithubReleaseMetadata>(metadataUrl);
      if (!release) {
        continue;
      }
      return shouldSkipReleaseForUpdater(release);
    }

    logger.warn(`GitHub release metadata is not available for ${version}, allowing updater check`);
    return false;
  }

  /**
   * Verify that the platform-specific asset exists before notifying the renderer.
   * If CI hasn't finished uploading the artifact for this OS yet, suppress the
   * notification — the next periodic check will retry.
   */
  private async verifyAndNotify(info: {
    version: string;
    releaseName?: unknown;
    releaseNotes?: unknown;
  }): Promise<void> {
    if (!this.isNewerThanCurrent(info.version)) {
      logger.warn(
        `Suppressing non-newer update notification. current=${app.getVersion()} candidate=${info.version}`
      );
      return;
    }

    const latestReleaseNote = getUpdaterReleaseNoteForVersion(info.releaseNotes, info.version);
    const releaseNotes = formatUpdaterReleaseNotes(info.releaseNotes);

    if (
      shouldSkipReleaseForUpdater({
        tag_name: `v${info.version}`,
        name: typeof info.releaseName === 'string' ? info.releaseName : undefined,
        body: latestReleaseNote,
      })
    ) {
      logger.warn(`Suppressing updater notification for locally marked release ${info.version}`);
      return;
    }

    if (await this.isSkippedRelease(info.version)) {
      logger.warn(`Suppressing updater notification for skipped release ${info.version}`);
      return;
    }

    const urls = getExpectedReleaseAssetUrls(info.version, process.platform, process.arch);
    if (urls.length > 0) {
      const exists = await assetExistsInAnyRepo(urls);
      if (!exists) {
        logger.warn(
          `Asset not yet available for ${process.platform}/${process.arch}, suppressing update notification`
        );
        return;
      }
    }

    if (!(await this.hasCompatibleMacFeed(info.version))) {
      logger.warn(
        `latest-mac.yml does not match ${process.platform}/${process.arch}, suppressing update notification`
      );
      return;
    }

    this.sendStatus({
      type: 'available',
      version: info.version,
      releaseNotes,
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
