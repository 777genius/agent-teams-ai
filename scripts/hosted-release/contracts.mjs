import { createHash } from 'node:crypto';
import { constants as fsConstants } from 'node:fs';
import { lstat, open, readdir } from 'node:fs/promises';
import path from 'node:path';

export const OWNER_LOCK_FILENAME = 'hosted-lifecycle-owner.lock.json';
export const STACK_LOCK_FILENAME = 'hosted-stack.lock.json';
export const OWNER_LOCK_TYPE = 'hosted-lifecycle-owner';
export const STACK_LOCK_TYPE = 'hosted-stack';
export const LOCK_SCHEMA_VERSION = 1;
export const MAX_LOCK_BYTES = 1024 * 1024;

// The accepted topology used hosted-lifecycle-owner-runtime.lock.json as a provisional name.
// P3.S5 standardizes the future materialized lock name above; it does not create that lock.
export const LEGACY_HOSTED_OWNER_LOCK_FILENAME = 'hosted-lifecycle-owner-runtime.lock.json';

const SHA256 = /^sha256:[a-f0-9]{64}$/u;
const trustedReleaseAdapters = new WeakMap();
// This keyring is source-controlled release configuration.  Production code
// can select only these pinned entries; it never accepts a policy supplied by
// release evidence, environment variables, or a caller.
const REPOSITORY_RELEASE_KEYRING = Object.freeze({
  'hosted-release-v1': Object.freeze({
    adapterId: 'hosted-release-v1',
    repository: '777genius/agent-teams-ai',
    releaseId: 'hosted-release-v1',
    policyVersion: '1',
    publicKey: '-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAmR7OEmXH1cL1n3mRZyQ1Vw4JQfI30xYJq9W3wV2Ot3A=\n-----END PUBLIC KEY-----\n',
  }),
});
const GIT_OBJECT_ID = /^[a-f0-9]{40}$/u;
const TAG = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u;
const CAPABILITY = /^[a-z][a-z0-9]*(?:[.-][a-z0-9]+)*$/u;
const TEXT = /^[\x20-\x7e]+$/u;
const COMMIT_MARKER = '.hosted-lock-commit.json';
const TRANSACTION_PREFIX = '.hosted-lock-transaction-';

const literal = (expected) => (value, path) => {
  if (value !== expected) fail(path, `must equal ${JSON.stringify(expected)}`);
};

const stringMatching = (pattern, description) => (value, path) => {
  if (typeof value !== 'string' || !pattern.test(value)) {
    fail(path, `must be ${description}`);
  }
};

const sha256 = stringMatching(SHA256, 'a lowercase sha256:<64-hex> digest');
const gitObjectId = stringMatching(GIT_OBJECT_ID, 'a lowercase 40-hex Git object ID');
const version = (value, path) => {
  if (typeof value !== 'string' || !isSemanticVersion(value)) {
    fail(path, 'must be an explicit semantic version');
  }
};
const tag = stringMatching(TAG, 'an explicit immutable tag');
const text = stringMatching(TEXT, 'non-empty printable ASCII text');

function isSemanticVersion(value) {
  const buildSeparator = value.indexOf('+');
  const versionAndPrerelease =
    buildSeparator === -1 ? value : value.slice(0, buildSeparator);
  const build = buildSeparator === -1 ? undefined : value.slice(buildSeparator + 1);
  if (build !== undefined && !hasValidIdentifiers(build, false)) return false;

  const prereleaseSeparator = versionAndPrerelease.indexOf('-');
  const core =
    prereleaseSeparator === -1
      ? versionAndPrerelease
      : versionAndPrerelease.slice(0, prereleaseSeparator);
  const prerelease =
    prereleaseSeparator === -1
      ? undefined
      : versionAndPrerelease.slice(prereleaseSeparator + 1);
  if (prerelease !== undefined && !hasValidIdentifiers(prerelease, true)) return false;

  const coreIdentifiers = core.split('.');
  return coreIdentifiers.length === 3 && coreIdentifiers.every(isCanonicalNumericIdentifier);
}

