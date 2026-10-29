import {
  classifyNativeVersion,
  getLatestQualifiedOpenCodeV2Version,
  isRecognizedOpenCodeRuntimeVersion,
} from '@features/opencode-compatibility';
import {
  chooseOpenCodeInstallGeneration,
  parseOpenCodeInstallOptions,
} from '@features/opencode-runtime-installer';
import {
  extractOpenCodePackage,
  selectOpenCodeInstallPackage,
} from '@features/opencode-runtime-installer/main';
import {
  type OpenCodeBinaryCandidateFailure,
  type OpenCodeBinaryVersionProbe,
  probeOpenCodeBinaryVersion,
} from '@features/runtime-provider-management/main';
import { detectOpenCodeNativeFacts } from '@main/services/runtime/openCodeNativePlatform';
import { getOpenCodeNativePackages } from '@main/services/runtime/openCodeNativePolicy';
import { readOpenCodeBinaryOverride } from '@main/services/runtime/openCodeRuntimeBinaryEnv';
import { atomicWriteAsync, renamePathWithRetry } from '@main/utils/atomicWrite';
import { execCli } from '@main/utils/childProcess';
import { getAppDataPath } from '@main/utils/pathDecoder';
import {
  collectRuntimePathBinaryCandidates,
  isAbsoluteExistingFile,
  RUNTIME_PATH_SHELL_ENV_TIMEOUT_MS,
} from '@main/utils/runtimePathBinaryResolver';
import { safeSendToRenderer } from '@main/utils/safeWebContentsSend';
import { getShellPreferredHome, resolveInteractiveShellEnvBestEffort } from '@main/utils/shellEnv';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import {
  getUnsupportedAgentTeamsOpenCodeVersionMessage,
  isAgentTeamsOpenCodeVersionSupported,
} from '@shared/utils/version';
import { createHash, randomUUID } from 'crypto';
import { promises as fsp, readdirSync } from 'fs';
import path from 'path';

import {
  preserveKnownOpenCodeUpdate,
  resolveLatestOpenCodeVersion,
  withLatestOpenCodeVersion,
} from './openCodeRuntimeLatestVersion';
import {
  managedFileIdentity,
  readManagedProjection,
  rememberManagedProjection,
} from './openCodeRuntimeManagedProjection';
import {
  CURRENT_MANIFEST_SCHEMA_VERSION,
  type OpenCodeRuntimeManifest,
  readRuntimeManifest,
  readRuntimeManifestSync,
} from './openCodeRuntimeManifest';
import {
  getOpenCodeRuntimePlatformCandidates,
  matchesNativePackagePolicy,
} from './openCodeRuntimeNativeSelection';
import {
  getUnverifiedOpenCodeOverrideMessage,
  matchesOpenCodeRuntimeGeneration,
  resolveOpenCodeStatusWithOverride,
} from './openCodeRuntimeOverrideStatus';
import { fetchOpenCodePackageMetadata } from './openCodeRuntimePackageMetadata';
import {
  clearOpenCodeRuntimeResolverCache,
  getOpenCodeRuntimeResolverCacheGeneration,
  pathProbeCache,
  pathProbeInFlight,
  resolveCachedVerifiedOpenCodeRuntimeBinaryPath as readCachedVerifiedOpenCodeRuntimeBinaryPath,
  runtimeBinaryResolveCache,
  runtimeBinaryResolveInFlight,
  setPathProbeCacheEntry,
  setPathProbeInFlight,
  setRuntimeBinaryResolveCacheEntry,
  setRuntimeBinaryResolveInFlight,
  setVersionProbeCacheEntry,
  setVersionProbeInFlight,
  versionProbeCache,
  versionProbeInFlight,
} from './openCodeRuntimeResolverCache';
import { collectWindowsNativeOpenCodeBinaryCandidates } from './openCodeWindowsNpmBinaryDiscovery';

import type { VerifiedOpenCodeBinaryProbe } from './openCodeRuntimeResolverCache';
import type {
  OpenCodeRuntimeInstallOptions,
  OpenCodeRuntimeInstallProgress,
  OpenCodeRuntimeStatus,
} from '@shared/types';
import type { BrowserWindow } from 'electron';
export {
  getOpenCodeRuntimePlatformCandidates,
  type PlatformCandidate,
} from './openCodeRuntimeNativeSelection';
export { clearOpenCodeRuntimeResolverCache as clearOpenCodeRuntimeBinaryResolverCache } from './openCodeRuntimeResolverCache';

const logger = createLogger('OpenCodeRuntimeInstallerService');

