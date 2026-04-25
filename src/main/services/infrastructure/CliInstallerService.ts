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

import { execCli, killProcessTree, spawnCli } from '@main/utils/childProcess';
import { appendCliAuthDiag } from '@main/utils/cliAuthDiagLog';
import { buildEnrichedEnv } from '@main/utils/cliEnv';
import { buildMergedCliPath } from '@main/utils/cliPathMerge';
import { getClaudeBasePath, getHomeDir } from '@main/utils/pathDecoder';
import { safeSendToRenderer } from '@main/utils/safeWebContentsSend';
import {
  getCachedShellEnv,
  getShellPreferredHome,
  resolveInteractiveShellEnv,
} from '@main/utils/shellEnv';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';
import { createHash } from 'crypto';
import { createWriteStream, existsSync, promises as fsp } from 'fs';
import http from 'http';
import https from 'https';
import { tmpdir } from 'os';
import { join, posix as pathPosix, win32 as pathWin32 } from 'path';

import { ClaudeMultimodelBridgeService } from '../runtime/ClaudeMultimodelBridgeService';
import {
  CliProviderModelAvailabilityService,
  type ProviderModelAvailabilityContext,
  type ProviderModelAvailabilitySnapshot,
} from '../runtime/CliProviderModelAvailabilityService';
import { ClaudeBinaryResolver } from '../team/ClaudeBinaryResolver';
import { getCliFlavorUiOptions, getConfiguredCliFlavor } from '../team/cliFlavor';

import type {
  CliInstallationStatus,
  CliInstallerProgress,
  CliPlatform,
  CliProviderId,
  CliProviderModelAvailability,
  CliProviderStatus,
} from '@shared/types';
import type { BrowserWindow } from 'electron';
import type { IncomingMessage } from 'http';

const logger = createLogger('CliInstallerService');

// =============================================================================
// Constants
// =============================================================================

const GCS_BASE =
  'https://storage.googleapis.com/claude-code-dist-86c565f3-f756-42ad-8dfa-d59b1c096819/claude-code-releases';

const CLI_INSTALLER_PROGRESS_CHANNEL = 'cliInstaller:progress';

/** Timeout for `claude --version` (ms) */
const VERSION_TIMEOUT_MS = 10_000;
const VERSION_RETRY_ATTEMPTS = 2;
const VERSION_RETRY_DELAY_MS = 350;
const HEALTHY_STATUS_FALLBACK_TTL_MS = 60_000;

/** Timeout for `claude install` (ms) — can take a while on slow disks */
const INSTALL_TIMEOUT_MS = 120_000;

/** Max redirects to follow when fetching from GCS */
const MAX_REDIRECTS = 5;

/** Socket timeout for HTTP requests — covers DNS + TCP + TLS + first byte (ms) */
const HTTP_CONNECT_TIMEOUT_MS = 15_000;

/** Overall timeout for getStatus() to prevent UI hanging indefinitely (ms) */
const GET_STATUS_TIMEOUT_MS = 30_000;

/** Overall timeout for the auth status check (covers both attempts + retry delay) (ms) */
const AUTH_TOTAL_TIMEOUT_MS = 15_000;

/** Max retries for EBUSY (antivirus scanning the new binary) */
const EBUSY_MAX_RETRIES = 3;

/** Delay between EBUSY retries (multiplied by attempt number) */
const EBUSY_RETRY_DELAY_MS = 2000;

/** Max retries for auth status check (covers stale locks after Ctrl+C) */
const AUTH_STATUS_MAX_RETRIES = 2;

/** Delay before retrying auth status check (ms) — gives previous process time to clean up */
const AUTH_STATUS_RETRY_DELAY_MS = 1500;

/** `claude auth status` may prefix stderr noise or warnings; extract the JSON object. */
function parseClaudeAuthStatusStdout(stdout: string): { loggedIn?: boolean; authMethod?: string } {
  const trimmed = stdout.trim();
  const parse = (s: string): { loggedIn?: boolean; authMethod?: string } => {
    const v = JSON.parse(s) as { loggedIn?: boolean; authMethod?: string };
    if (typeof v !== 'object' || v === null) {
      throw new Error('auth status: not an object');
    }
    return v;
  };
  try {
    return parse(trimmed);
  } catch {
    const start = trimmed.lastIndexOf('{');
    const end = trimmed.lastIndexOf('}');
    if (start >= 0 && end > start) {
      return parse(trimmed.slice(start, end + 1));
    }
    throw new Error('auth status: no JSON object in output');
  }
}

/** NDJSON: strip C0 controls (except \\t \\n \\r) so logs stay valid text and tiny. */
function stripControlForDiag(s: string): string {
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '\uFFFD');
}