function hasValidIdentifiers(value, rejectLeadingZeroes) {
  const identifiers = value.split('.');
  return identifiers.every(
    (identifier) =>
      identifier.length > 0 &&
      isAsciiAlphanumericOrHyphen(identifier) &&
      (!rejectLeadingZeroes ||
        !isNumericIdentifier(identifier) ||
        isCanonicalNumericIdentifier(identifier))
  );
}

function isCanonicalNumericIdentifier(value) {
  return isNumericIdentifier(value) && (value.length === 1 || value[0] !== '0');
}

function isNumericIdentifier(value) {
  if (value.length === 0) return false;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

function isAsciiAlphanumericOrHyphen(value) {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (
      code !== 45 &&
      (code < 48 || code > 57) &&
      (code < 65 || code > 90) &&
      (code < 97 || code > 122)
    ) {
      return false;
    }
  }
  return true;
}

const safeRelativePath = (value, path) => {
  if (typeof value !== 'string' || value.length === 0 || Buffer.byteLength(value, 'utf8') > 240) {
    fail(path, 'must be a non-empty bounded relative path');
  }
  if (
    value.startsWith('/') ||
    value.startsWith('\\') ||
    value.includes('\\') ||
    value.includes(':') ||
    Array.from(value).some(
      (character) => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127
    ) ||
    value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')
  ) {
    fail(
      path,
      'must be a normalized POSIX relative path without traversal, controls, URL/drive syntax, or backslashes'
    );
  }
};

const capabilities = (value, path) => {
  if (!Array.isArray(value) || value.length === 0) {
    fail(path, 'must be a non-empty array');
  }
  value.forEach((item, index) =>
    stringMatching(CAPABILITY, 'a capability ID')(item, `${path}[${index}]`)
  );
  const sorted = [...value].sort();
  if (new Set(value).size !== value.length || !same(value, sorted)) {
    fail(path, 'must contain unique capability IDs in canonical sort order');
  }
};

const source = (expectedRepository) => ({
  repository: literal(expectedRepository),
  commit: gitObjectId,
  tree: gitObjectId,
  tag,
});

const productToolchain = {
  nodeVersion: version,
  pnpmVersion: version,
  pnpmLockSha256: sha256,
};

const ownerToolchain = {
  nodeVersion: version,
  bunVersion: version,
  bunLockSha256: sha256,
};

const openCodeToolchain = {
  bunVersion: version,
  bunLockSha256: sha256,
};

const entryAndClosure = {
  entryPath: safeRelativePath,
  entrySha256: sha256,
  closureManifestPath: safeRelativePath,
  closureManifestSha256: sha256,
  closureSha256: sha256,
};

const artifact = {
  namespace: text,
  name: text,
  sha256,
  signatureSha256: sha256,
};

const image = {
  reference: text,
  digest: sha256,
};

const signedDocument = {
  path: safeRelativePath,
  sha256,
  signatureSha256: sha256,
};

const protocol = {
  version,
  digest: sha256,
  capabilityDigest: sha256,
  capabilities,
};

const durableState = {
  formatVersion: version,
  compatibilityDigest: sha256,
};

const actualOwner = {
  ownerAuthority: text,
  ownerGeneration: (value, path) => {
    if (!Number.isSafeInteger(value) || value < 0) fail(path, 'must be a non-negative integer');
  },
  ownerSessionId: text,
  socketIdentity: {
    device: text,
    inode: text,
    uid: (value, path) => {
      if (!Number.isSafeInteger(value) || value < 0) fail(path, 'must be a non-negative integer');
    },
    gid: (value, path) => {
      if (!Number.isSafeInteger(value) || value < 0) fail(path, 'must be a non-negative integer');
    },
    mode: (value, path) => {
      if (!Number.isSafeInteger(value) || value < 0 || value > 0o7777) {
        fail(path, 'must be a valid file mode');
      }
    },
  },
};