const CHANNEL = 'openCodeRuntime:progress';
const MAX_TARBALL_BYTES = 250 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 30_000;
const VERSION_PROBE_SUCCESS_CACHE_TTL_MS = 30_000;
const VERSION_PROBE_FAILURE_CACHE_TTL_MS = 5_000;
const RUNTIME_STATUS_SUCCESS_CACHE_TTL_MS = 30_000;
const RUNTIME_STATUS_FAILURE_CACHE_TTL_MS = 5_000;

function getRuntimeRootPath(): string {
  return path.join(getAppDataPath(), 'runtimes', 'opencode');
}

function getCurrentManifestPath(): string {
  return path.join(getRuntimeRootPath(), 'current.json');
}

function readCurrentManifestSync(): OpenCodeRuntimeManifest | null {
  return readRuntimeManifestSync(getCurrentManifestPath());
}

/** Passive locator: only an unchanged, policy-admitted and version-verified capture can be projected. */
export function resolveAppManagedOpenCodeRuntimeBinaryPath(): string | null {
  return readManagedProjection(
    readCurrentManifestSync(),
    getOpenCodeRuntimeResolverCacheGeneration()
  );
}

export function resolveCachedVerifiedOpenCodeRuntimeBinaryPath(): string | null {
  const cached = readCachedVerifiedOpenCodeRuntimeBinaryPath();
  const manifest = readCurrentManifestSync();
  // A stale generic cache cannot resurrect the current manifest's rejected selection, including aliases.
  const identity = manifest ? managedFileIdentity(manifest.binaryPath) : null;
  const sameTarget =
    cached &&
    manifest &&
    (normalizeBinaryCandidateForCompare(manifest.binaryPath) ===
      normalizeBinaryCandidateForCompare(cached) ||
      (identity !== null && identity === managedFileIdentity(cached)));
  return sameTarget && resolveAppManagedOpenCodeRuntimeBinaryPath() !== cached ? null : cached;
}

/** Cold status/catalog preparation stays async; the passive projection itself never probes. */
export async function preparePassiveOpenCodeRuntimeBinaryProjection(): Promise<void> {
  if (readOpenCodeBinaryOverride(process.env) || resolveAppManagedOpenCodeRuntimeBinaryPath())
    return;
  await resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath();
}

export async function resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath(): Promise<string | null> {
  const manifest = readCurrentManifestSync();
  const binaryPath = manifest?.binaryPath;
  if (
    !isAbsoluteExistingFile(binaryPath) ||
    !manifest ||
    !(await matchesNativePackagePolicy(manifest.platformPackage))
  ) {
    return null;
  }
  const identity = managedFileIdentity(binaryPath),
    generation = getOpenCodeRuntimeResolverCacheGeneration();
  const version = await probeOpenCodeBinaryVersionCached(binaryPath);
  if (!version.ok || !isRecognizedOpenCodeRuntimeVersion(version.version)) return null;
  return rememberManagedProjection(
    manifest,
    identity,
    generation,
    readCurrentManifestSync(),
    getOpenCodeRuntimeResolverCacheGeneration()
  )
    ? binaryPath
    : null;
}

export async function isSupportedOpenCodeRuntimeBinaryPath(
  binaryPath: string,
  generation?: 'v1' | 'v2'
): Promise<boolean> {
  if (!isAbsoluteExistingFile(binaryPath)) {
    return false;
  }
  const version = await probeOpenCodeBinaryVersionCached(binaryPath);
  if (!version.ok) {
    // A failed probe does not establish that the selected delivery is unsupported.
    // Preserve explicit selection so a transient timeout cannot launch another binary.
    throw new Error(getUnverifiedOpenCodeOverrideMessage(binaryPath));
  }
  return matchesOpenCodeRuntimeGeneration(binaryPath, version.version, generation);
}

function getExecutableName(): string {
  return process.platform === 'win32' ? 'opencode.exe' : 'opencode';
}

function getPathExecutableNames(): string[] {
  return process.platform === 'win32'
    ? ['opencode.exe', 'opencode.cmd', 'opencode.bat', 'opencode']
    : ['opencode'];
}

function collectPathOpenCodeBinaryCandidates(
  additionalEnvSources: (NodeJS.ProcessEnv | null | undefined)[] = [],
  options: { includeFallbackPathEntries?: boolean } = {}
): string[] {
  return collectRuntimePathBinaryCandidates({
    executableNames: getPathExecutableNames(),
    // Prefer the environment that launched the desktop app over a cached login-shell
    // snapshot. On Windows, NVM can leave an older OpenCode shim in the cached shell
    // PATH while the active npm prefix exposes the current installation.
    additionalEnvSources:
      process.platform === 'win32' ? [process.env, ...additionalEnvSources] : additionalEnvSources,
    includeFallbackPathEntries: options.includeFallbackPathEntries,
    extraCandidates: collectNvmOpenCodeBinaryCandidates(),
  });
}

