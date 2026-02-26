/**
 * CliInstallerService — detects, downloads, verifies, and installs Claude Code CLI.
 *
 * Architecture mirrors UpdaterService: instance with setMainWindow(), progress events
 * via webContents.send(). Downloads the native binary from GCS, verifies SHA256,
 * then delegates `claude install` for shell integration (symlink, PATH setup).
 *
 * Edge cases handled:
 * - HTTP redirects (GCS 302) — manual redirect following
 * - Missing Content-Length — indeterminate progress
 * - tmpfile cleanup on failure/abort (finally block)
 * - SHA256 mismatch — clear error, file deleted
 * - spawn timeouts (10s for --version, 120s for install)
 * - manifest.json / latest response validation
 * - Concurrent install mutex
 * - `latest` version string trimming / 'v' prefix stripping
 * - Human-readable error messages per phase
 */

import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { createWriteStream, existsSync, promises as fsp } from 'fs';
import http from 'http';
import https from 'https';
import { tmpdir } from 'os';
import { join } from 'path';
import { promisify } from 'util';

import { ClaudeBinaryResolver } from '../team/ClaudeBinaryResolver';

import type { CliInstallationStatus, CliInstallerProgress, CliPlatform } from '@shared/types';
import type { BrowserWindow } from 'electron';
import type { IncomingMessage } from 'http';

const logger = createLogger('CliInstallerService');

// Note: execFile (not exec) is used intentionally — no shell injection risk.
// Arguments are passed as arrays, never interpolated into shell strings.
const execFileAsync = promisify(execFile);

// =============================================================================
// Constants
// =============================================================================

const GCS_BASE =
  'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases';

const CLI_INSTALLER_PROGRESS_CHANNEL = 'cliInstaller:progress';

/** Timeout for `claude --version` (ms) */
const VERSION_TIMEOUT_MS = 10_000;

/** Timeout for `claude install` (ms) — can take a while on slow disks */
const INSTALL_TIMEOUT_MS = 120_000;

/** Max redirects to follow when fetching from GCS */
const MAX_REDIRECTS = 5;

// =============================================================================
// Helpers
// =============================================================================

/**
 * Follow redirects manually for https.get (Node https does NOT auto-follow).
 */
function httpsGetFollowRedirects(
  url: string,
  redirectsLeft = MAX_REDIRECTS
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'http:' ? http : https;

    transport
      .get(url, (res) => {
        const status = res.statusCode ?? 0;

        if (status >= 300 && status < 400 && res.headers.location) {
          if (redirectsLeft <= 0) {
            res.destroy();
            reject(new Error('Too many redirects'));
            return;
          }
          const redirectUrl = new URL(res.headers.location, url).toString();
          res.destroy();
          httpsGetFollowRedirects(redirectUrl, redirectsLeft - 1).then(resolve, reject);
          return;
        }

        if (status !== 200) {
          res.destroy();
          reject(new Error(`HTTP ${status} fetching ${url}`));
          return;
        }

        resolve(res);
      })
      .on('error', reject);
  });
}

/**
 * Fetch text content from a URL with redirect support.
 */
async function fetchText(url: string): Promise<string> {
  const res = await httpsGetFollowRedirects(url);
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    res.on('data', (chunk: Buffer) => chunks.push(chunk));
    res.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    res.on('error', reject);
  });
}

/**
 * Fetch JSON from a URL with redirect support and basic validation.
 */