const ineligibleTemporaryRuntime = {
  temporaryRuntime: literal(true),
  productionEligible: literal(false),
  releaseEligible: literal(false),
};

const ownerIdentity = {
  source: source('777genius/agent_teams_orchestrator'),
  toolchain: ownerToolchain,
  build: entryAndClosure,
  artifact,
  image,
  sbom: signedDocument,
  attestation: signedDocument,
  protocol,
  durableState,
  actualOwner,
  eligibility: ineligibleTemporaryRuntime,
};

const productIdentity = {
  source: source('777genius/agent-teams-ai'),
  toolchain: productToolchain,
  build: entryAndClosure,
  artifact,
  image,
};

const openCodeIdentity = {
  source: source('777genius/opencode-anomaly'),
  toolchain: openCodeToolchain,
  build: entryAndClosure,
  artifact,
  image,
  sbom: signedDocument,
  attestation: signedDocument,
  protocol,
};

const ownerLockSchema = {
  schemaVersion: literal(LOCK_SCHEMA_VERSION),
  lockType: literal(OWNER_LOCK_TYPE),
  ...ownerIdentity,
};

const stackLockSchema = {
  schemaVersion: literal(LOCK_SCHEMA_VERSION),
  lockType: literal(STACK_LOCK_TYPE),
  product: productIdentity,
  owner: {
    lockSha256: sha256,
    ...ownerIdentity,
  },
  openCode: openCodeIdentity,
  contracts: {
    hostedProducerProvenanceV2Sha256: literal(
      'sha256:ef6aa8ac1f139d2b5e9312da8ff1e6dac21da788d46eefbd6e3d43da27da23ba'
    ),
    actualOwnerContractV2Sha256: sha256,
    stackContractSha256: sha256,
  },
  toolchains: {
    productSha256: sha256,
    ownerSha256: sha256,
    openCodeSha256: sha256,
  },
  deploymentRecipe: {
    path: safeRelativePath,
    sha256,
  },
  eligibility: ineligibleTemporaryRuntime,
};

export function canonicalJsonBytes(value) {
  return Buffer.from(`${JSON.stringify(sortJson(value))}\n`, 'utf8');
}

export function sha256Digest(bytes) {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/** Canonicalize the observed owner tuple before comparing independently sourced facts. */
export function normalizeActualOwner(value) {
  if (!isPlainObject(value)) throw new TypeError('actual owner must be an object');
  return sortJson(value);
}

export function actualOwnersEqual(left, right) {
  return same(normalizeActualOwner(left), normalizeActualOwner(right));
}

/**
 * Captures repository trust outside the untrusted evidence object.  The policy
 * is deliberately private: a plain object copied from release evidence cannot
 * impersonate an adapter at a materialization call site.
 */
function adapterForPolicy(policy) {
  if (!policy || typeof policy !== 'object' || typeof policy.adapterId !== 'string' ||
      typeof policy.repository !== 'string' || typeof policy.releaseId !== 'string' ||
      typeof policy.policyVersion !== 'string' || !policy.publicKey) {
    throw new TypeError('trusted release policy is malformed');
  }
  const adapter = Object.freeze({ kind: 'hosted-release-trust-adapter' });
  trustedReleaseAdapters.set(adapter, Object.freeze({ ...policy }));
  return adapter;
}

/** Production factory: only a repository-pinned keyring entry is selectable. */
export function loadPinnedHostedReleaseTrust(releaseId = 'hosted-release-v1') {
  const policy = REPOSITORY_RELEASE_KEYRING[releaseId];
  if (!policy) throw new TypeError('unknown repository-pinned hosted release policy');
  return adapterForPolicy(policy);
}

/**
 * Test-only escape hatch for synthetic signatures.  Its name and runtime gate
 * deliberately keep custom verification out of production call paths.
 */
export function createTestHostedTrustedReleaseAdapter(policy) {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('custom hosted release trust is available only in tests');
  }
  return adapterForPolicy(policy);
}

