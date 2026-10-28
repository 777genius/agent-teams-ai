export const OPENCODE_V2_SUPPORT_ROOT_ENV = 'CLAUDE_MULTIMODEL_OPENCODE_V2_SUPPORT_ROOT';
export const V2_MANIFEST_FILE = 'opencode-v2-engine-manifest.json';
export const V2_SUPPORT_REQUIRED_MESSAGE =
  'OpenCode V2 support download required. Install V2 support to continue.';
export const V2_DELIVERY_LIMITS = {
  archive: 1024 ** 3,
  expanded: 4 * 1024 ** 3,
  file: 256 * 1024 ** 2,
  files: 65_536,
  entries: 100_000,
  manifest: 32 * 1024 ** 2,
  path: 1024,
} as const;

export interface OpenCodeV2DeliveryIdentity {
  schemaVersion: 1;
  runtimeVersion: string;
  sourceCommit: string;
  bridgeProtocol: 1;
  platform: string;
  arch: string;
  requiredBunVersion: string;
  engineVersions: string[];
}
export interface OpenCodeV2DeliveryDescriptor extends OpenCodeV2DeliveryIdentity {
  archive: {
    file: string;
    kind: 'zip';
    sha256: string;
    bytes: number;
    entries: number;
    expandedBytes: number;
  };
  manifest: { file: typeof V2_MANIFEST_FILE; sha256: string; bytes: number; files: number };
}
export interface OpenCodeV2ManifestFile {
  path: string;
  bytes: number;
  sha256: string;
  executable: boolean;
}
export interface OpenCodeV2DeliveryManifest extends OpenCodeV2DeliveryIdentity {
  files: OpenCodeV2ManifestFile[];
}
export interface OpenCodeV2InstalledReceipt {
  schemaVersion: 1;
  runtimeVersion: string;
  sourceCommit: string;
  bridgeProtocol: 1;
  platform: string;
  arch: string;
  archiveSha256: string;
  manifestSha256: string;
  instance: string;
}
const RELEASE = /^(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})\.(0|[1-9]\d{0,8})$/;
const SHA = /^[a-f0-9]{64}$/;
export const V2_INSTANCE_UUID =
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const IDENTITY_KEYS = [
  'schemaVersion',
  'runtimeVersion',
  'sourceCommit',
  'bridgeProtocol',
  'platform',
  'arch',
  'requiredBunVersion',
  'engineVersions',
];

function invalid(): never {
  throw new Error('Invalid pinned OpenCode V2 support delivery');
}
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, expected: readonly string[]): void {
  if (
    Object.keys(value).length !== expected.length ||
    expected.some((key) => !Object.hasOwn(value, key))
  )
    invalid();
}
function bounded(value: unknown, maximum: number, minimum = 1): value is number {
  return (
    typeof value === 'number' && Number.isSafeInteger(value) && value >= minimum && value <= maximum
  );
}
function identity(value: Record<string, unknown>): void {
  if (
    value.schemaVersion !== 1 ||
    value.bridgeProtocol !== 1 ||
    typeof value.runtimeVersion !== 'string' ||
    !RELEASE.test(value.runtimeVersion) ||
    typeof value.sourceCommit !== 'string' ||
    !/^[a-f0-9]{40}$/.test(value.sourceCommit) ||
    !['darwin', 'linux', 'win32'].includes(String(value.platform)) ||
    !['arm64', 'x64'].includes(String(value.arch)) ||
    typeof value.requiredBunVersion !== 'string' ||
    !RELEASE.test(value.requiredBunVersion) ||
    !Array.isArray(value.engineVersions) ||
    value.engineVersions.length === 0 ||
    value.engineVersions.some(
      (version) => typeof version !== 'string' || !/^2\./.test(version) || !RELEASE.test(version)
    ) ||
    new Set(value.engineVersions).size !== value.engineVersions.length
  )
    invalid();
}

/** A present malformed map never means the older bundled delivery mode. */
export function readOpenCodeV2DeliveryMap(
  lockValue: unknown
): Readonly<Record<string, OpenCodeV2DeliveryDescriptor>> | null {
  const lock = record(lockValue);
  if (!Object.hasOwn(lock, 'opencodeV2Delivery')) return null;
  const map = record(lock.opencodeV2Delivery);
  const qualified = record(record(lock.opencodeV2).qualified);
  const platforms = Object.keys(record(lock.assets)).filter(
    (key) => Array.isArray(qualified[key]) && (qualified[key] as unknown[]).length > 0
  );
  keys(map, platforms);
  let sourceCommit: string | undefined;
  for (const platformKey of platforms) {
    const descriptor = record(map[platformKey]);
    keys(descriptor, [...IDENTITY_KEYS, 'archive', 'manifest']);
    identity(descriptor);
    if (
      descriptor.runtimeVersion !== lock.version ||
      `${descriptor.platform}-${descriptor.arch}` !== platformKey ||
      JSON.stringify(descriptor.engineVersions) !== JSON.stringify(qualified[platformKey]) ||
      (sourceCommit !== undefined && sourceCommit !== descriptor.sourceCommit)
    )
      invalid();
    sourceCommit = descriptor.sourceCommit as string;
    const archive = record(descriptor.archive),
      manifest = record(descriptor.manifest);
    keys(archive, ['file', 'kind', 'sha256', 'bytes', 'entries', 'expandedBytes']);
    keys(manifest, ['file', 'sha256', 'bytes', 'files']);
    if (
      archive.file !== `agent-teams-opencode-v2-support-${platformKey}-v${lock.version}.zip` ||
      archive.kind !== 'zip' ||
      typeof archive.sha256 !== 'string' ||
      !SHA.test(archive.sha256) ||
      !bounded(archive.bytes, V2_DELIVERY_LIMITS.archive) ||
      !bounded(archive.entries, V2_DELIVERY_LIMITS.entries) ||
      !bounded(archive.expandedBytes, V2_DELIVERY_LIMITS.expanded) ||
      manifest.file !== V2_MANIFEST_FILE ||
      typeof manifest.sha256 !== 'string' ||
      !SHA.test(manifest.sha256) ||
      !bounded(manifest.bytes, V2_DELIVERY_LIMITS.manifest) ||
      !bounded(manifest.files, V2_DELIVERY_LIMITS.files) ||
      archive.entries < manifest.files + 1 ||
      archive.expandedBytes < manifest.bytes
    )
      invalid();
  }
  return map as unknown as Readonly<Record<string, OpenCodeV2DeliveryDescriptor>>;
}

