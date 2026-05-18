import { execCli } from '@main/utils/childProcess';
import { getAppDataPath } from '@main/utils/pathDecoder';
import { safeSendToRenderer } from '@main/utils/safeWebContentsSend';
import { getCachedShellEnv, resolveInteractiveShellEnvBestEffort } from '@main/utils/shellEnv';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import { createHash, randomUUID } from 'crypto';
import { existsSync, promises as fsp, readFileSync, statSync } from 'fs';
import path from 'path';
import { gunzipSync } from 'zlib';

import type { OpenCodeRuntimeInstallProgress, OpenCodeRuntimeStatus } from '@shared/types';
import type { BrowserWindow } from 'electron';

const logger = createLogger('OpenCodeRuntimeInstallerService');

const CHANNEL = 'openCodeRuntime:progress';
const ROOT_PACKAGE_NAME = 'opencode-ai';
const NPM_REGISTRY_BASE_URL = 'https://registry.npmjs.org';
const CURRENT_MANIFEST_SCHEMA_VERSION = 1;
const MAX_TARBALL_BYTES = 250 * 1024 * 1024;
const MAX_BINARY_BYTES = 350 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 10_000;
const PATH_SHELL_ENV_TIMEOUT_MS = 1_500;

interface NpmPackageMetadata {
  name?: string;
  version?: string;
  dist?: {
    tarball?: string;
    integrity?: string;
  };
  optionalDependencies?: Record<string, string>;
}

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

function isAbsoluteExistingFile(filePath: string | null | undefined): filePath is string {
  if (!filePath || !path.isAbsolute(filePath) || !existsSync(filePath)) {
    return false;
  }
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
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
  try {
    await execCli(binaryPath, ['--version'], {
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
    });
    return binaryPath;
  } catch {
    return null;
  }
}

function getExecutableName(): string {
  return process.platform === 'win32' ? 'opencode.exe' : 'opencode';
}

function getPathExecutableNames(): string[] {
  return process.platform === 'win32'
    ? ['opencode.exe', 'opencode.cmd', 'opencode.bat', 'opencode']
    : ['opencode'];
}

function splitPathEnv(pathValue: string | undefined): string[] {
  if (!pathValue) {
    return [];
  }
  return pathValue
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function resolvePathOpenCodeBinary(
  additionalEnvSources: (NodeJS.ProcessEnv | null | undefined)[] = []
): string | null {
  const shellEnv = getCachedShellEnv() ?? {};
  const pathEntries = [
    ...additionalEnvSources.flatMap((env) => splitPathEnv(env?.PATH)),
    ...splitPathEnv(shellEnv.PATH),
    ...splitPathEnv(process.env.PATH),
  ];
  const seen = new Set<string>();
  for (const entry of pathEntries) {
    const normalizedEntry = path.resolve(entry);
    if (seen.has(normalizedEntry)) {
      continue;
    }
    seen.add(normalizedEntry);
    for (const executableName of getPathExecutableNames()) {
      const candidate = path.join(normalizedEntry, executableName);
      if (isAbsoluteExistingFile(candidate)) {
        return candidate;
      }
    }
  }
  return null;
}

type OpenCodeBinaryVersionProbe =
  | { ok: true; version: string | null }
  | { ok: false; error: string };

async function probeOpenCodeBinaryVersion(binaryPath: string): Promise<OpenCodeBinaryVersionProbe> {
  try {
    const { stdout } = await execCli(binaryPath, ['--version'], {
      timeout: VERSION_TIMEOUT_MS,
      windowsHide: true,
    });
    return { ok: true, version: stdout.trim() || null };
  } catch (error) {
    return { ok: false, error: getErrorMessage(error) };
  }
}

async function resolvePathOpenCodeBinaryWithBestEffortEnv(
  options: { shellEnvTimeoutMs?: number } = {}
): Promise<string | null> {
  const cachedCandidate = resolvePathOpenCodeBinary();
  if (cachedCandidate) {
    return cachedCandidate;
  }

  const shellEnv = await resolveInteractiveShellEnvBestEffort({
    timeoutMs: options.shellEnvTimeoutMs ?? PATH_SHELL_ENV_TIMEOUT_MS,
    fallbackEnv: process.env,
  });
  return resolvePathOpenCodeBinary([shellEnv]);
}

async function resolveVerifiedPathOpenCodeBinaryPath(
  options: { shellEnvTimeoutMs?: number } = {}
): Promise<string | null> {
  const binaryPath = await resolvePathOpenCodeBinaryWithBestEffortEnv(options);
  if (!binaryPath) {
    return null;
  }

  return (await probeOpenCodeBinaryVersion(binaryPath)).ok ? binaryPath : null;
}

export async function resolveVerifiedOpenCodeRuntimeBinaryPath(
  options: { shellEnvTimeoutMs?: number } = {}
): Promise<string | null> {
  return (
    (await resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath()) ??
    (await resolveVerifiedPathOpenCodeBinaryPath(options))
  );
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

async function fetchText(url: string): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} from ${url}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timer);
  }
}

