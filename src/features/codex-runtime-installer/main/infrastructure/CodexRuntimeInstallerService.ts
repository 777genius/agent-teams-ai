import { CODEX_RUNTIME_PROGRESS } from '@features/codex-runtime-installer/contracts';
import { renamePathWithRetry } from '@main/utils/atomicWrite';
import { execCli } from '@main/utils/childProcess';
import { getAppDataPath } from '@main/utils/pathDecoder';
import {
  findFirstRuntimePathBinaryCandidate,
  isAbsoluteExistingFile,
  RUNTIME_PATH_SHELL_ENV_TIMEOUT_MS,
} from '@main/utils/runtimePathBinaryResolver';
import { safeSendToRenderer } from '@main/utils/safeWebContentsSend';
import { resolveInteractiveShellEnvBestEffort } from '@main/utils/shellEnv';
import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';
import { isVersionOlder, normalizeVersion } from '@shared/utils/version';
import { createHash, randomUUID } from 'crypto';
import { promises as fsp, readFileSync } from 'fs';
import path from 'path';
import { gunzipSync } from 'zlib';

import type { CodexRuntimeInstallerPort } from '../../core/application/ports/CodexRuntimeInstallerPort';
import type {
  CodexRuntimeInstallProgress,
  CodexRuntimeStatus,
} from '@features/codex-runtime-installer/contracts';
import type { BrowserWindow } from 'electron';

const logger = createLogger('CodexRuntimeInstallerService');

const CHANNEL = CODEX_RUNTIME_PROGRESS;
const ROOT_PACKAGE_NAME = '@openai/codex';
const NPM_REGISTRY_BASE_URL = 'https://registry.npmjs.org';
const CURRENT_MANIFEST_SCHEMA_VERSION = 1;
const MAX_TARBALL_BYTES = 160 * 1024 * 1024;
const MAX_UNPACKED_BYTES = 650 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const LATEST_VERSION_TIMEOUT_MS = 8_000;
const VERSION_TIMEOUT_MS = 10_000;

interface NpmPackageMetadata {
  name?: string;
  version?: string;
  dist?: {
    tarball?: string;
    integrity?: string;
  };
  optionalDependencies?: Record<string, string>;
}

interface CodexRuntimeManifest {
  schemaVersion: 1;
  rootVersion: string;
  platformVersion: string;
  platformTarget: string;
  binaryPath: string;
  integrity: string;
  installedAt: string;
}

export interface CodexRuntimePlatformCandidate {
  optionalDependencyName: string;
  platformTag: string;
  vendorTarget: string;
  reason: string;
}

interface CodexRuntimePackageFile {
  relativePath: string;
  data: Buffer;
  mode: number;
}

function getRuntimeRootPath(): string {
  return path.join(getAppDataPath(), 'runtimes', 'codex');
}

function getCurrentManifestPath(): string {
  return path.join(getRuntimeRootPath(), 'current.json');
}

function parseManifest(value: unknown): CodexRuntimeManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return null;
  }
  const manifest = value as Partial<CodexRuntimeManifest>;
  if (
    manifest.schemaVersion !== CURRENT_MANIFEST_SCHEMA_VERSION ||
    typeof manifest.rootVersion !== 'string' ||
    typeof manifest.platformVersion !== 'string' ||
    typeof manifest.platformTarget !== 'string' ||
    typeof manifest.binaryPath !== 'string' ||
    typeof manifest.integrity !== 'string' ||
    typeof manifest.installedAt !== 'string'
  ) {
    return null;
  }
  return manifest as CodexRuntimeManifest;
}

