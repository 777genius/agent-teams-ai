import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';

import {
  hostedOpenCodeRuntimePlatformKey,
  type HostedOpenCodeRuntimeAvailableArtifact,
  type HostedOpenCodeRuntimeLockV2,
  type HostedOpenCodeRuntimePlatformKey,
  parseHostedOpenCodeRuntimeLock,
} from '../../core/domain/hostedOpenCodeRuntimeLock';
import { atomicWriteAsync, renamePathWithRetry } from '@main/utils/atomicWrite';
import { execCli } from '@main/utils/childProcess';

import { extractHostedOpenCodeBinary } from './hostedOpenCodeArchive';

export const HOSTED_OPENCODE_CURRENT_MANIFEST_SCHEMA_VERSION = 2 as const;
const MAX_ARCHIVE_BYTES = 250 * 1024 * 1024;
const FETCH_TIMEOUT_MS = 60_000;
const VERSION_TIMEOUT_MS = 30_000;
const installInFlight = new Map<string, Promise<HostedOpenCodeCurrentManifestV2>>();

export interface HostedOpenCodeCurrentManifestV2 {
  readonly schemaVersion: 2;
  readonly runtime: 'opencode';
  readonly version: string;
  readonly tag: string;
  readonly platform: HostedOpenCodeRuntimePlatformKey;
  readonly binaryPath: string;
  readonly assetUrl: string;
  readonly archiveSha256: string;
  readonly binarySha256: string;
  readonly sourceCommit: string;
  readonly installedAt: string;
}

export interface HostedOpenCodeRuntimeInstallerOptions {
  readonly runtimeRoot: string;
  readonly lock: unknown;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
  readonly fetch?: typeof globalThis.fetch;
  readonly executeVersion?: (binaryPath: string) => Promise<string>;
  readonly beforePublishManifest?: (manifest: HostedOpenCodeCurrentManifestV2) => Promise<void>;
  readonly allowIneligibleTestFixture?: boolean;
}

function sha256(value: Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

function assertDigest(value: Buffer, expected: string, kind: 'archive' | 'binary'): void {
  if (sha256(value) !== expected) throw new Error(`hosted_opencode_${kind}_sha256_mismatch`);
}

function manifestPath(runtimeRoot: string): string {
  return path.join(runtimeRoot, 'current.json');
}

function expectedBinaryPath(
  runtimeRoot: string,
  lock: HostedOpenCodeRuntimeLockV2,
  platform: HostedOpenCodeRuntimePlatformKey,
  artifact: HostedOpenCodeRuntimeAvailableArtifact
): string {
  return path.join(runtimeRoot, 'versions', lock.version, platform, artifact.binaryName);
}

export function parseHostedOpenCodeCurrentManifest(
  value: unknown,
  runtimeRoot: string,
  lock: HostedOpenCodeRuntimeLockV2,
  platform: HostedOpenCodeRuntimePlatformKey,
  artifact: HostedOpenCodeRuntimeAvailableArtifact
): HostedOpenCodeCurrentManifestV2 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('hosted_opencode_current_manifest_invalid');
  }
  const manifest = value as Partial<HostedOpenCodeCurrentManifestV2>;
  const keys = Object.keys(value).toSorted();
  const expectedKeys = [
    'schemaVersion',
    'runtime',
    'version',
    'tag',
    'platform',
    'binaryPath',
    'assetUrl',
    'archiveSha256',
    'binarySha256',
    'sourceCommit',
    'installedAt',
  ].toSorted();
  if (
    keys.length !== expectedKeys.length ||
    !keys.every((key, index) => key === expectedKeys[index]) ||
    manifest.schemaVersion !== HOSTED_OPENCODE_CURRENT_MANIFEST_SCHEMA_VERSION ||
    manifest.runtime !== 'opencode' ||
    manifest.version !== lock.version ||
    manifest.tag !== lock.tag ||
    manifest.platform !== platform ||
    manifest.binaryPath !== expectedBinaryPath(runtimeRoot, lock, platform, artifact) ||
    manifest.assetUrl !== artifact.assetUrl ||
    manifest.archiveSha256 !== artifact.archiveSha256 ||
    manifest.binarySha256 !== artifact.binarySha256 ||
    manifest.sourceCommit !== lock.source.commit ||
    typeof manifest.installedAt !== 'string' ||
    !Number.isFinite(Date.parse(manifest.installedAt))
  ) {
    throw new Error('hosted_opencode_current_manifest_invalid');
  }
  return manifest as HostedOpenCodeCurrentManifestV2;
}

async function download(fetchImpl: typeof globalThis.fetch, url: string): Promise<Buffer> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, { signal: controller.signal, redirect: 'error' });
    if (!response.ok || !response.body)
      throw new Error(`hosted_opencode_download_failed:${response.status}`);
    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_ARCHIVE_BYTES)
      throw new Error('hosted_opencode_archive_too_large');
    const chunks: Buffer[] = [];
    let total = 0;
    const reader = response.body.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_ARCHIVE_BYTES) throw new Error('hosted_opencode_archive_too_large');
      chunks.push(Buffer.from(value));
    }
    return Buffer.concat(chunks, total);
  } finally {
    clearTimeout(timer);
  }
}

async function defaultExecuteVersion(binaryPath: string): Promise<string> {
  const result = await execCli(binaryPath, ['--version'], {
    timeout: VERSION_TIMEOUT_MS,
    windowsHide: true,
  });
  return `${result.stdout}\n${result.stderr}`.trim();
}