async function fetchPackageMetadata(
  packageName: string,
  version = 'latest'
): Promise<NpmPackageMetadata> {
  const url = `${NPM_REGISTRY_BASE_URL}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
  const raw = await fetchText(url);
  const parsed = JSON.parse(raw) as NpmPackageMetadata;
  if (!parsed.version || !parsed.dist?.tarball || !parsed.dist.integrity) {
    throw new Error(`Invalid npm metadata for ${packageName}@${version}`);
  }
  return parsed;
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

function readTarString(buffer: Buffer, start: number, length: number): string {
  const end = buffer.indexOf(0, start);
  const safeEnd = end >= start && end < start + length ? end : start + length;
  return buffer.toString('utf8', start, safeEnd).trim();
}

function readTarSize(buffer: Buffer, offset: number): number {
  const raw = readTarString(buffer, offset + 124, 12)
    .replace(/\0/g, '')
    .trim();
  const size = Number.parseInt(raw || '0', 8);
  if (!Number.isFinite(size) || size < 0) {
    throw new Error('Invalid OpenCode package tar entry size');
  }
  return size;
}

function assertSafeTarPath(name: string): void {
  if (
    !name ||
    name.startsWith('/') ||
    name.startsWith('\\') ||
    name.includes('..') ||
    name.includes('\\')
  ) {
    throw new Error(`Unsafe OpenCode package tar entry: ${name}`);
  }
}

export function extractOpenCodeRuntimeBinaryFromTarball(tarball: Buffer): Buffer {
  const tar = gunzipSync(tarball, { maxOutputLength: MAX_BINARY_BYTES + 1024 * 1024 });
  const targetName = `package/bin/${getExecutableName()}`;
  let offset = 0;
  while (offset + 512 <= tar.length) {
    const name = readTarString(tar, offset, 100);
    if (!name) {
      break;
    }
    const prefix = readTarString(tar, offset + 345, 155);
    const fullName = prefix ? `${prefix}/${name}` : name;
    assertSafeTarPath(fullName);
    const typeFlag = readTarString(tar, offset + 156, 1);
    const size = readTarSize(tar, offset);
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new Error('OpenCode package tar entry exceeds archive bounds');
    }
    if ((typeFlag === '0' || typeFlag === '') && fullName === targetName) {
      if (size <= 0 || size > MAX_BINARY_BYTES) {
        throw new Error('OpenCode binary size is invalid');
      }
      return tar.subarray(dataStart, dataEnd);
    }
    offset = dataStart + Math.ceil(size / 512) * 512;
  }
  throw new Error(`OpenCode package did not contain ${targetName}`);
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
  private latestStatus: OpenCodeRuntimeStatus | null = null;

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win;
  }

  invalidateStatusCache(): void {
    this.latestStatus = null;
  }

  async getStatus(): Promise<OpenCodeRuntimeStatus> {
    if (this.installPromise && this.latestStatus) {
      return this.latestStatus;
    }

    const appManagedStatus = await this.getAppManagedStatus();
    if (appManagedStatus.installed) {
      this.latestStatus = appManagedStatus;
      return appManagedStatus;
    }

    const pathStatus = await this.getPathStatus();
    const status =
      pathStatus.installed ||
      appManagedStatus.source !== 'app-managed' ||
      appManagedStatus.state !== 'failed'
        ? pathStatus
        : appManagedStatus;
    this.latestStatus = status;
    return status;
  }

  async install(): Promise<OpenCodeRuntimeStatus> {
    if (this.installPromise) {
      return this.installPromise;
    }
    this.installPromise = this.installInternal().finally(() => {
      this.installPromise = null;
    });
    return this.installPromise;
  }

  private publish(status: OpenCodeRuntimeStatus): void {
    this.latestStatus = status;
    safeSendToRenderer(this.mainWindow, CHANNEL, status);
  }

  private publishProgress(progress: OpenCodeRuntimeInstallProgress): void {
    this.publish({
      installed: false,
      source: 'missing',
      state: progress.phase,
      progress,
    });
  }

  private async getAppManagedStatus(): Promise<OpenCodeRuntimeStatus> {
    const manifest = await readCurrentManifest();
    if (!isAbsoluteExistingFile(manifest?.binaryPath)) {
      return { installed: false, source: 'missing', state: 'idle' };
    }
    try {
      const { stdout } = await execCli(manifest.binaryPath, ['--version'], {
        timeout: VERSION_TIMEOUT_MS,
        windowsHide: true,
      });
      return {
        installed: true,
        binaryPath: manifest.binaryPath,
        version: stdout.trim() || manifest.version,
        source: 'app-managed',
        state: 'ready',
      };
    } catch (error) {
      return {
        installed: false,
        binaryPath: manifest.binaryPath,
        version: manifest.version,
        source: 'app-managed',
        state: 'failed',
        error: getErrorMessage(error),
      };
    }
  }

  private async getPathStatus(): Promise<OpenCodeRuntimeStatus> {
    const binaryPath = await resolvePathOpenCodeBinaryWithBestEffortEnv();
    if (!binaryPath) {
      return { installed: false, source: 'missing', state: 'idle' };
    }
    const version = await probeOpenCodeBinaryVersion(binaryPath);
    if (!version.ok) {
      return {
        installed: false,
        binaryPath,
        source: 'path',
        state: 'failed',
        error: version.error,
      };
    }
    return {
      installed: true,
      binaryPath,
      version: version.version ?? undefined,
      source: 'path',
      state: 'ready',
    };
  }

  private async installInternal(): Promise<OpenCodeRuntimeStatus> {
    try {
      this.publishProgress({ phase: 'checking', detail: 'Resolving latest OpenCode package...' });
      const rootMetadata = await fetchPackageMetadata(ROOT_PACKAGE_NAME);
      const candidates = getOpenCodeRuntimePlatformCandidates();
      const optionalDependencies = rootMetadata.optionalDependencies ?? {};
      const selected = candidates.find((candidate) => optionalDependencies[candidate.packageName]);
      if (!selected) {
        throw new Error(
          `No OpenCode binary package is available for ${process.platform}/${process.arch}`
        );
      }
      const platformVersion = optionalDependencies[selected.packageName] ?? rootMetadata.version!;
      const normalizedVersion = platformVersion.replace(/^[~^]/, '');
      const platformMetadata = await fetchPackageMetadata(selected.packageName, normalizedVersion);

      this.publishProgress({
        phase: 'downloading',
        detail: `Downloading ${selected.packageName}@${platformMetadata.version}...`,
      });
      const tarball = await downloadTarball(platformMetadata.dist!.tarball!, (progress) => {
        this.publishProgress(progress);
      });
      verifyOpenCodeRuntimePackageIntegrity(tarball, platformMetadata.dist!.integrity!);

      this.publishProgress({ phase: 'installing', detail: 'Extracting OpenCode binary...' });
      const binary = extractOpenCodeRuntimeBinaryFromTarball(tarball);
      const runtimeRoot = getRuntimeRootPath();
      const tempDir = path.join(runtimeRoot, `installing-${process.pid}-${randomUUID()}`);
      const versionDir = path.join(
        runtimeRoot,
        'versions',
        platformMetadata.version!,
        selected.packageName
      );
      const binaryPath = path.join(versionDir, getExecutableName());

      await fsp.rm(tempDir, { recursive: true, force: true });
      await fsp.mkdir(tempDir, { recursive: true });
      const tempBinaryPath = path.join(tempDir, getExecutableName());
      await fsp.writeFile(tempBinaryPath, binary);
      if (process.platform !== 'win32') {
        // Required so the downloaded OpenCode platform binary can be spawned.
        // eslint-disable-next-line sonarjs/file-permissions -- app-managed CLI binary must be executable
        await fsp.chmod(tempBinaryPath, 0o755);
      }

      this.publishProgress({ phase: 'installing', detail: 'Verifying OpenCode binary...' });
      const { stdout } = await execCli(tempBinaryPath, ['--version'], {
        timeout: VERSION_TIMEOUT_MS,
        windowsHide: true,
      });

      await fsp.rm(versionDir, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(versionDir), { recursive: true });
      await fsp.rename(tempDir, versionDir);
      const manifest: OpenCodeRuntimeManifest = {
        schemaVersion: CURRENT_MANIFEST_SCHEMA_VERSION,
        version: stdout.trim() || platformMetadata.version!,
        platformPackage: selected.packageName,
        binaryPath,
        integrity: platformMetadata.dist!.integrity!,
        installedAt: new Date().toISOString(),
      };
      await fsp.writeFile(
        getCurrentManifestPath(),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8'
      );

      const status: OpenCodeRuntimeStatus = {
        installed: true,
        binaryPath,
        version: manifest.version,
        source: 'app-managed',
        state: 'ready',
        progress: {
          phase: 'ready',
          percent: 100,
          detail: `Installed OpenCode ${manifest.version}`,
        },
      };
      this.publish(status);
      return status;
    } catch (error) {
      const status: OpenCodeRuntimeStatus = {
        installed: false,
        source: 'missing',
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