function readCurrentManifestSync(): CodexRuntimeManifest | null {
  try {
    const raw = readFileSync(getCurrentManifestPath(), 'utf8');
    return parseManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

export function resolveAppManagedCodexRuntimeBinaryPath(): string | null {
  const manifest = readCurrentManifestSync();
  return isAbsoluteExistingFile(manifest?.binaryPath) ? manifest.binaryPath : null;
}

export async function resolveVerifiedAppManagedCodexRuntimeBinaryPath(): Promise<string | null> {
  const binaryPath = resolveAppManagedCodexRuntimeBinaryPath();
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
  return process.platform === 'win32' ? 'codex.exe' : 'codex';
}

function getPathExecutableNames(): string[] {
  return process.platform === 'win32'
    ? ['codex.exe', 'codex.cmd', 'codex.bat', 'codex']
    : ['codex'];
}

function resolvePathCodexBinary(
  additionalEnvSources: (NodeJS.ProcessEnv | null | undefined)[] = []
): string | null {
  return findFirstRuntimePathBinaryCandidate({
    executableNames: getPathExecutableNames(),
    additionalEnvSources,
  });
}

async function resolvePathCodexBinaryWithBestEffortEnv(
  options: { shellEnvTimeoutMs?: number } = {}
): Promise<string | null> {
  const cachedCandidate = resolvePathCodexBinary();
  if (cachedCandidate) {
    return cachedCandidate;
  }

  const shellEnv = await resolveInteractiveShellEnvBestEffort({
    timeoutMs: options.shellEnvTimeoutMs ?? RUNTIME_PATH_SHELL_ENV_TIMEOUT_MS,
    fallbackEnv: process.env,
    background: false,
  });
  return resolvePathCodexBinary([shellEnv]);
}

export function getCodexRuntimePlatformCandidates(
  platform: NodeJS.Platform = process.platform,
  arch: string = process.arch
): CodexRuntimePlatformCandidate[] {
  if (platform === 'darwin') {
    if (arch === 'arm64') {
      return [
        {
          optionalDependencyName: '@openai/codex-darwin-arm64',
          platformTag: 'darwin-arm64',
          vendorTarget: 'aarch64-apple-darwin',
          reason: 'macOS arm64',
        },
      ];
    }
    if (arch === 'x64') {
      return [
        {
          optionalDependencyName: '@openai/codex-darwin-x64',
          platformTag: 'darwin-x64',
          vendorTarget: 'x86_64-apple-darwin',
          reason: 'macOS x64',
        },
      ];
    }
  }
  if (platform === 'linux') {
    if (arch === 'arm64') {
      return [
        {
          optionalDependencyName: '@openai/codex-linux-arm64',
          platformTag: 'linux-arm64',
          vendorTarget: 'aarch64-unknown-linux-musl',
          reason: 'Linux arm64',
        },
      ];
    }
    if (arch === 'x64') {
      return [
        {
          optionalDependencyName: '@openai/codex-linux-x64',
          platformTag: 'linux-x64',
          vendorTarget: 'x86_64-unknown-linux-musl',
          reason: 'Linux x64',
        },
      ];
    }
  }
  if (platform === 'win32') {
    if (arch === 'arm64') {
      return [
        {
          optionalDependencyName: '@openai/codex-win32-arm64',
          platformTag: 'win32-arm64',
          vendorTarget: 'aarch64-pc-windows-msvc',
          reason: 'Windows arm64',
        },
      ];
    }
    if (arch === 'x64') {
      return [
        {
          optionalDependencyName: '@openai/codex-win32-x64',
          platformTag: 'win32-x64',
          vendorTarget: 'x86_64-pc-windows-msvc',
          reason: 'Windows x64',
        },
      ];
    }
  }
  throw new Error(`Codex app install is not supported on ${platform}/${arch}`);
}

async function fetchText(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<string> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
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
  version = 'latest',
  timeoutMs = FETCH_TIMEOUT_MS
): Promise<NpmPackageMetadata> {
  const url = `${NPM_REGISTRY_BASE_URL}/${encodeURIComponent(packageName)}/${encodeURIComponent(version)}`;
  const raw = await fetchText(url, timeoutMs);
  const parsed = JSON.parse(raw) as NpmPackageMetadata;
  if (!parsed.version || !parsed.dist?.tarball || !parsed.dist.integrity) {
    throw new Error(`Invalid npm metadata for ${packageName}@${version}`);
  }
  return parsed;
}

async function resolveLatestCodexVersion(): Promise<string | null> {
  const metadata = await fetchPackageMetadata(
    ROOT_PACKAGE_NAME,
    'latest',
    LATEST_VERSION_TIMEOUT_MS
  );
  return metadata.version ? normalizeVersion(metadata.version) : null;
}

export interface CodexRuntimeInstallerServiceDependencies {
  resolveLatestVersion?: () => Promise<string | null>;
}

export function verifyCodexRuntimePackageIntegrity(buffer: Buffer, integrity: string): void {
  const match = /^sha512-([A-Za-z0-9+/=]+)$/.exec(integrity.trim());
  if (!match) {
    throw new Error('Codex package integrity is missing sha512 metadata');
  }
  const actual = createHash('sha512').update(buffer).digest('base64');
  if (actual !== match[1]) {
    throw new Error('Codex package integrity check failed');
  }
}

async function downloadTarball(
  url: string,
  onProgress: (progress: CodexRuntimeInstallProgress) => void
): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok || !response.body) {
      throw new Error(`Failed to download Codex package: HTTP ${response.status}`);
    }
    const totalHeader = response.headers.get('content-length');
    const totalBytes = totalHeader ? Number.parseInt(totalHeader, 10) : undefined;
    if (totalBytes && totalBytes > MAX_TARBALL_BYTES) {
      throw new Error('Codex package is unexpectedly large');
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
        throw new Error('Codex package exceeded the maximum allowed download size');
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
          ? `Downloading Codex ${Math.round((downloadedBytes / totalBytes) * 100)}%`
          : 'Downloading Codex...',
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

function readTarOctal(buffer: Buffer, offset: number, length: number, label: string): number {
  const raw = readTarString(buffer, offset, length).replace(/\0/g, '').trim();
  const value = Number.parseInt(raw || '0', 8);
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`Invalid Codex package tar entry ${label}`);
  }
  return value;
}