export function trustedReleasePolicyFor(adapter) {
  const policy = trustedReleaseAdapters.get(adapter);
  if (!policy) throw new TypeError('hosted lock materialization requires a repository trust adapter');
  return policy;
}

export function parseOwnerLock(bytes) {
  return parseCanonicalLock(bytes, ownerLockSchema, OWNER_LOCK_FILENAME);
}

export function parseStackLock(bytes) {
  return parseCanonicalLock(bytes, stackLockSchema, STACK_LOCK_FILENAME);
}

export function verifyHostedLockPair(ownerBytes, stackBytes) {
  const owner = parseOwnerLock(ownerBytes);
  const stack = parseStackLock(stackBytes);

  requireEqual(stack.owner.lockSha256, sha256Digest(ownerBytes), 'owner.lockSha256');
  for (const field of Object.keys(ownerIdentity)) {
    requireEqual(stack.owner[field], owner[field], `owner.${field}`);
  }
  requireEqual(
    stack.toolchains.productSha256,
    sha256Digest(canonicalJsonBytes(stack.product.toolchain)),
    'toolchains.productSha256'
  );
  requireEqual(
    stack.toolchains.ownerSha256,
    sha256Digest(canonicalJsonBytes(owner.toolchain)),
    'toolchains.ownerSha256'
  );
  requireEqual(
    stack.toolchains.openCodeSha256,
    sha256Digest(canonicalJsonBytes(stack.openCode.toolchain)),
    'toolchains.openCodeSha256'
  );

  return { owner, stack };
}

/**
 * Marker-aware reader for materialized locks. It does not interpret a bare
 * generation directory as committed, and holds directory descriptors through
 * final pair verification.
 */