function clipHeadForDiag(s: string, maxLen: number): string {
  return stripControlForDiag(s).slice(0, maxLen);
}

function clipTailForDiag(s: string, maxLen: number): string {
  return stripControlForDiag(s).slice(-maxLen);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

const DIAG_PATH_HEAD = 400;
const DIAG_HOME_PREVIEW = 120;
const DIAG_AUTH_STDOUT_TAIL = 160;

function cloneCliInstallationStatus(status: CliInstallationStatus): CliInstallationStatus {
  return {
    ...status,
    launchError: status.launchError ?? null,
    providers: status.providers.map((provider) => ({
      ...provider,
      modelVerificationState: provider.modelVerificationState ?? 'idle',
      modelCatalog: provider.modelCatalog ? structuredClone(provider.modelCatalog) : null,
      detailMessage: provider.detailMessage ?? null,
      modelAvailability: provider.modelAvailability?.map((item) => ({ ...item })) ?? [],
      runtimeCapabilities: provider.runtimeCapabilities
        ? structuredClone(provider.runtimeCapabilities)
        : null,
      capabilities: {
        ...provider.capabilities,
        extensions: {
          ...createDefaultCliExtensionCapabilities(),
          ...provider.capabilities.extensions,
        },
      },
      selectedBackendId: provider.selectedBackendId ?? null,
      resolvedBackendId: provider.resolvedBackendId ?? null,
      availableBackends: provider.availableBackends?.map((backend) => ({ ...backend })) ?? [],
      externalRuntimeDiagnostics:
        provider.externalRuntimeDiagnostics?.map((diagnostic) => ({ ...diagnostic })) ?? [],
      backend: provider.backend ? { ...provider.backend } : null,
      models: [...provider.models],
    })),
  };
}

function cloneProviderModelAvailability(
  modelAvailability: CliProviderModelAvailability[] | undefined
): CliProviderModelAvailability[] {
  return modelAvailability?.map((item) => ({ ...item })) ?? [];
}

// =============================================================================
// Helpers
// =============================================================================

/**
 * Follow redirects manually for https.get (Node https does NOT auto-follow).
 * Includes a socket-level timeout covering DNS + TCP connect + TLS + first byte.
 */
function httpsGetFollowRedirects(
  url: string,
  redirectsLeft = MAX_REDIRECTS,
  timeoutMs = HTTP_CONNECT_TIMEOUT_MS
): Promise<IncomingMessage> {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(url);
    const transport = parsedUrl.protocol === 'http:' ? http : https;
    let settled = false;

    const settleResolve = (value: IncomingMessage): void => {
      if (settled) return;
      settled = true;
      resolve(value);
    };

    const settleReject = (err: Error): void => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    const req = transport.get(url, (res) => {
      const status = res.statusCode ?? 0;

      if (status >= 300 && status < 400 && res.headers.location) {
        if (redirectsLeft <= 0) {
          res.destroy();
          settleReject(new Error('Too many redirects'));
          return;
        }
        const redirectUrl = new URL(res.headers.location, url).toString();
        res.destroy();
        httpsGetFollowRedirects(redirectUrl, redirectsLeft - 1, timeoutMs).then(
          settleResolve,
          settleReject
        );
        return;
      }

      if (status !== 200) {
        res.destroy();
        settleReject(new Error(`HTTP ${status} fetching ${url}`));
        return;
      }

      settleResolve(res);
    });

    // Socket-level timeout: fires if the socket is idle for timeoutMs at any point
    // during DNS resolution, TCP connect, TLS handshake, or waiting for response headers.
    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error(`Connection timed out after ${timeoutMs}ms fetching ${url}`));
    });

    req.on('error', (err) => settleReject(err instanceof Error ? err : new Error(String(err))));
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