function selectArtifact(options: HostedOpenCodeRuntimeInstallerOptions): {
  lock: HostedOpenCodeRuntimeLockV2;
  platform: HostedOpenCodeRuntimePlatformKey;
  artifact: HostedOpenCodeRuntimeAvailableArtifact;
} {
  const lock = parseHostedOpenCodeRuntimeLock(options.lock);
  const platform = hostedOpenCodeRuntimePlatformKey(
    options.platform ?? process.platform,
    options.arch ?? process.arch
  );
  const artifact = lock.platforms[platform];
  if (artifact.status !== 'available')
    throw new Error(`hosted_opencode_artifact_unavailable:${platform}`);
  if (!options.allowIneligibleTestFixture || process.env.NODE_ENV !== 'test') {
    throw new Error('hosted_opencode_runtime_not_production_eligible');
  }
  return { lock, platform, artifact };
}

async function installHostedOpenCodeRuntimeOnce(
  options: HostedOpenCodeRuntimeInstallerOptions
): Promise<HostedOpenCodeCurrentManifestV2> {
  const { lock, platform, artifact } = selectArtifact(options);
  const archive = await download(options.fetch ?? globalThis.fetch, artifact.assetUrl);
  assertDigest(archive, artifact.archiveSha256, 'archive');
  const binary = extractHostedOpenCodeBinary(archive, artifact.archiveKind, artifact.binaryName);
  assertDigest(binary, artifact.binarySha256, 'binary');

  const finalBinaryPath = expectedBinaryPath(options.runtimeRoot, lock, platform, artifact);
  const finalDirectory = path.dirname(finalBinaryPath);
  const stagingDirectory = path.join(
    options.runtimeRoot,
    `.installing-${process.pid}-${randomUUID()}`
  );
  const stagingBinaryPath = path.join(stagingDirectory, artifact.binaryName);
  try {
    await fs.mkdir(stagingDirectory, { recursive: true });
    // Runtime installation deliberately publishes an executable after digest verification.
    await fs.writeFile(stagingBinaryPath, binary, { mode: 0o755 });
    if (process.platform !== 'win32') {
      // eslint-disable-next-line sonarjs/file-permissions
      await fs.chmod(stagingBinaryPath, 0o755);
    }
    const actualVersion = await (options.executeVersion ?? defaultExecuteVersion)(
      stagingBinaryPath
    );
    if (actualVersion !== lock.version) throw new Error('hosted_opencode_version_mismatch');

    const manifest: HostedOpenCodeCurrentManifestV2 = {
      schemaVersion: 2,
      runtime: 'opencode',
      version: lock.version,
      tag: lock.tag,
      platform,
      binaryPath: finalBinaryPath,
      assetUrl: artifact.assetUrl,
      archiveSha256: artifact.archiveSha256,
      binarySha256: artifact.binarySha256,
      sourceCommit: lock.source.commit,
      installedAt: new Date().toISOString(),
    };
    await options.beforePublishManifest?.(manifest);
    let finalBinaryExists = false;
    try {
      const existing = await fs.readFile(finalBinaryPath);
      assertDigest(existing, artifact.binarySha256, 'binary');
      finalBinaryExists = true;
    } catch (error) {
      if (error instanceof Error && error.message === 'hosted_opencode_binary_sha256_mismatch') {
        throw error;
      }
    }
    if (!finalBinaryExists) {
      await fs.mkdir(path.dirname(finalDirectory), { recursive: true });
      await renamePathWithRetry(stagingDirectory, finalDirectory);
    }
    await atomicWriteAsync(
      manifestPath(options.runtimeRoot),
      `${JSON.stringify(manifest, null, 2)}\n`
    );
    return manifest;
  } finally {
    await fs.rm(stagingDirectory, { recursive: true, force: true }).catch(() => undefined);
  }
}

export function installHostedOpenCodeRuntime(
  options: HostedOpenCodeRuntimeInstallerOptions
): Promise<HostedOpenCodeCurrentManifestV2> {
  const key = path.resolve(options.runtimeRoot);
  const existing = installInFlight.get(key);
  if (existing) return existing;
  const request = installHostedOpenCodeRuntimeOnce(options).finally(() => {
    if (installInFlight.get(key) === request) installInFlight.delete(key);
  });
  installInFlight.set(key, request);
  return request;
}

export async function resolveHostedOpenCodeRuntimeBinary(
  options: Omit<
    HostedOpenCodeRuntimeInstallerOptions,
    'fetch' | 'executeVersion' | 'beforePublishManifest'
  >
): Promise<string> {
  const { lock, platform, artifact } = selectArtifact(options);
  let raw: string;
  try {
    raw = await fs.readFile(manifestPath(options.runtimeRoot), 'utf8');
  } catch {
    throw new Error('hosted_opencode_current_manifest_missing');
  }
  let manifest: HostedOpenCodeCurrentManifestV2;
  try {
    manifest = parseHostedOpenCodeCurrentManifest(
      JSON.parse(raw),
      options.runtimeRoot,
      lock,
      platform,
      artifact
    );
  } catch {
    throw new Error('hosted_opencode_current_manifest_invalid');
  }
  let binary: Buffer;
  try {
    const stats = await fs.lstat(manifest.binaryPath);
    if (!stats.isFile() || stats.isSymbolicLink()) throw new Error('invalid');
    binary = await fs.readFile(manifest.binaryPath);
  } catch {
    throw new Error('hosted_opencode_binary_missing');
  }
  assertDigest(binary, artifact.binarySha256, 'binary');
  return manifest.binaryPath;
}