function assertSafeTarPath(name: string): void {
  if (
    !name ||
    name.startsWith('/') ||
    name.startsWith('\\') ||
    name.includes('..') ||
    name.includes('\\')
  ) {
    throw new Error(`Unsafe Codex package tar entry: ${name}`);
  }
}

export function extractCodexRuntimePackageFilesFromTarball(
  tarball: Buffer,
  vendorTarget: string,
  executableName = getExecutableName()
): CodexRuntimePackageFile[] {
  const tar = gunzipSync(tarball, { maxOutputLength: MAX_UNPACKED_BYTES });
  const targetPrefix = `package/vendor/${vendorTarget}/`;
  const targetBinaryNames = new Set(
    getCodexRuntimeBinaryRelativePathCandidates(executableName).map(
      (relativePath) => `${targetPrefix}${relativePath}`
    )
  );
  const files: CodexRuntimePackageFile[] = [];
  let foundBinary = false;
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
    const mode = readTarOctal(tar, offset + 100, 8, 'mode');
    const size = readTarOctal(tar, offset + 124, 12, 'size');
    const dataStart = offset + 512;
    const dataEnd = dataStart + size;
    if (dataEnd > tar.length) {
      throw new Error('Codex package tar entry exceeds archive bounds');
    }

    if ((typeFlag === '0' || typeFlag === '') && fullName.startsWith(targetPrefix)) {
      const relativePath = fullName.slice(targetPrefix.length);
      assertSafeTarPath(relativePath);
      if (relativePath.length > 0) {
        files.push({
          relativePath,
          data: Buffer.from(tar.subarray(dataStart, dataEnd)),
          mode,
        });
        foundBinary = foundBinary || targetBinaryNames.has(fullName);
      }
    } else if (
      fullName.startsWith(targetPrefix) &&
      typeFlag !== '5' &&
      typeFlag !== '0' &&
      typeFlag !== ''
    ) {
      throw new Error(`Unsupported Codex package tar entry type: ${typeFlag || 'unknown'}`);
    }

    offset = dataStart + Math.ceil(size / 512) * 512;
  }

  if (!foundBinary) {
    throw new Error(
      `Codex package did not contain one of ${Array.from(targetBinaryNames).join(', ')}`
    );
  }
  return files;
}