function collectNvmOpenCodeBinaryCandidates(): string[] {
  if (process.platform === 'win32') {
    const appdata = process.env.APPDATA;
    const activeNvmDirectory = process.env.NVM_SYMLINK;
    const rootCandidates = [process.env.NVM_HOME, ...(appdata ? [path.join(appdata, 'nvm')] : [])];
    const seenRoots = new Set<string>();
    const versionedCandidates = rootCandidates.flatMap((rootPath) => {
      if (!rootPath) return [];
      const normalized = path.resolve(rootPath).toLowerCase();
      if (seenRoots.has(normalized)) return [];
      seenRoots.add(normalized);
      return collectVersionedOpenCodeBinaryCandidates(rootPath);
    });
    return [
      ...(activeNvmDirectory
        ? getPathExecutableNames().map((executableName) =>
            path.join(activeNvmDirectory, executableName)
          )
        : []),
      ...versionedCandidates,
    ];
  }

  return collectVersionedOpenCodeBinaryCandidates(
    path.join(getShellPreferredHome(), '.nvm', 'versions', 'node'),
    'bin'
  );
}

function collectVersionedOpenCodeBinaryCandidates(rootPath: string, binSegment = ''): string[] {
  let versions: string[];
  try {
    versions = readdirSync(rootPath);
  } catch {
    return [];
  }

  return versions
    .toSorted((left, right) => right.localeCompare(left, undefined, { numeric: true }))
    .flatMap((version) => {
      const versionPath = binSegment
        ? path.join(rootPath, version, binSegment)
        : path.join(rootPath, version);
      return getPathExecutableNames().map((executableName) =>
        path.join(versionPath, executableName)
      );
    });
}

function normalizeBinaryCandidateForCompare(binaryPath: string): string {
  const normalized = path.resolve(binaryPath);
  return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}

function getVersionProbeTtlMs(result: OpenCodeBinaryVersionProbe): number {
  return result.ok ? VERSION_PROBE_SUCCESS_CACHE_TTL_MS : VERSION_PROBE_FAILURE_CACHE_TTL_MS;
}

async function probeOpenCodeBinaryVersionCached(
  binaryPath: string
): Promise<OpenCodeBinaryVersionProbe> {
  const cacheKey = `${normalizeBinaryCandidateForCompare(binaryPath)}\0${managedFileIdentity(binaryPath) ?? 'missing'}`;
  const cached = versionProbeCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < cached.ttlMs) {
    return cached.result;
  }

  const inFlight = versionProbeInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const cacheGeneration = getOpenCodeRuntimeResolverCacheGeneration();
  const request = probeOpenCodeBinaryVersion(binaryPath)
    .then((result) => {
      if (result.ok && result.version) {
        const classified = classifyNativeVersion(result.version);
        if (classified.kind === 'recognized') result = { ...result, version: classified.version };
      }
      if (cacheGeneration === getOpenCodeRuntimeResolverCacheGeneration()) {
        setVersionProbeCacheEntry(cacheKey, {
          result,
          cachedAt: Date.now(),
          ttlMs: getVersionProbeTtlMs(result),
        });
      }
      return result;
    })
    .finally(() => {
      if (versionProbeInFlight.get(cacheKey) === request) {
        versionProbeInFlight.delete(cacheKey);
      }
    });
  setVersionProbeInFlight(cacheKey, request);
  return request;
}

/** PATH discovery state shared by its successive candidate stages. */
interface OpenCodeBinaryCandidateSearch {
  seen: Set<string>;
  firstFailure: OpenCodeBinaryCandidateFailure | null;
  /** First recognized binary not qualified on this platform; any qualified one on PATH wins. */
  firstUnqualified: { binaryPath: string; version: string | null } | null;
}

async function probeFirstQualifiedOpenCodeBinaryCandidate(
  candidates: string[],
  search: OpenCodeBinaryCandidateSearch
): Promise<{ binaryPath: string; version: string | null } | null> {
  for (const binaryPath of candidates) {
    const packages =
      process.platform === 'win32'
        ? getOpenCodeNativePackages(await detectOpenCodeNativeFacts())
        : [];
    for (const launchBinaryPath of collectWindowsNativeOpenCodeBinaryCandidates(
      binaryPath,
      packages
    )) {
      const normalized = normalizeBinaryCandidateForCompare(launchBinaryPath);
      if (search.seen.has(normalized)) {
        continue;
      }
      search.seen.add(normalized);
      const version = await probeOpenCodeBinaryVersionCached(launchBinaryPath);
      if (version.ok && isRecognizedOpenCodeRuntimeVersion(version.version)) {
        const found = { binaryPath: launchBinaryPath, version: version.version };
        if (isAgentTeamsOpenCodeVersionSupported(version.version)) return found;
        search.firstUnqualified ??= found;
        continue;
      }
      search.firstFailure ??= {
        ...(!version.ok
          ? { diagnostics: { ...version.diagnostics, binarySource: 'path' as const } }
          : {}),
        binaryPath: launchBinaryPath,
        error: version.ok
          ? getUnsupportedAgentTeamsOpenCodeVersionMessage(version.version)
          : version.error,
      };
    }
  }
  return null;
}