export async function resolveCommittedHostedLockPair(root, options = {}) {
  requireLinuxCommittedLockResolution();
  const resolvedRoot = path.resolve(root), rootBinding = await openBoundRoot(resolvedRoot);
  const { parentHandle, rootHandle } = rootBinding;
  try {
    const rootAnchor = descriptorPath(rootHandle);
    await assertRootBinding(rootBinding);
    await assertNoRootLevelLockEntries(rootAnchor);
    let markerState;
    try {
      markerState = await readStableFile(path.join(rootAnchor, COMMIT_MARKER), 64 * 1024, 2);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
      await assertNoRootLevelLockEntries(rootAnchor);
      if (path.basename(resolvedRoot).startsWith(TRANSACTION_PREFIX)) {
        throw new Error('an uncommitted hosted lock generation is not a verification root');
      }
      if (options.ifPresent === true) {
        await assertRootBinding(rootBinding);
        return undefined;
      }
      throw new Error('no complete committed hosted lock generation exists');
    }
    const marker = parseCommitMarker(markerState.bytes);
    if (options.onMarkerRead) await options.onMarkerRead({ marker: { ...marker } });
    const transactionHandle = await openDirectoryNoFollow(path.join(rootAnchor, marker.transactionName));
    try {
      const transactionAnchor = descriptorPath(transactionHandle), transactionIdentity = await transactionHandle.stat({ bigint: true });
      if (transactionIdentity.dev.toString() !== marker.transactionDevice || transactionIdentity.ino.toString() !== marker.transactionInode) throw new Error('committed hosted lock generation was replaced');
      if (options.onGenerationOpened) await options.onGenerationOpened({ transactionName: marker.transactionName });
      await assertDirectoryEntryIdentity(rootAnchor, marker.transactionName, transactionIdentity);
      const temporaryMarker = await readStableFile(path.join(transactionAnchor, `${COMMIT_MARKER}.${marker.transactionId}.tmp`), 64 * 1024, 2);
      if (!sameStableFile(markerState, temporaryMarker) || !temporaryMarker.bytes.equals(markerState.bytes)) throw new Error('hosted lock commit marker topology changed during verification');
      const ownerState = await readStableFile(path.join(transactionAnchor, OWNER_LOCK_FILENAME), MAX_LOCK_BYTES);
      const stackState = await readStableFile(path.join(transactionAnchor, STACK_LOCK_FILENAME), MAX_LOCK_BYTES);
      const pair = verifyHostedLockPair(ownerState.bytes, stackState.bytes);
      if (sha256Digest(ownerState.bytes) !== marker.ownerSha256 || sha256Digest(stackState.bytes) !== marker.stackSha256) throw new Error('committed hosted lock digest does not match its marker');
      await assertSameStableFile(path.join(transactionAnchor, OWNER_LOCK_FILENAME), ownerState);
      await assertSameStableFile(path.join(transactionAnchor, STACK_LOCK_FILENAME), stackState);
      await assertDirectoryEntryIdentity(rootAnchor, marker.transactionName, transactionIdentity);
      await assertRootBinding(rootBinding);
      await assertNoRootLevelLockEntries(rootAnchor);
      const finalMarker = await readStableFile(path.join(rootAnchor, COMMIT_MARKER), 64 * 1024, 2);
      if (!sameStableFile(markerState, finalMarker) || !finalMarker.bytes.equals(markerState.bytes)) {
        throw new Error('hosted lock commit marker changed during verification');
      }
      const finalTemporaryMarker = await readStableFile(path.join(transactionAnchor, `${COMMIT_MARKER}.${marker.transactionId}.tmp`), 64 * 1024, 2);
      if (!sameStableFile(markerState, finalTemporaryMarker) || !finalTemporaryMarker.bytes.equals(markerState.bytes)) throw new Error('hosted lock commit marker topology changed during verification');
      parseCommitMarker(finalMarker.bytes);
      await assertRootBinding(rootBinding);
      return { ...pair, ownerBytes: ownerState.bytes, stackBytes: stackState.bytes, ownerPath: path.join(resolvedRoot, marker.transactionName, OWNER_LOCK_FILENAME), stackPath: path.join(resolvedRoot, marker.transactionName, STACK_LOCK_FILENAME), transactionIdentity: { device: marker.transactionDevice, inode: marker.transactionInode } };
    } finally { await transactionHandle.close(); }
  } finally {
    await rootHandle.close();
    await parentHandle.close();
  }
}

function requireLinuxCommittedLockResolution() {
  if (process.platform !== 'linux') throw new Error('committed hosted lock resolution is unsupported on this platform; Linux descriptor-anchored filesystems are required');
}

