export const HOSTED_OPENCODE_RUNTIME_LOCK_SCHEMA_VERSION = 2 as const;
export const HOSTED_OPENCODE_RUNTIME_PLATFORM_KEYS = [
  'darwin-arm64',
  'darwin-x64',
  'linux-arm64',
  'linux-x64',
  'win32-arm64',
  'win32-x64',
] as const;

export type HostedOpenCodeRuntimePlatformKey =
  (typeof HOSTED_OPENCODE_RUNTIME_PLATFORM_KEYS)[number];

export const HOSTED_OPENCODE_CURRENT_MANIFEST_SCHEMA_VERSION = 2 as const;

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

export interface HostedOpenCodeRuntimeAvailableArtifact {
  readonly status: 'available';
  readonly file: string;
  readonly archiveKind: 'tar.gz' | 'zip';
  readonly binaryName: 'opencode' | 'opencode.exe';
  readonly archiveSha256: string;
  readonly binarySha256: string;
  readonly assetUrl: string;
}

export interface HostedOpenCodeRuntimeUnavailableArtifact {
  readonly status: 'unavailable';
  readonly reason: 'artifact_digests_pending';
}

export type HostedOpenCodeRuntimeArtifact =
  | HostedOpenCodeRuntimeAvailableArtifact
  | HostedOpenCodeRuntimeUnavailableArtifact;

export interface HostedOpenCodeRuntimeLockV2 {
  readonly schemaVersion: 2;
  readonly runtime: 'opencode';
  readonly version: string;
  readonly tag: string;
  readonly productionEligible: false;
  readonly source: {
    readonly repository: string;
    readonly baseCommit: string;
    readonly commit: string;
    readonly reviewedPatchSha256: string;
  };
  readonly releaseRepository: string;
  readonly platforms: Readonly<
    Record<HostedOpenCodeRuntimePlatformKey, HostedOpenCodeRuntimeArtifact>
  >;
}

const SHA256 = /^[0-9a-f]{64}$/u;
const COMMIT = /^[0-9a-f]{40}$/u;
const REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const VERSION = /^[0-9]+\.[0-9]+\.[0-9]+-agentteams\.[0-9]+$/u;

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function exactKeys(value: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(value).toSorted();
  return (
    actual.length === keys.length && actual.every((key, index) => key === keys.toSorted()[index])
  );
}

function parseArtifact(
  value: unknown,
  platform: HostedOpenCodeRuntimePlatformKey,
  releaseRepository: string,
  tag: string
): HostedOpenCodeRuntimeArtifact {
  const artifact = record(value);
  if (!artifact) throw new Error(`hosted_opencode_lock_artifact_invalid:${platform}`);
  if (artifact.status === 'unavailable') {
    if (
      !exactKeys(artifact, ['status', 'reason']) ||
      artifact.reason !== 'artifact_digests_pending'
    ) {
      throw new Error(`hosted_opencode_lock_unavailable_invalid:${platform}`);
    }
    return { status: 'unavailable', reason: 'artifact_digests_pending' };
  }
  if (
    artifact.status !== 'available' ||
    !exactKeys(artifact, [
      'status',
      'file',
      'archiveKind',
      'binaryName',
      'archiveSha256',
      'binarySha256',
      'assetUrl',
    ]) ||
    typeof artifact.file !== 'string' ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*\.(?:tar\.gz|zip)$/u.test(artifact.file) ||
    (artifact.archiveKind !== 'tar.gz' && artifact.archiveKind !== 'zip') ||
    !artifact.file.endsWith(artifact.archiveKind === 'tar.gz' ? '.tar.gz' : '.zip') ||
    artifact.binaryName !== (platform.startsWith('win32-') ? 'opencode.exe' : 'opencode') ||
    typeof artifact.archiveSha256 !== 'string' ||
    !SHA256.test(artifact.archiveSha256) ||
    typeof artifact.binarySha256 !== 'string' ||
    !SHA256.test(artifact.binarySha256)
  ) {
    throw new Error(`hosted_opencode_lock_available_invalid:${platform}`);
  }
  const expectedUrl = `https://github.com/${releaseRepository}/releases/download/${tag}/${artifact.file}`;
  if (artifact.assetUrl !== expectedUrl || artifact.assetUrl.includes('/releases/latest')) {
    throw new Error(`hosted_opencode_lock_asset_url_invalid:${platform}`);
  }
  return artifact as unknown as HostedOpenCodeRuntimeAvailableArtifact;
}

export function parseHostedOpenCodeRuntimeLock(value: unknown): HostedOpenCodeRuntimeLockV2 {
  const lock = record(value);
  if (
    !lock ||
    !exactKeys(lock, [
      'schemaVersion',
      'runtime',
      'version',
      'tag',
      'productionEligible',
      'source',
      'releaseRepository',
      'platforms',
    ]) ||
    lock.schemaVersion !== HOSTED_OPENCODE_RUNTIME_LOCK_SCHEMA_VERSION ||
    lock.runtime !== 'opencode' ||
    typeof lock.version !== 'string' ||
    !VERSION.test(lock.version) ||
    lock.tag !== `v${lock.version}` ||
    lock.productionEligible !== false ||
    typeof lock.releaseRepository !== 'string' ||
    !REPOSITORY.test(lock.releaseRepository)
  ) {
    throw new Error('hosted_opencode_lock_invalid');
  }
  const source = record(lock.source);
  if (
    !source ||
    !exactKeys(source, ['repository', 'baseCommit', 'commit', 'reviewedPatchSha256']) ||
    typeof source.repository !== 'string' ||
    !REPOSITORY.test(source.repository) ||
    source.repository !== lock.releaseRepository ||
    typeof source.baseCommit !== 'string' ||
    !COMMIT.test(source.baseCommit) ||
    typeof source.commit !== 'string' ||
    !COMMIT.test(source.commit) ||
    typeof source.reviewedPatchSha256 !== 'string' ||
    !SHA256.test(source.reviewedPatchSha256)
  ) {
    throw new Error('hosted_opencode_lock_source_invalid');
  }
  const platforms = record(lock.platforms);
  if (!platforms || !exactKeys(platforms, HOSTED_OPENCODE_RUNTIME_PLATFORM_KEYS)) {
    throw new Error('hosted_opencode_lock_platforms_invalid');
  }
  const parsedPlatforms = Object.fromEntries(
    HOSTED_OPENCODE_RUNTIME_PLATFORM_KEYS.map((platform) => [
      platform,
      parseArtifact(
        platforms[platform],
        platform,
        lock.releaseRepository as string,
        lock.tag as string
      ),
    ])
  ) as unknown as HostedOpenCodeRuntimeLockV2['platforms'];
  return {
    schemaVersion: 2,
    runtime: 'opencode',
    version: lock.version,
    tag: lock.tag,
    productionEligible: false,
    source: source as unknown as HostedOpenCodeRuntimeLockV2['source'],
    releaseRepository: lock.releaseRepository,
    platforms: parsedPlatforms,
  };
}

export function hostedOpenCodeRuntimePlatformKey(
  platform: string,
  arch: string
): HostedOpenCodeRuntimePlatformKey {
  const key = `${platform}-${arch}`;
  if (!HOSTED_OPENCODE_RUNTIME_PLATFORM_KEYS.includes(key as HostedOpenCodeRuntimePlatformKey)) {
    throw new Error(`hosted_opencode_platform_unsupported:${key}`);
  }
  return key as HostedOpenCodeRuntimePlatformKey;
}