interface OpenCodeRuntimeBinaryResolveOptions {
  shellEnvTimeoutMs?: number;
  includeShellEnv?: boolean;
}

function getPathProbeCacheKey(options: OpenCodeRuntimeBinaryResolveOptions = {}): string {
  if (options.includeShellEnv === false) {
    return 'no-shell-env';
  }

  return `shell-env:${options.shellEnvTimeoutMs ?? RUNTIME_PATH_SHELL_ENV_TIMEOUT_MS}`;
}

function getPathProbeTtlMs(result: VerifiedOpenCodeBinaryProbe): number {
  return result.ok ? VERSION_PROBE_SUCCESS_CACHE_TTL_MS : VERSION_PROBE_FAILURE_CACHE_TTL_MS;
}

function getRuntimeBinaryResolveTtlMs(binaryPath: string | null): number {
  return binaryPath ? VERSION_PROBE_SUCCESS_CACHE_TTL_MS : VERSION_PROBE_FAILURE_CACHE_TTL_MS;
}

async function probeFirstWorkingPathOpenCodeBinary(
  options: OpenCodeRuntimeBinaryResolveOptions = {}
): Promise<VerifiedOpenCodeBinaryProbe> {
  const search: OpenCodeBinaryCandidateSearch = {
    seen: new Set<string>(),
    firstFailure: null,
    firstUnqualified: null,
  };
  const found =
    (await probeFirstQualifiedOpenCodeBinaryCandidate(
      collectPathOpenCodeBinaryCandidates([], { includeFallbackPathEntries: false }),
      search
    )) ??
    (options.includeShellEnv === false
      ? await probeFirstQualifiedOpenCodeBinaryCandidate(
          collectPathOpenCodeBinaryCandidates([], { includeFallbackPathEntries: true }),
          search
        )
      : await probeShellEnvOpenCodeBinaryCandidates(options, search));
  const selected = found ?? search.firstUnqualified;
  return selected ? { ok: true, ...selected } : { ok: false, firstFailure: search.firstFailure };
}

async function probeShellEnvOpenCodeBinaryCandidates(
  options: OpenCodeRuntimeBinaryResolveOptions,
  search: OpenCodeBinaryCandidateSearch
): Promise<{ binaryPath: string; version: string | null } | null> {
  const shellEnv = await resolveInteractiveShellEnvBestEffort({
    timeoutMs: options.shellEnvTimeoutMs ?? RUNTIME_PATH_SHELL_ENV_TIMEOUT_MS,
    fallbackEnv: process.env,
  });
  return (
    (await probeFirstQualifiedOpenCodeBinaryCandidate(
      collectPathOpenCodeBinaryCandidates([shellEnv], { includeFallbackPathEntries: false }),
      search
    )) ??
    (await probeFirstQualifiedOpenCodeBinaryCandidate(
      collectPathOpenCodeBinaryCandidates([shellEnv]),
      search
    ))
  );
}

async function probeFirstWorkingPathOpenCodeBinaryCached(
  options: OpenCodeRuntimeBinaryResolveOptions = {}
): Promise<VerifiedOpenCodeBinaryProbe> {
  const cacheKey = getPathProbeCacheKey(options);
  const cached = pathProbeCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < cached.ttlMs) {
    return cached.result;
  }

  const inFlight = pathProbeInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const cacheGeneration = getOpenCodeRuntimeResolverCacheGeneration();
  const request = probeFirstWorkingPathOpenCodeBinary(options)
    .then((result) => {
      if (cacheGeneration === getOpenCodeRuntimeResolverCacheGeneration()) {
        setPathProbeCacheEntry(cacheKey, {
          result,
          cachedAt: Date.now(),
          ttlMs: getPathProbeTtlMs(result),
        });
      }
      return result;
    })
    .finally(() => {
      if (pathProbeInFlight.get(cacheKey) === request) {
        pathProbeInFlight.delete(cacheKey);
      }
    });
  setPathProbeInFlight(cacheKey, request);
  return request;
}

async function resolveVerifiedPathOpenCodeBinaryPath(
  options: OpenCodeRuntimeBinaryResolveOptions = {}
): Promise<string | null> {
  const result = await probeFirstWorkingPathOpenCodeBinaryCached(options);
  return result.ok ? result.binaryPath : null;
}

