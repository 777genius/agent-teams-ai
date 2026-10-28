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
  downloadOpenCodePackage,
  verifyOpenCodeRuntimePackageIntegrity,
  OpenCodeV2SupportInstaller,
  selectOpenCodeInstallPackage,
} from '@features/opencode-runtime-installer/main';
import {
  type OpenCodeBinaryCandidateFailure,
  type OpenCodeBinaryVersionProbe,
  probeOpenCodeBinaryVersion,
} from '@features/runtime-provider-management/main';
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
import { randomUUID } from 'crypto';
import { promises as fsp, readdirSync, readFileSync } from 'fs';
import path from 'path';

import {
  preserveKnownOpenCodeUpdate,
  resolveLatestOpenCodeVersion,
  withLatestOpenCodeVersion,
} from './openCodeRuntimeLatestVersion';
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
  clearOpenCodeRuntimeResolverCache as clearOpenCodeRuntimeBinaryResolverCache,
  resolveCachedVerifiedOpenCodeRuntimeBinaryPath,
} from './openCodeRuntimeResolverCache';
export { verifyOpenCodeRuntimePackageIntegrity } from '@features/opencode-runtime-installer/main';

const logger = createLogger('OpenCodeRuntimeInstallerService');

const CHANNEL = 'openCodeRuntime:progress';
const CURRENT_MANIFEST_SCHEMA_VERSION = 1;
const VERSION_TIMEOUT_MS = 30_000;
const VERSION_PROBE_SUCCESS_CACHE_TTL_MS = 30_000;
const VERSION_PROBE_FAILURE_CACHE_TTL_MS = 5_000;
const RUNTIME_STATUS_SUCCESS_CACHE_TTL_MS = 30_000;
const RUNTIME_STATUS_FAILURE_CACHE_TTL_MS = 5_000;

interface OpenCodeRuntimeManifest {
  schemaVersion: 1;
  version: string;
  platformPackage: string;
  binaryPath: string;
  integrity: string;
  installedAt: string;
}

export interface PlatformCandidate {
  packageName: string;
  reason: string;
}

function getRuntimeRootPath(): string {
  return path.join(getAppDataPath(), 'runtimes', 'opencode');
}

function getCurrentManifestPath(): string {
  return path.join(getRuntimeRootPath(), 'current.json');
}

function parseManifest(value: unknown): OpenCodeRuntimeManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const manifest = value as Partial<OpenCodeRuntimeManifest>;
  if (
    manifest.schemaVersion !== CURRENT_MANIFEST_SCHEMA_VERSION ||
    typeof manifest.version !== 'string' ||
    typeof manifest.platformPackage !== 'string' ||
    typeof manifest.binaryPath !== 'string' ||
    typeof manifest.integrity !== 'string' ||
    typeof manifest.installedAt !== 'string'
  ) {
    return null;
  }
  return manifest as OpenCodeRuntimeManifest;
}

