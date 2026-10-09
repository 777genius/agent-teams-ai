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
import { classifyUpdaterFailure } from '@shared/utils/updaterRecovery';
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

interface UpdaterOperationContext {
  operation: NonNullable<UpdaterStatus['operation']>;
  reportedError: string | null;
}

export class UpdaterService {
  private mainWindow: BrowserWindow | null = null;
  private periodicTimer: ReturnType<typeof setInterval> | null = null;
  private downloadedVersion: string | null = null;
  private activeOperation: UpdaterOperationContext | null = null;
  private lastOperation: UpdaterOperationContext | null = null;
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
    if (shouldSkipDevUpdateCheck() || this.activeOperation) {
      return;
    }

    const context = this.beginOperation('check');
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      logger.error('Check for updates failed:', getErrorMessage(error));
      this.reportError(error, context);
    } finally {
      this.finishOperation(context);
    }
  }

  /**
   * Download the available update.
   */
  async downloadUpdate(): Promise<void> {
    const context = this.beginOperation('download');
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      logger.error('Download update failed:', getErrorMessage(error));
      this.reportError(error, context);
    } finally {
      this.finishOperation(context);
    }
  }

  /**
   * Quit the app and install the downloaded update.
   * On Windows (NSIS): isSilent=true runs the installer with /S (no wizard);
   * isForceRunAfter=true launches the app after install. Other platforms ignore these.
   */
  async quitAndInstall(): Promise<void> {
    const context = this.beginOperation('install');
    if (!this.downloadedVersion || !this.isNewerThanCurrent(this.downloadedVersion)) {
      logger.warn(
        `Refusing to install non-newer update. current=${app.getVersion()} downloaded=${this.downloadedVersion ?? 'unknown'}`
      );
      this.reportError(new Error('Refused to install a non-newer app version.'), context);
      this.finishOperation(context);
      return;
    }

    try {
      await this.beforeQuitAndInstall?.();
      // Installation can report a native error after this void call returns.
      autoUpdater.quitAndInstall(true, true);
    } catch (error) {
      logger.error('Install update failed:', getErrorMessage(error));
      this.reportError(error, context);
      this.finishOperation(context);
    }
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

  private beginOperation(operation: UpdaterOperationContext['operation']): UpdaterOperationContext {
    const context = { operation, reportedError: null };
    this.activeOperation = context;
    this.lastOperation = context;
    return context;
  }

  private finishOperation(context: UpdaterOperationContext): void {
    if (this.activeOperation === context) this.activeOperation = null;
  }

  private reportError(error: unknown, context: UpdaterOperationContext): void {
    const message = getErrorMessage(error);
    if (context.reportedError === message) return;
    context.reportedError = message;
    if (context.operation !== 'check' || classifyUpdaterFailure(message) === 'signature') {
      this.downloadedVersion = null;
    }
    this.sendStatus({ type: 'error', operation: context.operation, error: message });
    if (context.operation === 'install') this.finishOperation(context);
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

  private async fetchReleaseMetadata(version: string): Promise<GithubReleaseMetadata | null> {
    const metadataUrls = getReleaseApiUrls(version);
    for (const metadataUrl of metadataUrls) {
      const release = await fetchJson<GithubReleaseMetadata>(metadataUrl);
      if (
        !release ||
        typeof release.tag_name !== 'string' ||
        release.tag_name.replace(/^v/i, '') !== version.replace(/^v/i, '')
      ) {
        continue;
      }
      return release;
    }

    logger.warn(`GitHub release metadata is not available for ${version}, allowing updater check`);
    return null;
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

    const release = await this.fetchReleaseMetadata(info.version);
    if (release && shouldSkipReleaseForUpdater(release)) {
      logger.warn(`Suppressing updater notification for skipped release ${info.version}`);
      return;
    }

    // GitHub's Atom feed can omit the candidate when tooling tags occupy its
    // latest entries. Reuse exact-tag metadata from the skip check, preserving
    // the complete changelog when the candidate already has displayable notes.
    const providedNotes = formatUpdaterReleaseNotes(info.releaseNotes);
    const releaseNotes = formatUpdaterReleaseNotes(latestReleaseNote)?.trim()
      ? providedNotes
      : (formatUpdaterReleaseNotes(release?.body) ?? providedNotes);

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
      this.sendStatus({ type: 'checking', operation: 'check' });
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
      const context = this.activeOperation ??
        this.lastOperation ?? { operation: 'check', reportedError: null };
      this.reportError(error, context);
    });
  }
}