export async function resolveVerifiedOpenCodeRuntimeBinaryPath(
  options: OpenCodeRuntimeBinaryResolveOptions = {}
): Promise<string | null> {
  const cacheKey = getPathProbeCacheKey(options);
  const cached = runtimeBinaryResolveCache.get(cacheKey);
  if (cached && Date.now() - cached.cachedAt < cached.ttlMs) {
    return cached.binaryPath;
  }

  const inFlight = runtimeBinaryResolveInFlight.get(cacheKey);
  if (inFlight) {
    return inFlight;
  }

  const cacheGeneration = getOpenCodeRuntimeResolverCacheGeneration();
  const request = (async () =>
    (await resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath()) ??
    (await resolveVerifiedPathOpenCodeBinaryPath(options)))()
    .then((binaryPath) => {
      if (cacheGeneration === getOpenCodeRuntimeResolverCacheGeneration()) {
        setRuntimeBinaryResolveCacheEntry(cacheKey, {
          binaryPath,
          cachedAt: Date.now(),
          ttlMs: getRuntimeBinaryResolveTtlMs(binaryPath),
        });
      }
      return binaryPath;
    })
    .finally(() => {
      if (runtimeBinaryResolveInFlight.get(cacheKey) === request) {
        runtimeBinaryResolveInFlight.delete(cacheKey);
      }
    });
  setRuntimeBinaryResolveInFlight(cacheKey, request);
  return request;
}

export function verifyOpenCodeRuntimePackageIntegrity(buffer: Buffer, integrity: string): void {
  const match = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity.trim());
  if (!match) {
    throw new Error('OpenCode package integrity is missing sha512 metadata');
  }
  const actual = createHash('sha512').update(buffer).digest('base64');
  if (actual !== match[1]) {
    throw new Error('OpenCode package integrity check failed');
  }
}