function getCodexRuntimeBinaryRelativePathCandidates(executableName: string): string[] {
  return [`bin/${executableName}`, `codex/${executableName}`];
}

function resolveCodexRuntimeBinaryRelativePath(
  files: readonly CodexRuntimePackageFile[],
  executableName = getExecutableName()
): string {
  const filePaths = new Set(files.map((file) => file.relativePath));
  const binaryPath = getCodexRuntimeBinaryRelativePathCandidates(executableName).find((candidate) =>
    filePaths.has(candidate)
  );
  if (!binaryPath) {
    throw new Error(`Extracted Codex package is missing ${executableName}`);
  }
  return binaryPath;
}

async function readCurrentManifest(): Promise<CodexRuntimeManifest | null> {
  try {
    const raw = await fsp.readFile(getCurrentManifestPath(), 'utf8');
    return parseManifest(JSON.parse(raw));
  } catch {
    return null;
  }
}

function parsePlatformVersion(value: string | undefined, fallback: string): string {
  const normalized = value?.trim();
  if (!normalized) {
    return fallback;
  }
  const aliasMatch = /^npm:@openai\/codex@(.+)$/.exec(normalized);
  if (aliasMatch?.[1]) {
    return aliasMatch[1];
  }
  return normalized.replace(/^[~^]/, '');
}

async function writePackageFiles(
  rootDir: string,
  files: readonly CodexRuntimePackageFile[]
): Promise<void> {
  const normalizedRoot = path.resolve(rootDir);
  for (const file of files) {
    const targetPath = path.resolve(normalizedRoot, file.relativePath);
    if (targetPath !== normalizedRoot && !targetPath.startsWith(`${normalizedRoot}${path.sep}`)) {
      throw new Error(`Unsafe Codex package output path: ${file.relativePath}`);
    }
    await fsp.mkdir(path.dirname(targetPath), { recursive: true });
    await fsp.writeFile(targetPath, file.data);
    if (process.platform !== 'win32' && (file.mode & 0o111) !== 0) {
      // Preserve executable bits for codex, rg, and bundled sandbox helpers.
      await fsp.chmod(targetPath, file.mode & 0o777);
    }
  }
}

export class CodexRuntimeInstallerService implements CodexRuntimeInstallerPort {
  private mainWindow: BrowserWindow | null = null;
  private installPromise: Promise<CodexRuntimeStatus> | null = null;
  private latestStatus: CodexRuntimeStatus | null = null;

  constructor(private readonly dependencies: CodexRuntimeInstallerServiceDependencies = {}) {}

  setMainWindow(win: BrowserWindow | null): void {
    this.mainWindow = win;
  }

  invalidateStatusCache(): void {
    this.latestStatus = null;
  }

  async getStatus(): Promise<CodexRuntimeStatus> {
    if (this.installPromise && this.latestStatus) {
      return this.latestStatus;
    }

    const appManagedStatus = await this.getAppManagedStatus();
    if (appManagedStatus.installed) {
      const status = await this.withLatestVersion(appManagedStatus);
      this.latestStatus = status;
      return status;
    }

    const pathStatus = await this.getPathStatus();
    const status =
      pathStatus.installed ||
      appManagedStatus.source !== 'app-managed' ||
      appManagedStatus.state !== 'failed'
        ? pathStatus
        : appManagedStatus;
    const versionAwareStatus = await this.withLatestVersion(status);
    this.latestStatus = versionAwareStatus;
    return versionAwareStatus;
  }

  async install(): Promise<CodexRuntimeStatus> {
    if (this.installPromise) {
      return this.installPromise;
    }
    this.installPromise = this.installInternal().finally(() => {
      this.installPromise = null;
    });
    return this.installPromise;
  }