/** Canonical relative names are also portable across case-insensitive targets. */
export function assertOpenCodeV2DeliveryPath(value: string): void {
  if (
    !value ||
    new TextEncoder().encode(value).length > V2_DELIVERY_LIMITS.path ||
    /[\\:\x00-\x1f\x7f]/.test(value) ||
    value
      .split('/')
      .some(
        (part) =>
          !part ||
          part === '.' ||
          part === '..' ||
          /[. ]$/.test(part) ||
          /^(con|prn|aux|nul|conin\$|conout\$|com[0-9¹²³]|lpt[0-9¹²³])(?:\.|$)/iu.test(part)
      )
  )
    invalid();
}

export function parseOpenCodeV2DeliveryManifest(
  value: unknown,
  descriptor: OpenCodeV2DeliveryDescriptor
): OpenCodeV2DeliveryManifest {
  const manifest = record(value);
  keys(manifest, [...IDENTITY_KEYS, 'files']);
  identity(manifest);
  if (
    IDENTITY_KEYS.some(
      (key) =>
        JSON.stringify(manifest[key]) !==
        JSON.stringify(descriptor[key as keyof OpenCodeV2DeliveryDescriptor])
    ) ||
    !Array.isArray(manifest.files) ||
    manifest.files.length !== descriptor.manifest.files
  )
    invalid();
  const paths = new Set<string>();
  let previous: Uint8Array | undefined;
  let bytes = descriptor.manifest.bytes;
  const encoder = new TextEncoder();
  for (const value of manifest.files) {
    const file = record(value);
    keys(file, ['path', 'bytes', 'sha256', 'executable']);
    if (
      typeof file.path !== 'string' ||
      !file.path.startsWith('local-cli/') ||
      file.path === 'local-cli/cli.js' ||
      !bounded(file.bytes, V2_DELIVERY_LIMITS.file, 0) ||
      typeof file.sha256 !== 'string' ||
      !SHA.test(file.sha256) ||
      typeof file.executable !== 'boolean'
    )
      invalid();
    assertOpenCodeV2DeliveryPath(file.path);
    const encoded = encoder.encode(file.path);
    const order = previous ? compareBytes(previous, encoded) : -1;
    const key = file.path.normalize('NFC').toLowerCase();
    if (order >= 0 || paths.has(key)) invalid();
    paths.add(key);
    previous = encoded;
    bytes += file.bytes;
  }
  if (bytes !== descriptor.archive.expandedBytes) invalid();
  for (const required of [
    'opencodeV2Server.js',
    'opencodeV2ExecutionServer.js',
    'opencodeV2RunOwner.js',
    'opencode-v2-graphs.json',
  ])
    if (!paths.has(`local-cli/${required}`.toLowerCase())) invalid();
  return manifest as unknown as OpenCodeV2DeliveryManifest;
}

function compareBytes(left: Uint8Array, right: Uint8Array): number {
  for (let index = 0; index < Math.min(left.length, right.length); index++)
    if (left[index] !== right[index]) return left[index]! - right[index]!;
  return left.length - right.length;
}

export function parseOpenCodeV2InstalledReceipt(
  value: unknown,
  descriptor: OpenCodeV2DeliveryDescriptor
): OpenCodeV2InstalledReceipt {
  const receipt = record(value);
  keys(receipt, [
    'schemaVersion',
    'runtimeVersion',
    'sourceCommit',
    'bridgeProtocol',
    'platform',
    'arch',
    'archiveSha256',
    'manifestSha256',
    'instance',
  ]);
  if (
    receipt.schemaVersion !== 1 ||
    receipt.runtimeVersion !== descriptor.runtimeVersion ||
    receipt.sourceCommit !== descriptor.sourceCommit ||
    receipt.bridgeProtocol !== descriptor.bridgeProtocol ||
    receipt.platform !== descriptor.platform ||
    receipt.arch !== descriptor.arch ||
    receipt.archiveSha256 !== descriptor.archive.sha256 ||
    receipt.manifestSha256 !== descriptor.manifest.sha256 ||
    typeof receipt.instance !== 'string' ||
    !V2_INSTANCE_UUID.test(receipt.instance)
  )
    invalid();
  return receipt as unknown as OpenCodeV2InstalledReceipt;
}