function isSemverVersion(value: string | null | undefined): value is string {
  return typeof value === 'string' && /^\d{1,10}\.\d{1,10}\.\d{1,10}$/.test(value);
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

/** Per-`getStatus()` snapshot so parallel calls cannot clobber shared instance fields. */
interface CliInstallerStatusRunDiag {
  versionError: string | null;
  authAttempts: number;
  authLastError: string | null;
  authStdoutLen: number;
  authStdoutTail: string;
  authTimedOut: boolean;
  gatherError: string | null;
}

function createCliInstallerRunDiag(): CliInstallerStatusRunDiag {
  return {
    versionError: null,
    authAttempts: 0,
    authLastError: null,
    authStdoutLen: 0,
    authStdoutTail: '',
    authTimedOut: false,
    gatherError: null,
  };
}

function resetGatherDiag(diag: CliInstallerStatusRunDiag): void {
  diag.versionError = null;
  diag.authAttempts = 0;
  diag.authLastError = null;
  diag.authStdoutLen = 0;
  diag.authStdoutTail = '';
  diag.authTimedOut = false;
  diag.gatherError = null;
}

// =============================================================================
// Service
// =============================================================================

export class CliInstallerService {
  private mainWindow: BrowserWindow | null = null;
  private installing = false;
  private readonly multimodelBridgeService = new ClaudeMultimodelBridgeService();
  private readonly modelAvailabilityService = new CliProviderModelAvailabilityService(
    (providerId, signature, snapshot) => {
      this.handleProviderModelAvailabilityUpdate(providerId, signature, snapshot);
    }
  );
  private latestStatusSnapshot: CliInstallationStatus | null = null;
  private lastHealthyStatusSnapshot: CliInstallationStatus | null = null;
  private lastHealthyStatusObservedAt = 0;
  private readonly latestProviderSignatures = new Map<CliProviderId, string | null>();

  private rememberHealthyStatus(status: CliInstallationStatus): void {
    if (!status.installed || !status.binaryPath || status.launchError) {
      return;
    }

    this.lastHealthyStatusSnapshot = cloneCliInstallationStatus(status);
    this.lastHealthyStatusObservedAt = Date.now();
  }

  private getRecoverableHealthyStatus(binaryPath: string): CliInstallationStatus | null {
    if (
      !this.lastHealthyStatusSnapshot ||
      !this.lastHealthyStatusSnapshot.installed ||
      !this.lastHealthyStatusSnapshot.binaryPath ||
      this.lastHealthyStatusSnapshot.binaryPath !== binaryPath
    ) {
      return null;
    }

    if (Date.now() - this.lastHealthyStatusObservedAt > HEALTHY_STATUS_FALLBACK_TTL_MS) {
      return null;
    }

    return cloneCliInstallationStatus(this.lastHealthyStatusSnapshot);
  }

  private electronMetaForDiag(): Record<string, unknown> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { app } = require('electron') as typeof import('electron');
      return {
        electronPackaged: Boolean(app?.isPackaged),
        appVersion: typeof app?.getVersion === 'function' ? app.getVersion() : null,
        exePath:
          typeof app?.getPath === 'function'
            ? clipHeadForDiag(app.getPath('exe'), DIAG_PATH_HEAD)
            : null,
      };
    } catch {
      return { electronPackaged: null, appVersion: null, exePath: null };
    }
  }

  private async writeCliInstallerStatusDiag(
    r: CliInstallationStatus,
    diag: CliInstallerStatusRunDiag
  ): Promise<void> {
    const cached = getCachedShellEnv();
    const procPath = process.env.PATH ?? '';
    const mergedPath = buildMergedCliPath(r.binaryPath);
    const shellHome = cached?.HOME?.trim();
    const hasUsableShellPath = Boolean(cached?.PATH?.trim());
    const pathSep = process.platform === 'win32' ? pathWin32.delimiter : pathPosix.delimiter;
    await appendCliAuthDiag({
      event: 'cli_installer_get_status',
      ...this.electronMetaForDiag(),
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      shellHasPath: hasUsableShellPath,
      shellPathEntryCount: cached?.PATH ? cached.PATH.split(pathSep).filter(Boolean).length : 0,
      shellHomeSet: Boolean(shellHome),
      shellHomePreview: shellHome ? clipHeadForDiag(shellHome, DIAG_HOME_PREVIEW) : null,
      electronHome: getHomeDir(),
      preferredHome: getShellPreferredHome(),
      claudeConfigDir: getClaudeBasePath(),
      processPathLen: procPath.length,
      processPathHead: clipHeadForDiag(procPath, DIAG_PATH_HEAD),
      mergedPathLen: mergedPath.length,
      mergedPathHead: clipHeadForDiag(mergedPath, DIAG_PATH_HEAD),
      installed: r.installed,
      binaryPath: r.binaryPath ? clipHeadForDiag(r.binaryPath, DIAG_PATH_HEAD) : null,
      installedVersion: r.installedVersion,
      launchError: r.launchError ?? null,
      authLoggedIn: r.authLoggedIn,
      authMethod: r.authMethod,
      latestVersion: r.latestVersion,
      updateAvailable: r.updateAvailable,
      versionProbeError: diag.versionError,
      authProbeAttempts: diag.authAttempts,
      authProbeLastError: diag.authLastError,
      authStdoutLen: diag.authStdoutLen,
      authStdoutTail: clipTailForDiag(diag.authStdoutTail, DIAG_AUTH_STDOUT_TAIL),
      authProbeTimedOut: diag.authTimedOut,
      gatherThrownError: diag.gatherError,
    });
  }

  setMainWindow(window: BrowserWindow | null): void {
    this.mainWindow = window;
  }

  getLatestStatusSnapshot(): CliInstallationStatus | null {
    return this.latestStatusSnapshot ? cloneCliInstallationStatus(this.latestStatusSnapshot) : null;
  }

  invalidateStatusCache(): void {
    this.latestStatusSnapshot = null;
    this.latestProviderSignatures.clear();
    this.modelAvailabilityService.invalidate();
  }

  /**
   * Env for CLI subprocesses: login-shell vars + consistent HOME/PATH + same config root as the app.
   */
  private envForCli(binaryPath: string): NodeJS.ProcessEnv {
    return buildEnrichedEnv(binaryPath);
  }

  private createInitialStatus(): CliInstallationStatus {
    const flavor = getConfiguredCliFlavor();
    const ui = getCliFlavorUiOptions(flavor);
    const providers =
      flavor === 'agent_teams_orchestrator'
        ? (
            [
              {
                providerId: 'anthropic',
                displayName: 'Anthropic',
              },
              {
                providerId: 'codex',
                displayName: 'Codex',
              },
              {
                providerId: 'gemini',
                displayName: 'Gemini',
              },
              {
                providerId: 'opencode',
                displayName: 'OpenCode (75+ LLM providers)',
              },
            ] as const
          ).map((provider) => ({
            ...provider,
            supported: false,
            authenticated: false,
            authMethod: null,
            verificationState: 'unknown' as const,
            modelVerificationState: 'idle' as const,
            statusMessage: 'Checking...',
            models: [],
            modelAvailability: [],
            canLoginFromUi: provider.providerId !== 'opencode',
            capabilities: {
              teamLaunch: false,
              oneShot: false,
              extensions: createDefaultCliExtensionCapabilities(),
            },
            backend: null,
          }))
        : [];
    return {
      flavor,
      displayName: ui.displayName,
      supportsSelfUpdate: ui.supportsSelfUpdate,
      showVersionDetails: ui.showVersionDetails,
      showBinaryPath: ui.showBinaryPath,
      installed: false,
      installedVersion: null,
      binaryPath: null,
      launchError: null,
      latestVersion: null,
      updateAvailable: false,
      authLoggedIn: false,
      authStatusChecking: true,
      authMethod: null,
      providers,
    };
  }

  private publishStatusSnapshot(status: CliInstallationStatus): void {
    this.latestStatusSnapshot = cloneCliInstallationStatus(status);
    for (const provider of this.latestStatusSnapshot.providers) {
      if (
        provider.modelVerificationState === 'verifying' ||
        (provider.modelVerificationState === 'verified' &&
          (provider.modelAvailability?.length ?? 0) > 0)
      ) {
        this.latestProviderSignatures.set(
          provider.providerId,
          this.latestProviderSignatures.get(provider.providerId) ?? null
        );
      } else {
        this.latestProviderSignatures.set(provider.providerId, null);
      }
    }
    this.sendProgress({
      type: 'status',
      status: cloneCliInstallationStatus(this.latestStatusSnapshot),
    });
  }

  private buildProviderModelAvailabilityContext(
    binaryPath: string,
    installedVersion: string | null,
    provider: CliProviderStatus
  ): ProviderModelAvailabilityContext {
    return {
      binaryPath,
      installedVersion,
      provider: {
        providerId: provider.providerId,
        models: [...provider.models],
        supported: provider.supported,
        authenticated: provider.authenticated,
        authMethod: provider.authMethod,
        selectedBackendId: provider.selectedBackendId ?? null,
        resolvedBackendId: provider.resolvedBackendId ?? null,
        capabilities: {
          ...provider.capabilities,
          extensions: {
            ...createDefaultCliExtensionCapabilities(),
            ...provider.capabilities.extensions,
          },
        },
        backend: provider.backend ? { ...provider.backend } : null,
      },
    };
  }

  private applyProviderModelAvailability(
    binaryPath: string,
    installedVersion: string | null,
    providers: CliProviderStatus[]
  ): CliProviderStatus[] {
    return providers.map((provider) => {
      const snapshot = this.modelAvailabilityService.getSnapshot(
        this.buildProviderModelAvailabilityContext(binaryPath, installedVersion, provider)
      );
      this.latestProviderSignatures.set(provider.providerId, snapshot.signature);

      return {
        ...provider,
        modelVerificationState: snapshot.modelVerificationState,
        modelAvailability: cloneProviderModelAvailability(snapshot.modelAvailability),
      };
    });
  }

  private applyProviderModelAvailabilityToProvider(
    binaryPath: string,
    installedVersion: string | null,
    provider: CliProviderStatus
  ): CliProviderStatus {
    return this.applyProviderModelAvailability(binaryPath, installedVersion, [provider])[0];
  }

  private handleProviderModelAvailabilityUpdate(
    providerId: CliProviderId,
    signature: string,
    snapshot: ProviderModelAvailabilitySnapshot
  ): void {
    if (!this.latestStatusSnapshot) {
      return;
    }
    if (this.latestProviderSignatures.get(providerId) !== signature) {
      return;
    }

    const providerIndex = this.latestStatusSnapshot.providers.findIndex(
      (provider) => provider.providerId === providerId
    );
    if (providerIndex < 0) {
      return;
    }

    const nextProviders = [...this.latestStatusSnapshot.providers];
    nextProviders[providerIndex] = {
      ...nextProviders[providerIndex],
      modelVerificationState: snapshot.modelVerificationState,
      modelAvailability: cloneProviderModelAvailability(snapshot.modelAvailability),
    };
    this.latestStatusSnapshot = {
      ...this.latestStatusSnapshot,
      providers: nextProviders,
    };
    this.publishStatusSnapshot(this.latestStatusSnapshot);
  }

  private updateLatestProviderStatus(providerStatus: CliProviderStatus): void {
    if (
      providerStatus.modelVerificationState !== 'verifying' &&
      (providerStatus.modelAvailability?.length ?? 0) <= 0
    ) {
      this.latestProviderSignatures.set(providerStatus.providerId, null);
    }

    if (!this.latestStatusSnapshot) {
      return;
    }

    const hasProvider = this.latestStatusSnapshot.providers.some(
      (provider) => provider.providerId === providerStatus.providerId
    );
    const nextProviders = hasProvider
      ? this.latestStatusSnapshot.providers.map((provider) =>
          provider.providerId === providerStatus.providerId ? providerStatus : provider
        )
      : [...this.latestStatusSnapshot.providers, providerStatus];
    const authenticatedProvider = nextProviders.find((provider) => provider.authenticated) ?? null;

    this.latestStatusSnapshot = {
      ...this.latestStatusSnapshot,
      providers: nextProviders,
      authLoggedIn: nextProviders.some((provider) => provider.authenticated),
      authMethod: authenticatedProvider?.authMethod ?? null,
    };
  }

  // ---------------------------------------------------------------------------
  // Public: getStatus
  // ---------------------------------------------------------------------------

  async getStatus(): Promise<CliInstallationStatus> {
    const result = this.createInitialStatus();
    this.latestProviderSignatures.clear();
    this.latestStatusSnapshot = cloneCliInstallationStatus(result);

    // Run the actual status gathering with an overall timeout.
    // On timeout, return whatever partial result was collected so far.
    const ref = { current: result };
    const runDiag = createCliInstallerRunDiag();
    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        this.gatherStatus(ref, runDiag),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            logger.warn(
              `getStatus() timed out after ${GET_STATUS_TIMEOUT_MS}ms, returning partial result`
            );
            resolve();
          }, GET_STATUS_TIMEOUT_MS);
        }),
      ]);
      return result;
    } catch (err) {
      runDiag.gatherError = getErrorMessage(err);
      throw err;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      try {
        await this.writeCliInstallerStatusDiag(result, runDiag);
      } catch (diagErr) {
        logger.error('writeCliInstallerStatusDiag failed:', getErrorMessage(diagErr));
      }
    }
  }

  async getProviderStatus(providerId: CliProviderId): Promise<CliProviderStatus | null> {
    await resolveInteractiveShellEnv();

    const binaryPath = await ClaudeBinaryResolver.resolve();
    if (!binaryPath) {
      return null;
    }

    const flavor = getConfiguredCliFlavor();
    if (flavor !== 'agent_teams_orchestrator') {
      const fullStatus = await this.getStatus();
      return fullStatus.providers.find((provider) => provider.providerId === providerId) ?? null;
    }

    const versionProbe = await this.probeCliVersion(binaryPath);
    if (!versionProbe.ok) {
      return null;
    }

    const providerStatus = await this.multimodelBridgeService.getProviderStatus(
      binaryPath,
      providerId
    );
    this.updateLatestProviderStatus(providerStatus);
    return providerStatus;
  }

  async verifyProviderModels(providerId: CliProviderId): Promise<CliProviderStatus | null> {
    await resolveInteractiveShellEnv();

    const binaryPath = await ClaudeBinaryResolver.resolve();
    if (!binaryPath) {
      return null;
    }

    const flavor = getConfiguredCliFlavor();
    if (flavor !== 'agent_teams_orchestrator') {
      return this.getProviderStatus(providerId);
    }

    const versionProbe = await this.probeCliVersion(binaryPath);
    if (!versionProbe.ok) {
      return null;
    }

    if (providerId === 'opencode') {
      const providerStatus = await this.multimodelBridgeService.verifyProviderStatus(
        binaryPath,
        providerId
      );
      const nextProviderStatus = {
        ...providerStatus,
        modelVerificationState: 'idle' as const,
        modelAvailability: [],
      };
      this.updateLatestProviderStatus(nextProviderStatus);
      if (this.latestStatusSnapshot) {
        this.publishStatusSnapshot(this.latestStatusSnapshot);
      }
      return nextProviderStatus;
    }

    const providerStatus = await this.multimodelBridgeService.getProviderStatus(
      binaryPath,
      providerId
    );
    const nextProviderStatus = this.applyProviderModelAvailabilityToProvider(
      binaryPath,
      versionProbe.version,
      providerStatus
    );
    this.updateLatestProviderStatus(nextProviderStatus);
    if (this.latestStatusSnapshot) {
      this.publishStatusSnapshot(this.latestStatusSnapshot);
    }
    return nextProviderStatus;
  }

  /**
   * Gathers CLI status information, mutating the provided result object.
   * Split from getStatus() to enable overall timeout via Promise.race —
   * on timeout, getStatus() returns whatever fields were populated so far.
   *
   * Flow: binary resolve → --version (sequential) → Promise.all([auth, GCS]) (parallel)
   */
  private async gatherStatus(
    ref: { current: CliInstallationStatus },
    diag: CliInstallerStatusRunDiag
  ): Promise<void> {
    resetGatherDiag(diag);
    await resolveInteractiveShellEnv();

    const r = ref.current;
    const binaryPath = await ClaudeBinaryResolver.resolve();
    if (binaryPath) {
      r.binaryPath = binaryPath;
      const versionProbe = await this.probeCliVersion(binaryPath);
      if (versionProbe.ok) {
        r.installed = true;
        r.installedVersion = versionProbe.version;
        r.launchError = null;
        r.authStatusChecking = true;
        this.rememberHealthyStatus(r);
        this.publishStatusSnapshot(r);

        // Auth and GCS version check are independent — run in parallel.
        // Both mutate `r` directly so partial results survive the outer timeout.
        await Promise.all([
          this.checkAuthStatus(binaryPath, r, diag),
          r.supportsSelfUpdate ? this.fetchLatestVersion(r) : Promise.resolve(),
        ]);
        this.rememberHealthyStatus(r);
        this.publishStatusSnapshot(r);
      } else {
        const recoveredHealthyStatus = this.getRecoverableHealthyStatus(binaryPath);
        if (recoveredHealthyStatus) {
          logger.warn(
            `CLI version probe failed for ${binaryPath}, reusing last healthy status snapshot: ${versionProbe.error}`
          );
          Object.assign(r, recoveredHealthyStatus, {
            launchError: null,
          });
          this.publishStatusSnapshot(r);
          return;
        }

        diag.versionError = versionProbe.error;
        r.installed = false;
        r.installedVersion = null;
        r.launchError = versionProbe.error;
        r.authStatusChecking = false;
        this.markProvidersUnavailable(
          r,
          r.binaryPath ? 'Runtime found, but startup health check failed.' : 'Runtime unavailable.'
        );
        if (diag.versionError) {
          logger.warn('Failed to get CLI version:', diag.versionError);
        }
        if (r.supportsSelfUpdate) {
          await this.fetchLatestVersion(r);
        }
        this.publishStatusSnapshot(r);
      }
    } else {
      // No binary — still check latest version for "install" prompt
      r.authStatusChecking = false;
      r.launchError = null;
      this.markProvidersUnavailable(r, 'Runtime not found.');
      if (r.supportsSelfUpdate) {
        await this.fetchLatestVersion(r);
      }
      this.publishStatusSnapshot(r);
    }
  }

  private async probeCliVersion(
    binaryPath: string
  ): Promise<{ ok: true; version: string | null } | { ok: false; error: string }> {
    let lastError: string | null = null;

    for (let attempt = 1; attempt <= VERSION_RETRY_ATTEMPTS; attempt += 1) {
      try {
        const { stdout } = await execCli(binaryPath, ['--version'], {
          timeout: VERSION_TIMEOUT_MS,
          env: this.envForCli(binaryPath),
        });
        const version = normalizeVersion(stdout);
        if (!version) {
          return { ok: false, error: 'CLI returned an empty version string.' };
        }

        if (isSemverVersion(version)) {
          logger.info(`Installed CLI version: "${stdout.trim()}" → normalized: "${version}"`);
          return { ok: true, version };
        }

        const inferredVersion = await this.inferInstalledCliVersionFromPath(binaryPath);
        if (inferredVersion) {
          logger.info(
            `Installed CLI version was inferred from installer path: "${stdout.trim()}" → "${inferredVersion}"`
          );
          return { ok: true, version: inferredVersion };
        }

        logger.warn(
          `Installed CLI returned a non-semver version string: "${stdout.trim()}". ` +
            'Treating the binary as healthy, but omitting version details.'
        );
        return { ok: true, version: null };
      } catch (err) {
        lastError = getErrorMessage(err);
        if (attempt < VERSION_RETRY_ATTEMPTS) {
          logger.warn(
            `CLI version probe failed (attempt ${attempt}/${VERSION_RETRY_ATTEMPTS}), retrying after ${VERSION_RETRY_DELAY_MS}ms: ${lastError}`
          );
          await sleep(VERSION_RETRY_DELAY_MS);
          continue;
        }
      }
    }

    return { ok: false, error: lastError ?? 'Failed to run runtime version probe.' };
  }

  private async inferInstalledCliVersionFromPath(binaryPath: string): Promise<string | null> {
    try {
      const resolvedPath = await fsp.realpath(binaryPath);
      if (!/[\\/]+versions[\\/]+/.test(resolvedPath)) {
        return null;
      }

      const inferredVersion = normalizeVersion(resolvedPath);
      return isSemverVersion(inferredVersion) ? inferredVersion : null;
    } catch {
      return null;
    }
  }

  private markProvidersUnavailable(result: CliInstallationStatus, message: string): void {
    if (result.flavor !== 'agent_teams_orchestrator') {
      return;
    }

    result.providers = result.providers.map((provider) => ({
      ...provider,
      authenticated: false,
      authMethod: null,
      verificationState: 'error',
      modelVerificationState: 'idle',
      statusMessage: message,
      models: [],
      modelAvailability: [],
      canLoginFromUi: false,
      backend: null,
    }));
    result.authLoggedIn = false;
    result.authMethod = null;
  }

  /**
   * Check auth status with retry — covers stale lock files after Ctrl+C interruption.
   * Wrapped in its own timeout to prevent slow auth from blocking the overall status.
   * Mutates `r` directly so results survive even if the outer Promise.all hasn't resolved.
   */

  private async checkAuthStatus(
    binaryPath: string,
    result: CliInstallationStatus,
    diag: CliInstallerStatusRunDiag
  ): Promise<void> {
    if (result.flavor === 'agent_teams_orchestrator') {
      result.authStatusChecking = true;
      try {
        const providers = await this.multimodelBridgeService.getProviderStatuses(
          binaryPath,
          (providersSnapshot) => {
            result.providers = providersSnapshot;
            result.authLoggedIn = providersSnapshot.some((provider) => provider.authenticated);
            result.authMethod =
              providersSnapshot.find((provider) => provider.authenticated)?.authMethod ?? null;
            this.publishStatusSnapshot(result);
          }
        );
        result.providers = providers;
        result.authLoggedIn = providers.some((provider) => provider.authenticated);
        result.authMethod =
          providers.find((provider) => provider.authenticated)?.authMethod ?? null;
        result.authStatusChecking = false;
        this.publishStatusSnapshot(result);
      } catch (error) {
        const msg = getErrorMessage(error);
        diag.authLastError = msg;
        result.authStatusChecking = false;
        logger.warn(`Provider status check failed for claude-multimodel: ${msg}`);
      }
      return;
    }

    const doCheck = async (): Promise<void> => {
      for (let authAttempt = 1; authAttempt <= AUTH_STATUS_MAX_RETRIES; authAttempt++) {
        diag.authAttempts = authAttempt;
        try {
          const { stdout: authStdout } = await execCli(binaryPath, ['auth', 'status'], {
            timeout: VERSION_TIMEOUT_MS,
            env: this.envForCli(binaryPath),
          });
          diag.authStdoutLen = authStdout.length;
          diag.authStdoutTail = authStdout.slice(-DIAG_AUTH_STDOUT_TAIL);
          const auth = parseClaudeAuthStatusStdout(authStdout);
          result.authLoggedIn = auth.loggedIn === true;
          result.authMethod = auth.authMethod ?? null;
          result.authStatusChecking = false;
          diag.authLastError = null;
          logger.info(
            `Auth status: loggedIn=${result.authLoggedIn}, method=${result.authMethod ?? 'null'}` +
              (authAttempt > 1 ? ` (attempt ${authAttempt})` : '')
          );
          return;
        } catch (err) {
          const msg = getErrorMessage(err);
          diag.authLastError = msg;
          if (authAttempt < AUTH_STATUS_MAX_RETRIES) {
            logger.warn(
              `Auth status check failed (attempt ${authAttempt}/${AUTH_STATUS_MAX_RETRIES}), ` +
                `retrying in ${AUTH_STATUS_RETRY_DELAY_MS}ms: ${msg}`
            );
            await new Promise((resolve) => setTimeout(resolve, AUTH_STATUS_RETRY_DELAY_MS));
          } else {
            logger.warn(
              `Auth status check failed after ${AUTH_STATUS_MAX_RETRIES} attempts: ${msg}`
            );
            result.authLoggedIn = false;
            result.authStatusChecking = false;
          }
        }
      }
    };

    // Own timeout so slow auth doesn't eat the overall getStatus budget
    let timer: ReturnType<typeof setTimeout> | null = null;
    let hitAuthTimeout = false;
    try {
      await Promise.race([
        doCheck(),
        new Promise<void>((resolve) => {
          timer = setTimeout(() => {
            hitAuthTimeout = true;
            logger.warn(`Auth status check timed out after ${AUTH_TOTAL_TIMEOUT_MS}ms`);
            resolve();
          }, AUTH_TOTAL_TIMEOUT_MS);
        }),
      ]);
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
      result.authStatusChecking = false;
      diag.authTimedOut = hitAuthTimeout;
    }
  }

  /**
   * Fetch latest CLI version from GCS and update the result object.
   */
  private async fetchLatestVersion(result: CliInstallationStatus): Promise<void> {
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
  }

  // ---------------------------------------------------------------------------
  // Public: install
  // ---------------------------------------------------------------------------

  async install(): Promise<void> {
    if (!getCliFlavorUiOptions(getConfiguredCliFlavor()).supportsSelfUpdate) {
      const error = 'Updates are disabled for the configured agent_teams_orchestrator runtime.';
      logger.warn(error);
      this.sendProgress({ type: 'error', error });
      return;
    }

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

      // On Windows, antivirus (Defender) scans new executables on first access.
      // A brief pause lets the scan complete before we spawn, preventing EBUSY.
      if (process.platform === 'win32') {
        await new Promise((r) => setTimeout(r, 1000));
      }

      this.sendProgress({
        type: 'installing',
        detail: 'Starting shell integration...',
        rawChunk: 'Starting shell integration...\r\n',
      });
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
    safeSendToRenderer(this.mainWindow, CLI_INSTALLER_PROGRESS_CHANNEL, progress);
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
        const digest = hash.digest('hex');
        fileStream.end();
        // Wait for 'close' (not just 'finish') — ensures file descriptor is fully released.
        // On Windows, spawning the file before 'close' can cause EBUSY.
        fileStream.on('close', () => resolve(digest));
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
   * Retries on EBUSY (antivirus scanning the new binary).
   */
  private async runInstallWithStreaming(binaryPath: string, attempt = 1): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const child = spawnCli(binaryPath, ['install'], {
        env: { ...this.envForCli(binaryPath), CLAUDE_SKIP_ANALYTICS: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      const timeout = setTimeout(() => {
        killProcessTree(child);
        reject(
          new Error(
            `Timed out after ${INSTALL_TIMEOUT_MS / 1000}s. ` +
              `The install process may still be running in the background.`
          )
        );
      }, INSTALL_TIMEOUT_MS);

      const outputLines: string[] = [];

      const handleOutput = (chunk: Buffer): void => {
        const raw = chunk.toString('utf-8');
        if (!raw.trim()) return;

        // Send raw chunk for xterm.js rendering in UI
        this.sendProgress({ type: 'installing', rawChunk: raw });

        // Extract clean text for logger and error context
        for (const line of raw.split('\n')) {
          // eslint-disable-next-line no-control-regex, sonarjs/no-control-regex -- ANSI escape sequences stripped for clean logs
          const clean = line.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, '').trim();
          if (clean) {
            outputLines.push(clean);
            logger.info(`[claude install] ${clean}`);
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

        // EBUSY: antivirus (Windows Defender / macOS Gatekeeper) may be scanning the binary — retry
        const isEbusy = (err as NodeJS.ErrnoException).code === 'EBUSY';
        if (isEbusy && attempt < EBUSY_MAX_RETRIES) {
          const delayMs = attempt * EBUSY_RETRY_DELAY_MS;
          logger.warn(
            `spawn EBUSY (attempt ${attempt}/${EBUSY_MAX_RETRIES}), retrying in ${delayMs}ms...`
          );
          this.sendProgress({
            type: 'installing',
            rawChunk: `\r\n⏳ File busy (OS scan), retrying in ${delayMs / 1000}s...\r\n`,
          });
          setTimeout(() => {
            this.runInstallWithStreaming(binaryPath, attempt + 1).then(resolve, reject);
          }, delayMs);
          return;
        }

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