async function downloadTarball(
  url: string,
  onProgress: (progress: OpenCodeRuntimeInstallProgress) => void
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download OpenCode package: HTTP ${response.status}`);
    }
    const totalHeader = response.headers.get('content-length');
    const totalBytes = totalHeader ? Number.parseInt(totalHeader, 10) : undefined;
    if (totalBytes && totalBytes > MAX_TARBALL_BYTES) {
      throw new Error('OpenCode package is unexpectedly large');
    }

    const chunks: Buffer[] = [];
    let downloadedBytes = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        break;
      }
      const chunk = Buffer.from(value);
      downloadedBytes += chunk.length;
      if (downloadedBytes > MAX_TARBALL_BYTES) {
        throw new Error('OpenCode package exceeded the maximum allowed download size');
      }
      chunks.push(chunk);
      onProgress({
        phase: 'downloading',
        downloadedBytes,
        totalBytes,
        percent: totalBytes
          ? Math.min(100, Math.round((downloadedBytes / totalBytes) * 100))
          : undefined,
        detail: totalBytes
          ? `Downloading OpenCode ${Math.round((downloadedBytes / totalBytes) * 100)}%`
          : 'Downloading OpenCode...',
      });
    }
    return Buffer.concat(chunks, downloadedBytes);
  } finally {
    clearTimeout(timer);
  }
}

export function extractOpenCodeRuntimeBinaryFromTarball(tarball: Buffer): Buffer {
  return extractOpenCodePackage(tarball, getExecutableName()).binary;
}

function readCurrentManifest(): Promise<OpenCodeRuntimeManifest | null> {
  return readRuntimeManifest(getCurrentManifestPath());
}

export class OpenCodeRuntimeInstallerService {
  private mainWindow: BrowserWindow | null = null;
  private installPromise: Promise<OpenCodeRuntimeStatus> | null = null;
  private installGeneration: OpenCodeRuntimeInstallOptions['generation'];
  private latestStatus: OpenCodeRuntimeStatus | null = null;
  private latestStatusAt = 0;
  private statusPromise: Promise<OpenCodeRuntimeStatus> | null = null;
  private statusCacheGeneration = 0;

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win;
  }

  invalidateStatusCache(): void {
    this.statusCacheGeneration += 1;
    this.latestStatus = null;
    this.latestStatusAt = 0;
    this.statusPromise = null;
    clearOpenCodeRuntimeResolverCache();
  }

  async getStatus(): Promise<OpenCodeRuntimeStatus> {
    if (this.installPromise && this.latestStatus) {
      return this.latestStatus;
    }
    if (this.installPromise) {
      return this.installPromise;
    }

    if (this.latestStatus && Date.now() - this.latestStatusAt < this.getStatusCacheTtlMs()) {
      return this.latestStatus;
    }

    if (this.statusPromise) {
      return this.statusPromise;
    }

    const statusCacheGeneration = this.statusCacheGeneration;
    const request = this.resolveStatus(statusCacheGeneration).finally(() => {
      if (this.statusPromise === request) {
        this.statusPromise = null;
      }
    });
    this.statusPromise = request;
    return request;
  }

  /** Version-only readiness checks must not wait for npm update metadata. */
  getReadinessStatus(): Promise<OpenCodeRuntimeStatus> {
    return this.resolveInstalledStatus();
  }

  private async resolveStatus(statusCacheGeneration: number): Promise<OpenCodeRuntimeStatus> {
    const status = await this.resolveInstalledStatus();
    // Managed update metadata cannot change which binary an override selects.
    const versionAwareStatus =
      status.installed && status.source !== 'override'
        ? await withLatestOpenCodeVersion(
            status,
            () => resolveLatestOpenCodeVersion(status.version),
            this.latestStatus?.latestVersion
          )
        : status;
    this.rememberStatusIfCurrent(versionAwareStatus, statusCacheGeneration);
    return versionAwareStatus;
  }

  private async resolveInstalledStatus(): Promise<OpenCodeRuntimeStatus> {
    const status = await resolveOpenCodeStatusWithOverride(
      process.env,
      probeOpenCodeBinaryVersionCached,
      () => this.resolveDefaultInstalledStatus()
    );
    return {
      ...status,
      compatibleV2Version: getLatestQualifiedOpenCodeV2Version(process.platform, process.arch),
    };
  }

  private async resolveDefaultInstalledStatus(): Promise<OpenCodeRuntimeStatus> {
    const appManagedStatus = await this.getAppManagedStatus();
    if (appManagedStatus.installed) return appManagedStatus;

    const pathStatus = await this.getPathStatus();
    return pathStatus.installed ||
      appManagedStatus.source !== 'app-managed' ||
      appManagedStatus.state !== 'failed'
      ? pathStatus
      : appManagedStatus;
  }

  async install(options?: OpenCodeRuntimeInstallOptions): Promise<OpenCodeRuntimeStatus> {
    const validated = parseOpenCodeInstallOptions(options);
    if (this.installPromise) {
      if (validated.generation !== this.installGeneration)
        throw new Error('A different OpenCode generation is already being installed');
      return this.installPromise;
    }
    this.installGeneration = validated.generation;
    this.installPromise = this.installInternal(validated).finally(() => {
      this.installPromise = null;
      this.installGeneration = undefined;
    });
    return this.installPromise;
  }

  private publish(status: OpenCodeRuntimeStatus): void {
    this.statusCacheGeneration += 1;
    this.rememberStatus(status);
    safeSendToRenderer(this.mainWindow, CHANNEL, status);
  }

  private rememberStatusIfCurrent(
    status: OpenCodeRuntimeStatus,
    statusCacheGeneration: number
  ): void {
    if (statusCacheGeneration === this.statusCacheGeneration) {
      this.rememberStatus(status);
    }
  }

  private rememberStatus(status: OpenCodeRuntimeStatus): void {
    this.latestStatus = status;
    this.latestStatusAt = Date.now();
  }

  private getStatusCacheTtlMs(): number {
    return this.latestStatus?.installed === true
      ? RUNTIME_STATUS_SUCCESS_CACHE_TTL_MS
      : RUNTIME_STATUS_FAILURE_CACHE_TTL_MS;
  }

  private publishProgress(progress: OpenCodeRuntimeInstallProgress): void {
    const currentStatus = this.latestStatus;
    this.publish({
      compatibleV2Version: getLatestQualifiedOpenCodeV2Version(process.platform, process.arch),
      installed: currentStatus?.installed ?? false,
      ...(currentStatus?.binaryPath ? { binaryPath: currentStatus.binaryPath } : {}),
      ...(currentStatus?.version ? { version: currentStatus.version } : {}),
      ...(currentStatus?.latestVersion ? { latestVersion: currentStatus.latestVersion } : {}),
      ...(currentStatus?.updateAvailable ? { updateAvailable: true } : {}),
      ...(currentStatus?.ignoredOverride ? { ignoredOverride: currentStatus.ignoredOverride } : {}),
      source: currentStatus?.source ?? 'missing',
      state: progress.phase,
      progress,
    });
  }

  private async getAppManagedStatus(): Promise<OpenCodeRuntimeStatus> {
    const manifest = await readCurrentManifest();
    if (!isAbsoluteExistingFile(manifest?.binaryPath)) {
      return { installed: false, source: 'missing', state: 'idle' };
    }
    if (!(await matchesNativePackagePolicy(manifest.platformPackage)))
      return {
        installed: false,
        binaryPath: manifest.binaryPath,
        version: manifest.version,
        source: 'app-managed',
        state: 'failed',
        error: 'OpenCode managed package does not match native CPU/ABI selection',
      };
    const identity = managedFileIdentity(manifest.binaryPath),
      generation = getOpenCodeRuntimeResolverCacheGeneration();
    const version = await probeOpenCodeBinaryVersionCached(manifest.binaryPath);
    if (version.ok && isRecognizedOpenCodeRuntimeVersion(version.version)) {
      if (
        !rememberManagedProjection(
          manifest,
          identity,
          generation,
          readCurrentManifestSync(),
          getOpenCodeRuntimeResolverCacheGeneration()
        )
      )
        return {
          installed: false,
          source: 'app-managed',
          state: 'failed',
          error: 'OpenCode managed selection changed during verification',
        };
      return {
        installed: true,
        binaryPath: manifest.binaryPath,
        version: version.version ?? manifest.version,
        source: 'app-managed',
        state: 'ready',
      };
    }
    return {
      installed: false,
      binaryPath: manifest.binaryPath,
      version: manifest.version,
      source: 'app-managed',
      state: 'failed',
      ...(!version.ok
        ? { diagnostics: { ...version.diagnostics, binarySource: 'app-managed' as const } }
        : {}),
      error: version.ok
        ? getUnsupportedAgentTeamsOpenCodeVersionMessage(version.version)
        : version.error,
    };
  }

  private async getPathStatus(): Promise<OpenCodeRuntimeStatus> {
    const result = await probeFirstWorkingPathOpenCodeBinaryCached();
    if (result.ok) {
      return {
        installed: true,
        binaryPath: result.binaryPath,
        version: result.version ?? undefined,
        source: 'path',
        state: 'ready',
      };
    }
    if (!result.firstFailure) {
      return { installed: false, source: 'missing', state: 'idle' };
    }
    return {
      installed: false,
      binaryPath: result.firstFailure.binaryPath,
      source: 'path',
      state: 'failed',
      error: result.firstFailure.error,
      diagnostics: result.firstFailure.diagnostics,
    };
  }

  private async resolveFreshInstalledStatusBeforeInstall(): Promise<OpenCodeRuntimeStatus | null> {
    const latestStatus = this.latestStatus;
    if (
      latestStatus?.installed &&
      latestStatus.source === 'path' &&
      isAbsoluteExistingFile(latestStatus.binaryPath)
    ) {
      const version = await probeOpenCodeBinaryVersion(latestStatus.binaryPath);
      if (version.ok && isRecognizedOpenCodeRuntimeVersion(version.version)) {
        return {
          installed: true,
          binaryPath: latestStatus.binaryPath,
          version: version.version ?? latestStatus.version,
          source: 'path',
          state: 'ready',
        };
      }
    }

    const manifest = await readCurrentManifest();
    if (!isAbsoluteExistingFile(manifest?.binaryPath)) {
      return null;
    }
    if (!(await matchesNativePackagePolicy(manifest.platformPackage))) return null;
    const version = await probeOpenCodeBinaryVersion(manifest.binaryPath);
    if (!version.ok || !isRecognizedOpenCodeRuntimeVersion(version.version)) {
      return null;
    }
    return {
      installed: true,
      binaryPath: manifest.binaryPath,
      version: version.version ?? manifest.version,
      source: 'app-managed',
      state: 'ready',
    };
  }

  private async installInternal(
    options: OpenCodeRuntimeInstallOptions
  ): Promise<OpenCodeRuntimeStatus> {
    // With an override, install statuses (before, on failure and after success) keep naming
    // what launch uses, not the managed runtime.
    const previousStatus = readOpenCodeBinaryOverride(process.env)
      ? await this.resolveInstalledStatus()
      : preserveKnownOpenCodeUpdate(
          await this.resolveFreshInstalledStatusBeforeInstall(),
          this.latestStatus?.latestVersion
        );
    if (previousStatus) {
      this.rememberStatus(previousStatus);
    }
    try {
      this.publishProgress({ phase: 'checking', detail: 'Resolving latest OpenCode package...' });
      const compatibleV2Version = getLatestQualifiedOpenCodeV2Version(
        process.platform,
        process.arch
      );
      const generation = chooseOpenCodeInstallGeneration(
        options.generation,
        previousStatus?.version,
        compatibleV2Version
      );
      const selected = await selectOpenCodeInstallPackage(
        generation,
        compatibleV2Version,
        await getOpenCodeRuntimePlatformCandidates(),
        fetchOpenCodePackageMetadata
      );
      const platformMetadata = selected.metadata;

      this.publishProgress({
        phase: 'downloading',
        detail: `Downloading ${selected.packageName}@${platformMetadata.version}...`,
      });
      const tarball = await downloadTarball(platformMetadata.dist!.tarball!, (progress) => {
        this.publishProgress(progress);
      });
      verifyOpenCodeRuntimePackageIntegrity(tarball, platformMetadata.dist!.integrity!);

      this.publishProgress({ phase: 'installing', detail: 'Extracting OpenCode binary...' });
      const extracted = extractOpenCodePackage(
        tarball,
        getExecutableName(),
        generation === 'v2'
          ? { packageName: selected.packageName, version: platformMetadata.version! }
          : undefined
      );
      const binary = extracted.binary;
      const runtimeRoot = getRuntimeRootPath();
      const tempDir = path.join(runtimeRoot, `installing-${process.pid}-${randomUUID()}`);
      const versionDir = path.join(
        runtimeRoot,
        'versions',
        platformMetadata.version!,
        selected.packageName,
        ...(generation === 'v2' ? [randomUUID()] : [])
      );
      const relativeBinaryPath =
        generation === 'v2' ? path.join('bin', getExecutableName()) : getExecutableName();
      const binaryPath = path.join(versionDir, relativeBinaryPath);

      let stdout = '';
      try {
        await fsp.rm(tempDir, { recursive: true, force: true });
        await fsp.mkdir(tempDir, { recursive: true });
        const tempBinaryPath = path.join(tempDir, relativeBinaryPath);
        await fsp.mkdir(path.dirname(tempBinaryPath), { recursive: true });
        if (extracted.packageJson)
          await fsp.writeFile(path.join(tempDir, 'package.json'), extracted.packageJson);
        await fsp.writeFile(tempBinaryPath, binary);
        if (process.platform !== 'win32') {
          // Required so the downloaded OpenCode platform binary can be spawned.
          // eslint-disable-next-line sonarjs/file-permissions -- app-managed CLI binary must be executable
          await fsp.chmod(tempBinaryPath, 0o755);
        }

        this.publishProgress({ phase: 'installing', detail: 'Verifying OpenCode binary...' });
        ({ stdout } = await execCli(tempBinaryPath, ['--version'], {
          timeout: VERSION_TIMEOUT_MS,
          windowsHide: true,
        }));

        const verified = classifyNativeVersion(stdout.trim());
        if (
          verified.kind !== 'recognized' ||
          verified.generation !== generation ||
          verified.version !== platformMetadata.version
        )
          throw new Error('Downloaded OpenCode binary version does not match its package');

        const currentManifest = await readCurrentManifest();
        const canReuseExistingRuntime =
          currentManifest?.platformPackage === selected.packageName &&
          currentManifest.integrity === platformMetadata.dist!.integrity &&
          normalizeBinaryCandidateForCompare(currentManifest.binaryPath) ===
            normalizeBinaryCandidateForCompare(binaryPath) &&
          isAbsoluteExistingFile(binaryPath) &&
          (await probeOpenCodeBinaryVersion(binaryPath)).ok;
        if (!canReuseExistingRuntime) {
          await fsp.rm(versionDir, { recursive: true, force: true });
          await fsp.mkdir(path.dirname(versionDir), { recursive: true });
          await renamePathWithRetry(tempDir, versionDir);
        }
      } finally {
        await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => {});
      }
      const manifest: OpenCodeRuntimeManifest = {
        schemaVersion: CURRENT_MANIFEST_SCHEMA_VERSION,
        version: platformMetadata.version,
        platformPackage: selected.packageName,
        binaryPath,
        integrity: platformMetadata.dist!.integrity!,
        installedAt: new Date().toISOString(),
      };
      await atomicWriteAsync(getCurrentManifestPath(), `${JSON.stringify(manifest, null, 2)}\n`);
      clearOpenCodeRuntimeResolverCache();

      const detail = readOpenCodeBinaryOverride(process.env)
        ? `Installed OpenCode ${manifest.version}. The explicit OpenCode binary override still selects the current runtime; remove it to use the app-managed installation.`
        : `Installed OpenCode ${manifest.version}`;
      const progress: OpenCodeRuntimeInstallProgress = { phase: 'ready', percent: 100, detail };
      const status: OpenCodeRuntimeStatus = readOpenCodeBinaryOverride(process.env)
        ? { ...(await this.resolveInstalledStatus()), progress }
        : {
            installed: true,
            binaryPath,
            version: manifest.version,
            latestVersion: manifest.version,
            updateAvailable: false,
            source: 'app-managed',
            state: 'ready',
            progress,
          };
      status.compatibleV2Version = compatibleV2Version;
      this.publish(status);
      return status;
    } catch (error) {
      const status: OpenCodeRuntimeStatus = {
        compatibleV2Version: getLatestQualifiedOpenCodeV2Version(process.platform, process.arch),
        ...(previousStatus ?? {
          installed: false,
          source: 'missing' as const,
        }),
        state: 'failed',
        error: getErrorMessage(error),
        progress: {
          phase: 'failed',
          detail: getErrorMessage(error),
        },
      };
      logger.error('Failed to install OpenCode runtime:', status.error);
      this.publish(status);
      return status;
    }
  }
}