  private publish(status: CodexRuntimeStatus): void {
    this.latestStatus = status;
    safeSendToRenderer(this.mainWindow, CHANNEL, status);
  }

  private publishProgress(progress: CodexRuntimeInstallProgress): void {
    const currentStatus = this.latestStatus;
    this.publish({
      installed: currentStatus?.installed ?? false,
      ...(currentStatus?.binaryPath ? { binaryPath: currentStatus.binaryPath } : {}),
      ...(currentStatus?.version ? { version: currentStatus.version } : {}),
      latestVersion: currentStatus?.latestVersion ?? null,
      updateAvailable: currentStatus?.updateAvailable ?? false,
      source: currentStatus?.source ?? 'missing',
      state: progress.phase,
      progress,
    });
  }

  private async withLatestVersion(status: CodexRuntimeStatus): Promise<CodexRuntimeStatus> {
    try {
      const latestVersion = await (
        this.dependencies.resolveLatestVersion ?? resolveLatestCodexVersion
      )();
      return {
        ...status,
        latestVersion,
        updateAvailable: Boolean(
          status.installed &&
          status.version &&
          latestVersion &&
          isVersionOlder(status.version, latestVersion)
        ),
      };
    } catch (error) {
      logger.warn('Failed to resolve latest Codex version:', getErrorMessage(error));
      return {
        ...status,
        latestVersion: null,
        updateAvailable: false,
      };
    }
  }

  private async getAppManagedStatus(): Promise<CodexRuntimeStatus> {
    const manifest = await readCurrentManifest();
    if (!isAbsoluteExistingFile(manifest?.binaryPath)) {
      return {
        installed: false,
        latestVersion: null,
        updateAvailable: false,
        source: 'missing',
        state: 'idle',
      };
    }
    try {
      const { stdout } = await execCli(manifest.binaryPath, ['--version'], {
        timeout: VERSION_TIMEOUT_MS,
        windowsHide: true,
      });
      return {
        installed: true,
        binaryPath: manifest.binaryPath,
        version: stdout.trim() || manifest.platformVersion,
        latestVersion: null,
        updateAvailable: false,
        source: 'app-managed',
        state: 'ready',
      };
    } catch (error) {
      return {
        installed: false,
        binaryPath: manifest.binaryPath,
        version: manifest.platformVersion,
        latestVersion: null,
        updateAvailable: false,
        source: 'app-managed',
        state: 'failed',
        error: getErrorMessage(error),
      };
    }
  }

  private async getPathStatus(): Promise<CodexRuntimeStatus> {
    const binaryPath = await resolvePathCodexBinaryWithBestEffortEnv();
    if (!binaryPath) {
      return {
        installed: false,
        latestVersion: null,
        updateAvailable: false,
        source: 'missing',
        state: 'idle',
      };
    }
    try {
      const { stdout } = await execCli(binaryPath, ['--version'], {
        timeout: VERSION_TIMEOUT_MS,
        windowsHide: true,
      });
      return {
        installed: true,
        binaryPath,
        version: stdout.trim() || undefined,
        latestVersion: null,
        updateAvailable: false,
        source: 'path',
        state: 'ready',
      };
    } catch (error) {
      return {
        installed: false,
        binaryPath,
        latestVersion: null,
        updateAvailable: false,
        source: 'path',
        state: 'failed',
        error: getErrorMessage(error),
      };
    }
  }