async function fetchJson<T>(url: string): Promise<T> {
  const text = await fetchText(url);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Invalid JSON response from ${url}`);
  }
}

/**
 * Extract semver from a version string like "2.1.34 (Claude Code)" or "v2.1.34".
 * Returns just the "X.Y.Z" portion, or the trimmed string if no match.
 */
export function normalizeVersion(raw: string): string {
  const match = /\d{1,10}\.\d{1,10}\.\d{1,10}/.exec(raw);
  return match ? match[0] : raw.trim();
}

/**
 * Compare two semver strings numerically.
 * Returns true if `installed` is strictly older than `latest`.
 * Handles "2.10.0" > "2.9.0" correctly (numeric, not lexicographic).
 */
export function isVersionOlder(installed: string, latest: string): boolean {
  const iParts = installed.split('.').map(Number);
  const lParts = latest.split('.').map(Number);

  for (let i = 0; i < Math.max(iParts.length, lParts.length); i++) {
    const a = iParts[i] ?? 0;
    const b = lParts[i] ?? 0;
    if (a < b) return true;
    if (a > b) return false;
  }
  return false;
}

// =============================================================================
// Manifest types (internal)
// =============================================================================

interface GcsPlatformEntry {
  binary?: string;
  checksum?: string;
  size?: number;
}

interface GcsManifest {
  version?: string;
  platforms?: Record<string, GcsPlatformEntry>;
}

// =============================================================================
// Service
// =============================================================================

export class CliInstallerService {
  private mainWindow: BrowserWindow | null = null;
  private installing = false;

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  // ---------------------------------------------------------------------------
  // Public: getStatus
  // ---------------------------------------------------------------------------

  async getStatus(): Promise<CliInstallationStatus> {
    const result: CliInstallationStatus = {
      installed: false,
      installedVersion: null,
      binaryPath: null,
      latestVersion: null,
      updateAvailable: false,
    };

    const binaryPath = await ClaudeBinaryResolver.resolve();
    if (binaryPath) {
      result.installed = true;
      result.binaryPath = binaryPath;

      try {
        const { stdout } = await execFileAsync(binaryPath, ['--version'], {
          timeout: VERSION_TIMEOUT_MS,
        });
        result.installedVersion = normalizeVersion(stdout);
        logger.info(
          `Installed CLI version: "${stdout.trim()}" → normalized: "${result.installedVersion}"`
        );
      } catch (err) {
        logger.warn('Failed to get CLI version:', getErrorMessage(err));
      }
    }

    try {
      const latestRaw = await fetchText(`${GCS_BASE}/latest`);
      result.latestVersion = normalizeVersion(latestRaw);
      logger.info(
        `Latest CLI version: "${latestRaw.trim()}" → normalized: "${result.latestVersion}"`
      );

      if (result.installedVersion && result.latestVersion) {
        result.updateAvailable = isVersionOlder(result.installedVersion, result.latestVersion);
        logger.info(
          `Update available: ${result.updateAvailable} (${result.installedVersion} → ${result.latestVersion})`
        );
      }
    } catch (err) {
      logger.warn('Failed to fetch latest CLI version:', getErrorMessage(err));
    }

    return result;
  }

  // ---------------------------------------------------------------------------
  // Public: install
  // ---------------------------------------------------------------------------

  async install(): Promise<void> {
    if (this.installing) {
      this.sendProgress({ type: 'error', error: 'Installation already in progress' });
      return;
    }

    this.installing = true;
    let tmpFilePath: string | null = null;

    try {
      // --- Phase 1: Check ---
      this.sendProgress({ type: 'checking', detail: 'Detecting platform...' });
      const platform = this.detectPlatform();
      logger.info(`Detected platform: ${platform}`);

      this.sendProgress({ type: 'checking', detail: 'Fetching latest version...' });
      let version: string;
      try {
        const latestRaw = await fetchText(`${GCS_BASE}/latest`);
        version = normalizeVersion(latestRaw);
        if (!version) throw new Error('Server returned empty version');
      } catch (err) {
        throw new Error(`Failed to check latest version: ${getErrorMessage(err)}`);
      }
      logger.info(`Latest CLI version: ${version}`);

      this.sendProgress({ type: 'checking', detail: `Fetching manifest for v${version}...` });
      let manifest: GcsManifest;
      try {
        manifest = await fetchJson<GcsManifest>(`${GCS_BASE}/${version}/manifest.json`);
      } catch (err) {
        throw new Error(`Failed to fetch release manifest: ${getErrorMessage(err)}`);
      }

      const platformEntry = manifest.platforms?.[platform];
      if (!platformEntry?.checksum) {
        const available = Object.keys(manifest.platforms ?? {}).join(', ');
        throw new Error(
          `Platform "${platform}" not found in release manifest.\nAvailable: ${available || 'none'}`
        );
      }

      const expectedSha256 = platformEntry.checksum;
      const expectedSize = platformEntry.size;
      const binaryName = platformEntry.binary ?? 'claude';

      // --- Phase 2: Download ---
      const downloadUrl = `${GCS_BASE}/${version}/${platform}/${binaryName}`;
      tmpFilePath = join(tmpdir(), `claude-cli-${version}-${Date.now()}`);
      logger.info(`Downloading ${downloadUrl} → ${tmpFilePath}`);
      this.sendProgress({ type: 'downloading', percent: 0, transferred: 0, total: expectedSize });

      let actualSha256: string;
      try {
        actualSha256 = await this.downloadWithProgress(downloadUrl, tmpFilePath, expectedSize);
      } catch (err) {
        throw new Error(`Download failed: ${getErrorMessage(err)}`);
      }

      // --- Phase 3: Verify ---
      this.sendProgress({ type: 'verifying', detail: 'Comparing SHA256 checksums...' });
      logger.info(`Expected SHA256: ${expectedSha256}`);
      logger.info(`Actual SHA256:   ${actualSha256}`);

      if (actualSha256 !== expectedSha256) {
        throw new Error(
          `Checksum verification failed — the downloaded file is corrupted.\n` +
            `Expected: ${expectedSha256}\n` +
            `Got: ${actualSha256}`
        );
      }

      // --- Phase 4: Make executable + install ---
      if (process.platform !== 'win32') {
        // eslint-disable-next-line sonarjs/file-permissions -- 0o755 is standard for executables (rwxr-xr-x)
        await fsp.chmod(tmpFilePath, 0o755);
      }

      this.sendProgress({ type: 'installing', detail: 'Starting shell integration...' });
      logger.info('Running claude install...');

      try {
        await this.runInstallWithStreaming(tmpFilePath);
      } catch (err) {
        throw new Error(`Shell integration failed: ${getErrorMessage(err)}`);
      }

      // --- Phase 5: Done ---
      ClaudeBinaryResolver.clearCache();
      logger.info(`CLI v${version} installed successfully`);
      this.sendProgress({ type: 'completed', version });

      await this.removeTmpFile(tmpFilePath);
      tmpFilePath = null;
    } catch (err) {
      const error = getErrorMessage(err);
      logger.error('CLI install failed:', error);
      this.sendProgress({ type: 'error', error });
    } finally {
      this.installing = false;
      if (tmpFilePath) {
        await this.removeTmpFile(tmpFilePath);
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  private sendProgress(progress: CliInstallerProgress): void {
    if (this.mainWindow && !this.mainWindow.isDestroyed()) {
      this.mainWindow.webContents.send(CLI_INSTALLER_PROGRESS_CHANNEL, progress);
    }
  }

  private detectPlatform(): CliPlatform {
    const arch = process.arch === 'arm64' ? 'arm64' : 'x64';

    if (process.platform === 'darwin') return `darwin-${arch}` as CliPlatform;
    if (process.platform === 'win32') return `win32-${arch}` as CliPlatform;

    const isMusl =
      existsSync('/lib/ld-musl-x86_64.so.1') || existsSync('/lib/ld-musl-aarch64.so.1');

    return (isMusl ? `linux-${arch}-musl` : `linux-${arch}`) as CliPlatform;
  }

  private async downloadWithProgress(
    url: string,
    destPath: string,
    expectedSize?: number
  ): Promise<string> {
    const res = await httpsGetFollowRedirects(url);

    const contentLength = res.headers['content-length']
      ? parseInt(res.headers['content-length'], 10)
      : expectedSize;

    const hash = createHash('sha256');
    const fileStream = createWriteStream(destPath);
    let transferred = 0;

    return new Promise<string>((resolve, reject) => {
      res.on('data', (chunk: Buffer) => {
        transferred += chunk.length;
        hash.update(chunk);
        fileStream.write(chunk);

        const percent = contentLength ? Math.round((transferred / contentLength) * 100) : undefined;
        this.sendProgress({ type: 'downloading', percent, transferred, total: contentLength });
      });

      res.on('end', () => {
        fileStream.end(() => resolve(hash.digest('hex')));
      });

      res.on('error', (err) => {
        fileStream.destroy();
        reject(err);
      });

      fileStream.on('error', (err) => {
        res.destroy();
        reject(err);
      });
    });
  }

  /**
   * Run `claude install` via spawn with streaming output.
   * Collects all output for error context. Non-zero exit tolerated if binary resolves.
   */
  private async runInstallWithStreaming(binaryPath: string): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawn(binaryPath, ['install'], {
        env: { ...process.env, CLAUDE_SKIP_ANALYTICS: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timeout = setTimeout(() => {
        child.kill();
        reject(
          new Error(
            `Timed out after ${INSTALL_TIMEOUT_MS / 1000}s. ` +
              `The install process may still be running in the background.`
          )
        );
      }, INSTALL_TIMEOUT_MS);

      const outputLines: string[] = [];

      const handleOutput = (chunk: Buffer): void => {
        const text = chunk.toString('utf-8').trim();
        if (!text) return;
        for (const line of text.split('\n')) {
          const trimmed = line.trim();
          if (trimmed) {
            outputLines.push(trimmed);
            logger.info(`[claude install] ${trimmed}`);
            this.sendProgress({ type: 'installing', detail: trimmed });
          }
        }
      };

      child.stdout?.on('data', handleOutput);
      child.stderr?.on('data', handleOutput);

      child.on('close', (code) => {
        clearTimeout(timeout);
        if (code === 0) {
          resolve();
          return;
        }
        logger.warn(`claude install exited with code ${code ?? 'unknown'}`);
        ClaudeBinaryResolver.clearCache();
        ClaudeBinaryResolver.resolve().then((check) => {
          if (check) {
            resolve();
          } else {
            const context =
              outputLines.length > 0 ? `\n\nOutput:\n${outputLines.slice(-10).join('\n')}` : '';
            reject(new Error(`Exit code ${code ?? 'unknown'}${context}`));
          }
        }, reject);
      });

      child.on('error', (err) => {
        clearTimeout(timeout);
        reject(err);
      });
    });
  }

  private async removeTmpFile(filePath: string): Promise<void> {
    try {
      await fsp.unlink(filePath);
    } catch {
      // Ignore — file may already be cleaned up
    }
  }
}