function parseCommitMarker(bytes) {
  let record;
  try { record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { throw new Error('hosted lock commit marker is malformed'); }
  const expected = ['ownerFilename', 'ownerSha256', 'schemaVersion', 'stackFilename', 'stackSha256', 'transactionDevice', 'transactionId', 'transactionInode', 'transactionName'];
  if (!Buffer.from(bytes).equals(canonicalJsonBytes(record)) || !isPlainObject(record) || !same(Object.keys(record).sort(), expected) || record.schemaVersion !== 1 || typeof record.transactionId !== 'string' || !/^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/u.test(record.transactionId) || record.transactionName !== `${TRANSACTION_PREFIX}${record.transactionId}` || record.ownerFilename !== OWNER_LOCK_FILENAME || record.stackFilename !== STACK_LOCK_FILENAME || !SHA256.test(record.ownerSha256) || !SHA256.test(record.stackSha256) || !/^(?:0|[1-9][0-9]*)$/u.test(record.transactionDevice) || !/^(?:0|[1-9][0-9]*)$/u.test(record.transactionInode)) throw new Error('hosted lock commit marker is incomplete or invalid');
  return record;
}
function descriptorPath(handle) {
  if (process.platform === 'linux') return `/proc/self/fd/${handle.fd}`;
  throw new Error('committed hosted lock resolution requires descriptor-anchored paths on this platform');
}
async function openDirectoryNoFollow(directoryPath) {
  if (!Number.isInteger(fsConstants.O_NOFOLLOW) || fsConstants.O_NOFOLLOW === 0) throw new Error('committed hosted lock resolution requires O_NOFOLLOW');
  const handle = await open(directoryPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
  if (!(await handle.stat({ bigint: true })).isDirectory()) { await handle.close(); throw new Error('committed hosted lock path is not a directory'); }
  return handle;
}
async function openTrustedDirectory(directoryPath) {
  const absolute = path.resolve(directoryPath), parsed = path.parse(absolute); let current = await openDirectoryNoFollow(parsed.root);
  try {
    for (const segment of absolute.slice(parsed.root.length).split(path.sep).filter(Boolean)) { const next = await openDirectoryNoFollow(path.join(descriptorPath(current), segment)); await current.close(); current = next; }
    return current;
  } catch (error) { await current.close(); throw error; }
}
async function openBoundRoot(rootPath) {
  const parentPath = path.dirname(rootPath), rootName = path.basename(rootPath);
  if (!rootName || rootPath === path.parse(rootPath).root) {
    throw new Error('committed hosted lock root must not be a filesystem root');
  }
  const parentHandle = await openTrustedDirectory(parentPath);
  try {
    const parentIdentity = await parentHandle.stat({ bigint: true });
    const rootHandle = await openDirectoryNoFollow(path.join(descriptorPath(parentHandle), rootName));
    return {
      parentHandle,
      parentIdentity,
      rootHandle,
      rootIdentity: await rootHandle.stat({ bigint: true }),
      rootName,
      rootPath,
    };
  } catch (error) {
    await parentHandle.close();
    throw error;
  }
}
async function assertRootBinding(binding) {
  await assertDirectoryHandleIdentity(binding.parentHandle, binding.parentIdentity);
  const fromHeldParent = await openDirectoryNoFollow(path.join(descriptorPath(binding.parentHandle), binding.rootName));
  try {
    await assertDirectoryHandleIdentity(fromHeldParent, binding.rootIdentity);
  } finally {
    await fromHeldParent.close();
  }
  const fromCallerPath = await openDirectoryNoFollow(binding.rootPath);
  try {
    await assertDirectoryHandleIdentity(fromCallerPath, binding.rootIdentity);
  } finally {
    await fromCallerPath.close();
  }
  await assertDirectoryHandleIdentity(binding.rootHandle, binding.rootIdentity);
}
async function assertDirectoryHandleIdentity(handle, expected) {
  const current = await handle.stat({ bigint: true });
  if (!current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino || current.mode !== expected.mode) {
    throw new Error('committed hosted lock root pathname was renamed or replaced during verification');
  }
}
async function assertDirectoryEntryIdentity(parentAnchor, name, expected) {
  const current = await lstat(path.join(parentAnchor, name), { bigint: true });
  if (!current.isDirectory() || current.dev !== expected.dev || current.ino !== expected.ino || current.mode !== expected.mode) throw new Error('committed hosted lock generation was renamed or replaced during verification');
}
async function readStableFile(filePath, maximum, expectedLinks = 1) {
  let handle;
  try {
    handle = await open(filePath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== BigInt(expectedLinks) || before.size > BigInt(maximum)) throw new Error(`${path.basename(filePath)} is not a bounded standalone file`);
    const bytes = Buffer.alloc(Number(before.size)); let offset = 0;
    while (offset < bytes.length) { const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset); if (!bytesRead) throw new Error(`${path.basename(filePath)} changed while it was read`); offset += bytesRead; }
    const after = await handle.stat({ bigint: true }), entry = await lstat(filePath, { bigint: true });
    if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size || before.nlink !== after.nlink || before.nlink !== entry.nlink || before.ctimeNs !== after.ctimeNs || before.dev !== entry.dev || before.ino !== entry.ino) throw new Error(`${path.basename(filePath)} was replaced while it was read`);
    return { bytes, metadata: stableMetadata(before) };
  } finally { await handle?.close(); }
}
async function assertSameStableFile(filePath, expected) {
  const current = await readStableFile(filePath, MAX_LOCK_BYTES);
  if (!sameStableFile(expected, current) || !current.bytes.equals(expected.bytes)) {
    throw new Error(`${path.basename(filePath)} changed during committed lock verification`);
  }
}
function stableMetadata(metadata) {
  return { dev: metadata.dev, ino: metadata.ino, mode: metadata.mode, nlink: metadata.nlink, size: metadata.size, mtimeNs: metadata.mtimeNs, ctimeNs: metadata.ctimeNs };
}
function sameStableFile(left, right) {
  return left.metadata.dev === right.metadata.dev && left.metadata.ino === right.metadata.ino && left.metadata.mode === right.metadata.mode && left.metadata.nlink === right.metadata.nlink && left.metadata.size === right.metadata.size && left.metadata.mtimeNs === right.metadata.mtimeNs && left.metadata.ctimeNs === right.metadata.ctimeNs;
}
async function assertNoRootLevelLockEntries(rootAnchor) {
  for (const filename of [LEGACY_HOSTED_OWNER_LOCK_FILENAME, OWNER_LOCK_FILENAME, STACK_LOCK_FILENAME]) {
    try {
      await lstat(path.join(rootAnchor, filename), { bigint: true });
      throw new Error(`${filename} is a stale root-level hosted lock; only the committed generation may be verified`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  const names = await readdir(rootAnchor);
  if (names.some((name) => name.startsWith(`${COMMIT_MARKER}.`))) {
    throw new Error('temporary hosted lock commit marker is not a committed generation');
  }
}

function parseCanonicalLock(input, schema, filename) {
  if (!Buffer.isBuffer(input) && !(input instanceof Uint8Array)) {
    throw new TypeError(`${filename}: input must be bytes`);
  }
  if (input.byteLength > MAX_LOCK_BYTES) {
    throw new Error(`${filename}: input exceeds the ${MAX_LOCK_BYTES}-byte limit`);
  }

  let textValue;
  try {
    textValue = new TextDecoder('utf-8', { fatal: true }).decode(input);
  } catch {
    throw new Error(`${filename}: bytes must be valid UTF-8`);
  }

  let value;
  try {
    value = JSON.parse(textValue);
  } catch (error) {
    throw new Error(`${filename}: malformed JSON: ${error.message}`);
  }

  validateShape(value, schema, '$');
  if (!Buffer.from(input).equals(canonicalJsonBytes(value))) {
    throw new Error(
      `${filename}: bytes are not the single canonical representation ` +
        '(sorted keys, no duplicate keys, one trailing newline)'
    );
  }
  return value;
}

function validateShape(value, schema, path) {
  if (!isPlainObject(value)) fail(path, 'must be an object');

  const expected = Object.keys(schema).sort();
  const actual = Object.keys(value).sort();
  if (!same(actual, expected)) {
    const missing = expected.filter((key) => !actual.includes(key));
    const unknown = actual.filter((key) => !expected.includes(key));
    fail(path, `fields mismatch; missing=[${missing.join(',')}], unknown=[${unknown.join(',')}]`);
  }

  for (const key of expected) {
    const rule = schema[key];
    if (typeof rule === 'function') {
      rule(value[key], `${path}.${key}`);
    } else {
      validateShape(value[key], rule, `${path}.${key}`);
    }
  }
}

function requireEqual(actual, expected, path) {
  if (!same(actual, expected)) {
    fail(`$.${path}`, 'does not match its cross-lock binding');
  }
}

function sortJson(value) {
  if (Array.isArray(value)) return value.map(sortJson);
  if (!isPlainObject(value)) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, sortJson(value[key])])
  );
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function same(left, right) {
  return JSON.stringify(left) === JSON.stringify(right);
}

function fail(path, message) {
  throw new Error(`${path}: ${message}`);
}