  private async installInternal(): Promise<CodexRuntimeStatus> {
    let tempDir: string | null = null;
    const previousStatus = this.latestStatus?.installed ? this.latestStatus : null;
    try {
      this.publishProgress({ phase: 'checking', detail: 'Resolving latest Codex package...' });
      const rootMetadata = await fetchPackageMetadata(ROOT_PACKAGE_NAME);
      const candidates = getCodexRuntimePlatformCandidates();
      const optionalDependencies = rootMetadata.optionalDependencies ?? {};
      const selected =
        candidates.find((candidate) => optionalDependencies[candidate.optionalDependencyName]) ??
        candidates[0];
      if (!selected) {
        throw new Error(
          `No Codex binary package is available for ${process.platform}/${process.arch}`
        );
      }
      const fallbackPlatformVersion = `${rootMetadata.version!}-${selected.platformTag}`;
      const platformVersion = parsePlatformVersion(
        optionalDependencies[selected.optionalDependencyName],
        fallbackPlatformVersion
      );
      const platformMetadata = await fetchPackageMetadata(ROOT_PACKAGE_NAME, platformVersion);

      this.publishProgress({
        phase: 'downloading',
        detail: `Downloading Codex ${platformMetadata.version}...`,
      });
      const tarball = await downloadTarball(platformMetadata.dist!.tarball!, (progress) => {
        this.publishProgress(progress);
      });
      verifyCodexRuntimePackageIntegrity(tarball, platformMetadata.dist!.integrity!);

      this.publishProgress({ phase: 'installing', detail: 'Extracting Codex runtime...' });
      const files = extractCodexRuntimePackageFilesFromTarball(tarball, selected.vendorTarget);
      const binaryRelativePath = resolveCodexRuntimeBinaryRelativePath(files);
      const runtimeRoot = getRuntimeRootPath();
      tempDir = path.join(runtimeRoot, `installing-${process.pid}-${randomUUID()}`);
      const versionDir = path.join(
        runtimeRoot,
        'versions',
        platformMetadata.version!,
        selected.vendorTarget
      );
      const binaryPath = path.join(versionDir, binaryRelativePath);

      await fsp.rm(tempDir, { recursive: true, force: true });
      await fsp.mkdir(tempDir, { recursive: true });
      await writePackageFiles(tempDir, files);

      this.publishProgress({ phase: 'installing', detail: 'Verifying Codex binary...' });
      const tempBinaryPath = path.join(tempDir, binaryRelativePath);
      const { stdout } = await execCli(tempBinaryPath, ['--version'], {
        timeout: VERSION_TIMEOUT_MS,
        windowsHide: true,
      });

      await fsp.rm(versionDir, { recursive: true, force: true });
      await fsp.mkdir(path.dirname(versionDir), { recursive: true });
      await renamePathWithRetry(tempDir, versionDir);
      tempDir = null;
      const manifest: CodexRuntimeManifest = {
        schemaVersion: CURRENT_MANIFEST_SCHEMA_VERSION,
        rootVersion: rootMetadata.version!,
        platformVersion: platformMetadata.version!,
        platformTarget: selected.vendorTarget,
        binaryPath,
        integrity: platformMetadata.dist!.integrity!,
        installedAt: new Date().toISOString(),
      };
      await fsp.writeFile(
        getCurrentManifestPath(),
        `${JSON.stringify(manifest, null, 2)}\n`,
        'utf8'
      );

      const status: CodexRuntimeStatus = {
        installed: true,
        binaryPath,
        version: stdout.trim() || manifest.platformVersion,
        latestVersion: normalizeVersion(rootMetadata.version!),
        updateAvailable: false,
        source: 'app-managed',
        state: 'ready',
        progress: {
          phase: 'ready',
          percent: 100,
          detail: `Installed Codex ${stdout.trim() || manifest.platformVersion}`,
        },
      };
      this.publish(status);
      return status;
    } catch (error) {
      if (tempDir) {
        await fsp.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      }
      const status: CodexRuntimeStatus = {
        ...(previousStatus ?? {
          installed: false,
          latestVersion: null,
          updateAvailable: false,
          source: 'missing' as const,
        }),
        state: 'failed',
        error: getErrorMessage(error),
        progress: {
          phase: 'failed',
          detail: getErrorMessage(error),
        },
      };
      logger.error('Failed to install Codex runtime:', status.error);
      this.publish(status);
      return status;
    }
  }
}