function readCurrentManifestSync(): OpenCodeRuntimeManifest | null {
  try {
    const raw = readFileSync(getCurrentManifestPath(), 'utf8');
    return parseManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function resolveAppManagedOpenCodeRuntimeBinaryPath(): string | null {
  const manifest = readCurrentManifestSync();
  return isAbsoluteExistingFile(manifest?.binaryPath) ? manifest.binaryPath : null;
}

export async function resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath(): Promise<string | null> {
  const binaryPath = resolveAppManagedOpenCodeRuntimeBinaryPath();
  if (!binaryPath) {
    return null;
  }
  const version = await probeOpenCodeBinaryVersionCached(binaryPath);
  return version.ok && isRecognizedOpenCodeRuntimeVersion(version.version) ? binaryPath : null;
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
  const cacheKey = normalizeBinaryCandidateForCompare(binaryPath);
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
    for (const launchBinaryPath of collectWindowsNativeOpenCodeBinaryCandidates(binaryPath)) {
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

function isLinuxMuslRuntime(): boolean {
  if (process.platform !== 'linux') {
    return false;
  }
  const report =
    typeof process.report?.getReport === 'function'
      ? (process.report.getReport() as { header?: { glibcVersionRuntime?: string } })
      : null;
  const header = report?.header;
  return !header?.glibcVersionRuntime;
}

export function getOpenCodeRuntimePlatformCandidates(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch,
  musl: boolean = isLinuxMuslRuntime()
): PlatformCandidate[] {
  if (platform === 'darwin') {
    if (arch === 'arm64') return [{ packageName: 'opencode-darwin-arm64', reason: 'macOS arm64' }];
    if (arch === 'x64') {
      return [
        { packageName: 'opencode-darwin-x64', reason: 'macOS x64' },
        { packageName: 'opencode-darwin-x64-baseline', reason: 'macOS x64 baseline fallback' },
      ];
    }
  }
  if (platform === 'linux') {
    if (arch === 'arm64') {
      return musl
        ? [
            { packageName: 'opencode-linux-arm64-musl', reason: 'Linux arm64 musl' },
            { packageName: 'opencode-linux-arm64', reason: 'Linux arm64 glibc fallback' },
          ]
        : [
            { packageName: 'opencode-linux-arm64', reason: 'Linux arm64 glibc' },
            { packageName: 'opencode-linux-arm64-musl', reason: 'Linux arm64 musl fallback' },
          ];
    }
    if (arch === 'x64') {
      return musl
        ? [
            { packageName: 'opencode-linux-x64-musl', reason: 'Linux x64 musl' },
            {
              packageName: 'opencode-linux-x64-baseline-musl',
              reason: 'Linux x64 musl baseline fallback',
            },
            { packageName: 'opencode-linux-x64', reason: 'Linux x64 glibc fallback' },
          ]
        : [
            { packageName: 'opencode-linux-x64', reason: 'Linux x64 glibc' },
            { packageName: 'opencode-linux-x64-baseline', reason: 'Linux x64 baseline fallback' },
            { packageName: 'opencode-linux-x64-musl', reason: 'Linux x64 musl fallback' },
          ];
    }
  }
  if (platform === 'win32') {
    if (arch === 'arm64')
      return [{ packageName: 'opencode-windows-arm64', reason: 'Windows arm64' }];
    if (arch === 'x64') {
      return [
        { packageName: 'opencode-windows-x64', reason: 'Windows x64' },
        { packageName: 'opencode-windows-x64-baseline', reason: 'Windows x64 baseline fallback' },
      ];
    }
  }
  throw new Error(`OpenCode app install is not supported on ${platform}/${arch}`);
}

export function extractOpenCodeRuntimeBinaryFromTarball(tarball: Buffer): Buffer {
  return extractOpenCodePackage(tarball, getExecutableName()).binary;
}

async function readCurrentManifest(): Promise<OpenCodeRuntimeManifest | null> {
  try {
    const raw = await fsp.readFile(getCurrentManifestPath(), 'utf8');
    return parseManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

export class OpenCodeRuntimeInstallerService {
  private mainWindow: BrowserWindow | null = null;
  private installPromise: Promise<OpenCodeRuntimeStatus> | null = null;
  private installGeneration: string | undefined;
  private latestStatus: OpenCodeRuntimeStatus | null = null;
  private latestStatusAt = 0;
  private statusPromise: Promise<OpenCodeRuntimeStatus> | null = null;
  private statusCacheGeneration = 0;

  constructor(
    private readonly v2Support: Pick<
      OpenCodeV2SupportInstaller,
      'withStatus' | 'install'
    > = new OpenCodeV2SupportInstaller()
  ) {}

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
    return this.v2Support.withStatus({
      ...status,
      compatibleV2Version: getLatestQualifiedOpenCodeV2Version(process.platform, process.arch),
    });
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
    const intent = JSON.stringify(validated);
    if (this.installPromise) {
      if (intent !== this.installGeneration)
        throw new Error('A different OpenCode generation is already being installed');
      return this.installPromise;
    }
    this.installGeneration = intent;
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
      ...(currentStatus?.v2Support ? { v2Support: currentStatus.v2Support } : {}),
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
    const version = await probeOpenCodeBinaryVersionCached(manifest.binaryPath);
    if (version.ok && isRecognizedOpenCodeRuntimeVersion(version.version)) {
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

  private async installInternal(
    options: OpenCodeRuntimeInstallOptions
  ): Promise<OpenCodeRuntimeStatus> {
    // Cold PATH discovery and overrides use the same selected native identity as launch.
    clearOpenCodeRuntimeResolverCache();
    const selectedBeforeInstall = await this.resolveInstalledStatus();
    const previousStatus =
      preserveKnownOpenCodeUpdate(selectedBeforeInstall, this.latestStatus?.latestVersion) ??
      selectedBeforeInstall;
    const previousManifest = JSON.stringify(await readCurrentManifest());
    const previousOverride = JSON.stringify(readOpenCodeBinaryOverride(process.env));
    this.rememberStatus(previousStatus);
    try {
      if (
        options.supportOnly ||
        (options.generation !== 'v1' &&
          previousStatus.installed &&
          previousStatus.v2Support === 'required')
      ) {
        if (!previousStatus.installed || !previousStatus.version?.startsWith('2.'))
          throw new Error('OpenCode V2 support requires a verified selected native V2 CLI');
        await this.v2Support.install(previousStatus.version, (progress) =>
          this.publishProgress(progress)
        );
        const status = await this.resolveInstalledStatus();
        this.publish(status);
        return status;
      }
      if (previousStatus.source === 'override' && !previousStatus.installed)
        throw new Error(
          previousStatus.error ?? 'The explicit OpenCode selection could not be verified'
        );
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
        getOpenCodeRuntimePlatformCandidates(),
        fetchOpenCodePackageMetadata
      );
      const platformMetadata = selected.metadata;

      this.publishProgress({
        phase: 'downloading',
        detail: `Downloading ${selected.packageName}@${platformMetadata.version}...`,
      });
      const tarball = await downloadOpenCodePackage(platformMetadata.dist!.tarball!, (progress) => {
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
      if (generation === 'v2')
        await this.v2Support.install(manifest.version, (progress) =>
          this.publishProgress(progress)
        );
      const beforeCommit =
        generation === 'v2'
          ? async (): Promise<void> => {
              clearOpenCodeRuntimeResolverCache();
              const selected = await this.resolveInstalledStatus();
              if (
                JSON.stringify(await readCurrentManifest()) !== previousManifest ||
                JSON.stringify(readOpenCodeBinaryOverride(process.env)) !== previousOverride ||
                selected.installed !== previousStatus.installed ||
                selected.binaryPath !== previousStatus.binaryPath ||
                selected.version !== previousStatus.version
              )
                throw new Error(
                  'OpenCode selection changed during installation; keeping the selected native runtime'
                );
            }
          : undefined;
      try {
        await atomicWriteAsync(getCurrentManifestPath(), `${JSON.stringify(manifest, null, 2)}\n`, {
          beforeCommit,
        });
      } catch (error) {
        // A post-rename sync failure may already have committed this exact selection.
        if (JSON.stringify(await readCurrentManifest()) !== JSON.stringify(manifest)) throw error;
      }
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
      const completed = await this.v2Support.withStatus(status);
      this.publish(completed);
      return completed;
    } catch (error) {
      const observedStatus = await this.resolveInstalledStatus().catch(() => previousStatus);
      const status: OpenCodeRuntimeStatus = {
        compatibleV2Version: getLatestQualifiedOpenCodeV2Version(process.platform, process.arch),
        ...(preserveKnownOpenCodeUpdate(observedStatus, previousStatus.latestVersion) ??
          observedStatus),
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
