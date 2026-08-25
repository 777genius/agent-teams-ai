import { createHash, createPublicKey, verify } from 'node:crypto';
import {
  type BigIntStats,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readdirSync,
  readSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, normalize, resolve } from 'node:path';

import { HOSTED_LIFECYCLE_OWNER_GENERATION_LIMIT } from './hostedLifecycleOwnerHighWaterBinding';

import type {
  OrchestratorLifecycleBootstrapBinding,
  OrchestratorLifecycleOwnerBinding,
  OrchestratorSocketIdentity,
} from './hostedLifecycleOrchestratorReadiness';

export const HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_PATH =
  '/run/agent-teams-orchestrator/lifecycle-owner-admission.json';
export const HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_ENV =
  'HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_FILE';
export const HOSTED_LIFECYCLE_OWNER_ADMISSION_FORMAT =
  'agent-teams.hosted-lifecycle-owner-admission/v2';
export const HOSTED_LIFECYCLE_OWNER_ADMISSION_PAYLOAD_FORMAT =
  'agent-teams.hosted-lifecycle-owner-admission-payload/v2';
export const HOSTED_LIFECYCLE_OWNER_ADMISSION_SIGNATURE_DOMAIN =
  'agent-teams.hosted-lifecycle-owner-admission/v2';
export const HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_PATH =
  '/run/agent-teams-lifecycle-trust/release-owner-pin.json';
export const HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_ENV = 'HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FILE';
export const HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FORMAT =
  'agent-teams.hosted-lifecycle-owner-release-pin/v2';

const LIFECYCLE_SOCKET_PATH = '/run/agent-teams-orchestrator/orchestrator-lifecycle.sock';
const LIFECYCLE_TRUST_ANCHOR_PATH = '/run/agent-teams-lifecycle-trust/trust-anchor';
const STABLE_BOOTSTRAP_ENV = 'AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP';
const COMPATIBILITY_BOOTSTRAP_ENV = 'AGENT_TEAMS_HOSTED_PHASE2_READ_BOOTSTRAP';
const MAXIMUM_MANIFEST_BYTES = 16_384;
const MAXIMUM_PAYLOAD_BYTES = 12_288;
const MAXIMUM_RELEASE_PIN_BYTES = 1_024;
const ARTIFACT_DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const IMAGE_REFERENCE_PATTERN =
  /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}(?:\/[A-Za-z0-9][A-Za-z0-9._-]{0,127})+@sha256:[0-9a-f]{64}$/u;
const ARTIFACT_VERSION_PATTERN = /^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/u;
const OWNER_AUTHORITY_PATTERN = /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const OWNER_SESSION_PATTERN = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const HOSTED_ID_PATTERN = /^[a-z][a-z0-9-]*_[A-Za-z0-9][A-Za-z0-9._-]{2,127}$/u;
const DECIMAL_ID_PATTERN = /^\d{1,32}$/u;
const SHA256_PATTERN = /^[0-9a-f]{64}$/u;
const TRUST_ANCHOR_PATTERN = /^[0-9a-f]{64}$/u;
const ED25519_PUBLIC_KEY_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const ED25519_SIGNATURE_PATTERN = /^[A-Za-z0-9_-]{86}$/u;
const FORBIDDEN_LEGACY_OWNER_ENVIRONMENT = Object.freeze([
  'HOSTED_LIFECYCLE_OWNER_ARTIFACT_DIGEST',
  'HOSTED_LIFECYCLE_OWNER_IMAGE_REFERENCE',
  'HOSTED_LIFECYCLE_OWNER_PROTOCOL_VERSION',
  'HOSTED_LIFECYCLE_OWNER_AUTHORITY',
]);

export interface HostedLifecycleReleaseOwnerArtifact {
  readonly artifactDigest: `sha256:${string}`;
  readonly imageReference: string;
  readonly artifactVersion: string;
  readonly protocolVersion: number;
}

export interface HostedLifecycleReleaseOwnerPin extends HostedLifecycleReleaseOwnerArtifact {
  readonly launcherPublicKey: string;
  readonly launcherKeyId: string;
}

export interface HostedLifecycleProductionOwnerAdmission extends HostedLifecycleReleaseOwnerPin {
  readonly ownerAuthority: string;
  readonly expectedOwnerBinding: OrchestratorLifecycleOwnerBinding;
  readonly bootstrapBinding: OrchestratorLifecycleBootstrapBinding;
  readonly manifestDigest: `sha256:${string}`;
  readonly releasePinDigest: `sha256:${string}`;
}

export interface HostedLifecycleProductionOwnerAdmissionOptions {
  /** Descriptor-safe fixture paths; production callers use the fixed container paths. */
  readonly manifestPath?: string;
  readonly trustAnchorPath?: string;
  readonly releasePinPath?: string;
  readonly socketPath?: string;
  readonly expectedUid?: number;
  readonly expectedGid?: number;
}

interface SecureFileSnapshot {
  readonly body: string;
  readonly digest: `sha256:${string}`;
}

type ParsedOwnerArtifact = HostedLifecycleReleaseOwnerArtifact;

interface ParsedAdmissionPayload {
  readonly artifact: ParsedOwnerArtifact;
  readonly expectedOwnerBinding: OrchestratorLifecycleOwnerBinding;
  readonly bootstrapBinding: OrchestratorLifecycleBootstrapBinding;
}

/**
 * Admits only an owner that independently matches the descriptor-safe deployment release pin and
 * one Ed25519 launcher-signed manifest. The owner proof HMAC key is deliberately not a manifest
 * signing authority. Direct environment fields are rejected, and the signed bootstrap digest must
 * cover the exact stable bootstrap bytes consumed by hosted composition.
 */
export function admitHostedLifecycleProductionOwner(
  environment: Readonly<Record<string, string | undefined>>,
  options: HostedLifecycleProductionOwnerAdmissionOptions = {}
): HostedLifecycleProductionOwnerAdmission | null {
  try {
    const expectedUid = parseExpectedIdentity(options.expectedUid ?? process.getuid?.() ?? 1000);
    const expectedGid = parseExpectedIdentity(options.expectedGid ?? process.getgid?.() ?? 1000);
    const manifestPath = options.manifestPath ?? HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_PATH;
    const trustAnchorPath = options.trustAnchorPath ?? LIFECYCLE_TRUST_ANCHOR_PATH;
    const releasePinPath = options.releasePinPath ?? HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_PATH;
    const socketPath = options.socketPath ?? LIFECYCLE_SOCKET_PATH;
    assertFixedEnvironmentPath(
      environment[HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_ENV],
      manifestPath
    );
    assertFixedEnvironmentPath(
      environment.HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR_FILE,
      trustAnchorPath
    );
    assertFixedEnvironmentPath(environment[HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_ENV], releasePinPath);
    assertFixedEnvironmentPath(environment.HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET, socketPath);
    if (
      environment.HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR !== undefined ||
      environment[COMPATIBILITY_BOOTSTRAP_ENV] !== undefined ||
      FORBIDDEN_LEGACY_OWNER_ENVIRONMENT.some((name) => environment[name] !== undefined)
    ) {
      throw new TypeError('hosted-lifecycle-owner-admission-environment-invalid');
    }

    const serializedBootstrap = environment[STABLE_BOOTSTRAP_ENV];
    if (
      typeof serializedBootstrap !== 'string' ||
      serializedBootstrap.length === 0 ||
      Buffer.byteLength(serializedBootstrap, 'utf8') > 1_048_576
    ) {
      throw new TypeError('hosted-lifecycle-owner-admission-bootstrap-invalid');
    }

    assertLifecycleTrustDirectoryLayout({
      trustAnchorPath,
      releasePinPath,
      expectedUid,
      expectedGid,
    });
    const trustAnchorFile = readSecureFile(trustAnchorPath, expectedUid, expectedGid, 0o400, 65);
    const trustAnchor = trustAnchorFile.body.endsWith('\n')
      ? trustAnchorFile.body.slice(0, -1)
      : trustAnchorFile.body;
    if (!TRUST_ANCHOR_PATTERN.test(trustAnchor)) {
      throw new TypeError('hosted-lifecycle-owner-admission-trust-anchor-invalid');
    }
    const proofKeyId = createHash('sha256').update(Buffer.from(trustAnchor, 'hex')).digest('hex');
    const releasePinFile = readSecureFile(
      releasePinPath,
      expectedUid,
      expectedGid,
      0o400,
      MAXIMUM_RELEASE_PIN_BYTES
    );
    const releasePin = parseReleasePin(releasePinFile.body);
    assertLifecycleTrustDirectoryLayout({
      trustAnchorPath,
      releasePinPath,
      expectedUid,
      expectedGid,
    });

    const socketIdentity = assertOwnerRunDirectoryLayout({
      manifestPath,
      socketPath,
      expectedUid,
      expectedGid,
    });
    const manifest = readSecureFile(
      manifestPath,
      expectedUid,
      expectedGid,
      0o400,
      MAXIMUM_MANIFEST_BYTES
    );
    const payload = authenticateAdmissionManifest(manifest.body, releasePin);
    const parsed = parseAdmissionPayload(payload, socketPath);
    assertSameSocketIdentity(parsed.expectedOwnerBinding.socketIdentity, socketIdentity);
    assertSocketStillCurrent(socketPath, socketIdentity);
    assertBootstrapBinding(
      parsed.bootstrapBinding,
      serializedBootstrap,
      parsed.artifact.artifactDigest,
      proofKeyId
    );

    if (!sameReleasePin(releasePin, parsed.artifact)) {
      throw new TypeError('hosted-lifecycle-owner-admission-release-pin-missing');
    }
    assertSameSocketIdentity(
      socketIdentity,
      assertOwnerRunDirectoryLayout({ manifestPath, socketPath, expectedUid, expectedGid })
    );
    return Object.freeze({
      artifactDigest: parsed.artifact.artifactDigest,
      imageReference: parsed.artifact.imageReference,
      artifactVersion: parsed.artifact.artifactVersion,
      protocolVersion: parsed.artifact.protocolVersion,
      launcherPublicKey: releasePin.launcherPublicKey,
      launcherKeyId: releasePin.launcherKeyId,
      ownerAuthority: parsed.expectedOwnerBinding.ownerAuthority,
      expectedOwnerBinding: parsed.expectedOwnerBinding,
      bootstrapBinding: parsed.bootstrapBinding,
      manifestDigest: manifest.digest,
      releasePinDigest: releasePinFile.digest,
    });
  } catch {
    return null;
  }
}

function parseExpectedIdentity(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError('hosted-lifecycle-owner-admission-identity-invalid');
  }
  return value;
}

function assertFixedEnvironmentPath(actual: unknown, expected: string): void {
  assertCanonicalAbsolutePath(expected);
  if (actual !== expected) {
    throw new TypeError('hosted-lifecycle-owner-admission-path-invalid');
  }
}

function assertCanonicalAbsolutePath(path: string): void {
  if (
    typeof path !== 'string' ||
    path.includes('\0') ||
    !isAbsolute(path) ||
    resolve(path) !== path ||
    normalize(path) !== path
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-path-invalid');
  }
}

function readSecureFile(
  path: string,
  expectedUid: number,
  expectedGid: number,
  expectedMode: number,
  maximumBytes: number
): SecureFileSnapshot {
  assertCanonicalAbsolutePath(path);
  const before = lstatSync(path, { bigint: true });
  const descriptor = openSync(
    path,
    constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  );
  try {
    const opened = fstatSync(descriptor, { bigint: true });
    assertSecureFileStat(opened, expectedUid, expectedGid, expectedMode, maximumBytes);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino
    ) {
      throw new TypeError('hosted-lifecycle-owner-admission-file-substituted');
    }
    const bytes = Buffer.alloc(Number(opened.size));
    const bytesRead = readSync(descriptor, bytes, 0, bytes.byteLength, 0);
    const after = fstatSync(descriptor, { bigint: true });
    const membership = lstatSync(path, { bigint: true });
    assertSecureFileStat(after, expectedUid, expectedGid, expectedMode, maximumBytes);
    if (
      bytesRead !== bytes.byteLength ||
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.size !== after.size ||
      opened.mtimeNs !== after.mtimeNs ||
      opened.ctimeNs !== after.ctimeNs ||
      membership.isSymbolicLink() ||
      membership.dev !== after.dev ||
      membership.ino !== after.ino
    ) {
      throw new TypeError('hosted-lifecycle-owner-admission-file-substituted');
    }
    return Object.freeze({
      body: bytes.toString('utf8'),
      digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
    });
  } finally {
    closeSync(descriptor);
  }
}

function assertSecureFileStat(
  stat: BigIntStats,
  expectedUid: number,
  expectedGid: number,
  expectedMode: number,
  maximumBytes: number
): void {
  if (
    !stat.isFile() ||
    stat.nlink !== 1n ||
    stat.uid !== BigInt(expectedUid) ||
    stat.gid !== BigInt(expectedGid) ||
    Number(stat.mode & 0o777n) !== expectedMode ||
    stat.size < 1n ||
    stat.size > BigInt(maximumBytes)
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-file-invalid');
  }
}

function assertOwnerRunDirectoryLayout(input: {
  readonly manifestPath: string;
  readonly socketPath: string;
  readonly expectedUid: number;
  readonly expectedGid: number;
}): OrchestratorSocketIdentity {
  const runDirectory = dirname(input.manifestPath);
  if (dirname(input.socketPath) !== runDirectory) {
    throw new TypeError('hosted-lifecycle-owner-admission-layout-invalid');
  }
  const directoryStat = lstatSync(runDirectory, { bigint: true });
  if (
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    directoryStat.uid !== BigInt(input.expectedUid) ||
    directoryStat.gid !== BigInt(input.expectedGid) ||
    Number(directoryStat.mode & 0o777n) !== 0o700
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-layout-invalid');
  }
  const expectedNames = [basename(input.manifestPath), basename(input.socketPath)].sort();
  const entries = readdirSync(runDirectory, { withFileTypes: true });
  if (
    entries.length !== expectedNames.length ||
    entries
      .map((entry) => entry.name)
      .sort()
      .some((name, index) => name !== expectedNames[index])
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-layout-invalid');
  }
  const manifestEntry = entries.find((entry) => entry.name === basename(input.manifestPath));
  const socketEntry = entries.find((entry) => entry.name === basename(input.socketPath));
  if (manifestEntry?.isFile() !== true || socketEntry?.isSocket() !== true) {
    throw new TypeError('hosted-lifecycle-owner-admission-layout-invalid');
  }
  return readSocketIdentity(input.socketPath, input.expectedUid, input.expectedGid);
}

function assertLifecycleTrustDirectoryLayout(input: {
  readonly trustAnchorPath: string;
  readonly releasePinPath: string;
  readonly expectedUid: number;
  readonly expectedGid: number;
}): void {
  assertCanonicalAbsolutePath(input.trustAnchorPath);
  assertCanonicalAbsolutePath(input.releasePinPath);
  const trustDirectory = dirname(input.trustAnchorPath);
  if (
    dirname(input.releasePinPath) !== trustDirectory ||
    input.releasePinPath === input.trustAnchorPath
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-trust-layout-invalid');
  }
  const directoryStat = lstatSync(trustDirectory, { bigint: true });
  if (
    directoryStat.isSymbolicLink() ||
    !directoryStat.isDirectory() ||
    directoryStat.uid !== BigInt(input.expectedUid) ||
    directoryStat.gid !== BigInt(input.expectedGid) ||
    Number(directoryStat.mode & 0o777n) !== 0o700
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-trust-layout-invalid');
  }
  const expectedNames = [basename(input.trustAnchorPath), basename(input.releasePinPath)].sort();
  const entries = readdirSync(trustDirectory, { withFileTypes: true });
  if (
    entries.length !== expectedNames.length ||
    entries.some((entry) => !entry.isFile()) ||
    entries
      .map((entry) => entry.name)
      .sort()
      .some((name, index) => name !== expectedNames[index])
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-trust-layout-invalid');
  }
}

function readSocketIdentity(
  path: string,
  expectedUid: number,
  expectedGid: number
): OrchestratorSocketIdentity {
  const stat = lstatSync(path, { bigint: true });
  if (
    stat.isSymbolicLink() ||
    !stat.isSocket() ||
    stat.uid !== BigInt(expectedUid) ||
    stat.gid !== BigInt(expectedGid) ||
    Number(stat.mode & 0o777n) !== 0o600
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-socket-invalid');
  }
  return Object.freeze({
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: Number(stat.mode & 0o777n),
  });
}

function assertSocketStillCurrent(path: string, expected: OrchestratorSocketIdentity): void {
  assertSameSocketIdentity(expected, readSocketIdentity(path, expected.uid, expected.gid));
}

function authenticateAdmissionManifest(
  serialized: string,
  releasePin: HostedLifecycleReleaseOwnerPin
): string {
  const canonicalEnvelope = serialized.endsWith('\n') ? serialized.slice(0, -1) : serialized;
  const parsedEnvelope = JSON.parse(canonicalEnvelope) as unknown;
  if (JSON.stringify(parsedEnvelope) !== canonicalEnvelope) {
    throw new TypeError('hosted-lifecycle-owner-admission-manifest-noncanonical');
  }
  const envelope = readExactRecord(parsedEnvelope, ['format', 'payload', 'authentication']);
  const authentication = readExactRecord(envelope.authentication, [
    'algorithm',
    'launcherKeyId',
    'signature',
  ]);
  if (
    envelope.format !== HOSTED_LIFECYCLE_OWNER_ADMISSION_FORMAT ||
    typeof envelope.payload !== 'string' ||
    envelope.payload.length === 0 ||
    Buffer.byteLength(envelope.payload, 'utf8') > MAXIMUM_PAYLOAD_BYTES ||
    authentication.algorithm !== 'ed25519' ||
    authentication.launcherKeyId !== releasePin.launcherKeyId ||
    typeof authentication.signature !== 'string' ||
    !ED25519_SIGNATURE_PATTERN.test(authentication.signature)
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-manifest-invalid');
  }
  const signature = decodeCanonicalBase64Url(authentication.signature, 64);
  const launcherPublicKey = createPublicKey({
    key: {
      kty: 'OKP',
      crv: 'Ed25519',
      x: releasePin.launcherPublicKey,
    },
    format: 'jwk',
  });
  if (
    !verify(
      null,
      Buffer.from(
        `${HOSTED_LIFECYCLE_OWNER_ADMISSION_SIGNATURE_DOMAIN}\u0000${envelope.payload}`,
        'utf8'
      ),
      launcherPublicKey,
      signature
    )
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-manifest-unauthenticated');
  }
  return envelope.payload;
}

function decodeCanonicalBase64Url(value: string, expectedBytes: number): Buffer {
  const decoded = Buffer.from(value, 'base64url');
  if (decoded.byteLength !== expectedBytes || decoded.toString('base64url') !== value) {
    throw new TypeError('hosted-lifecycle-owner-admission-key-encoding-invalid');
  }
  return decoded;
}

function parseAdmissionPayload(
  serialized: string,
  expectedSocketPath: string
): ParsedAdmissionPayload {
  const parsedPayload = JSON.parse(serialized) as unknown;
  if (JSON.stringify(parsedPayload) !== serialized) {
    throw new TypeError('hosted-lifecycle-owner-admission-payload-noncanonical');
  }
  const payload = readExactRecord(parsedPayload, [
    'format',
    'artifact',
    'ownerBinding',
    'bootstrapBinding',
    'socketPath',
  ]);
  if (
    payload.format !== HOSTED_LIFECYCLE_OWNER_ADMISSION_PAYLOAD_FORMAT ||
    payload.socketPath !== expectedSocketPath
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-payload-invalid');
  }
  const artifact = parseOwnerArtifact(payload.artifact);
  const expectedOwnerBinding = parseOwnerBinding(payload.ownerBinding);
  const bootstrapBinding = parseBootstrapBinding(payload.bootstrapBinding);
  if (bootstrapBinding.ownerArtifactDigest !== artifact.artifactDigest) {
    throw new TypeError('hosted-lifecycle-owner-admission-artifact-binding-invalid');
  }
  return Object.freeze({ artifact, expectedOwnerBinding, bootstrapBinding });
}

function parseOwnerArtifact(value: unknown): ParsedOwnerArtifact {
  const artifact = readExactRecord(value, [
    'artifactDigest',
    'imageReference',
    'artifactVersion',
    'protocolVersion',
  ]);
  if (
    typeof artifact.artifactDigest !== 'string' ||
    !ARTIFACT_DIGEST_PATTERN.test(artifact.artifactDigest) ||
    typeof artifact.imageReference !== 'string' ||
    !IMAGE_REFERENCE_PATTERN.test(artifact.imageReference) ||
    !artifact.imageReference.endsWith(`@${artifact.artifactDigest}`) ||
    typeof artifact.artifactVersion !== 'string' ||
    !ARTIFACT_VERSION_PATTERN.test(artifact.artifactVersion) ||
    !Number.isSafeInteger(artifact.protocolVersion) ||
    (artifact.protocolVersion as number) < 1 ||
    (artifact.protocolVersion as number) > 65_535
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-artifact-invalid');
  }
  return Object.freeze({
    artifactDigest: artifact.artifactDigest as `sha256:${string}`,
    imageReference: artifact.imageReference,
    artifactVersion: artifact.artifactVersion,
    protocolVersion: artifact.protocolVersion as number,
  });
}

function parseReleasePin(serialized: string): HostedLifecycleReleaseOwnerPin {
  const canonical = serialized.endsWith('\n') ? serialized.slice(0, -1) : serialized;
  const parsed = JSON.parse(canonical) as unknown;
  if (JSON.stringify(parsed) !== canonical) {
    throw new TypeError('hosted-lifecycle-owner-admission-release-pin-noncanonical');
  }
  const envelope = readExactRecord(parsed, ['format', 'artifact', 'launcher']);
  if (envelope.format !== HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FORMAT) {
    throw new TypeError('hosted-lifecycle-owner-admission-release-pin-invalid');
  }
  const artifact = parseOwnerArtifact(envelope.artifact);
  const launcher = readExactRecord(envelope.launcher, ['algorithm', 'publicKey', 'keyId']);
  if (
    launcher.algorithm !== 'ed25519' ||
    typeof launcher.publicKey !== 'string' ||
    !ED25519_PUBLIC_KEY_PATTERN.test(launcher.publicKey) ||
    typeof launcher.keyId !== 'string' ||
    !SHA256_PATTERN.test(launcher.keyId)
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-release-pin-invalid');
  }
  const publicKeyBytes = decodeCanonicalBase64Url(launcher.publicKey, 32);
  const expectedKeyId = createHash('sha256').update(publicKeyBytes).digest('hex');
  if (launcher.keyId !== expectedKeyId) {
    throw new TypeError('hosted-lifecycle-owner-admission-release-pin-invalid');
  }
  return Object.freeze({
    ...artifact,
    launcherPublicKey: launcher.publicKey,
    launcherKeyId: launcher.keyId,
  });
}

function parseOwnerBinding(value: unknown): OrchestratorLifecycleOwnerBinding {
  const binding = readExactRecord(value, [
    'ownerAuthority',
    'ownerGeneration',
    'ownerSessionId',
    'socketIdentity',
  ]);
  if (
    typeof binding.ownerAuthority !== 'string' ||
    !OWNER_AUTHORITY_PATTERN.test(binding.ownerAuthority) ||
    !Number.isSafeInteger(binding.ownerGeneration) ||
    (binding.ownerGeneration as number) < 1 ||
    (binding.ownerGeneration as number) >= HOSTED_LIFECYCLE_OWNER_GENERATION_LIMIT ||
    typeof binding.ownerSessionId !== 'string' ||
    !OWNER_SESSION_PATTERN.test(binding.ownerSessionId)
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-owner-binding-invalid');
  }
  return Object.freeze({
    ownerAuthority: binding.ownerAuthority,
    ownerGeneration: binding.ownerGeneration as number,
    ownerSessionId: binding.ownerSessionId,
    socketIdentity: parseSocketIdentity(binding.socketIdentity),
  });
}

function parseSocketIdentity(value: unknown): OrchestratorSocketIdentity {
  const identity = readExactRecord(value, ['device', 'inode', 'uid', 'gid', 'mode']);
  if (
    typeof identity.device !== 'string' ||
    !DECIMAL_ID_PATTERN.test(identity.device) ||
    typeof identity.inode !== 'string' ||
    !DECIMAL_ID_PATTERN.test(identity.inode) ||
    !Number.isSafeInteger(identity.uid) ||
    (identity.uid as number) < 0 ||
    !Number.isSafeInteger(identity.gid) ||
    (identity.gid as number) < 0 ||
    identity.mode !== 0o600
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-socket-identity-invalid');
  }
  return Object.freeze({
    device: identity.device,
    inode: identity.inode,
    uid: identity.uid as number,
    gid: identity.gid as number,
    mode: 0o600,
  });
}

function parseBootstrapBinding(value: unknown): OrchestratorLifecycleBootstrapBinding {
  const binding = readExactRecord(value, [
    'deploymentId',
    'bootId',
    'workspaceId',
    'mountGeneration',
    'bootstrapDigest',
    'ownerArtifactDigest',
    'proofKeyId',
  ]);
  if (
    typeof binding.deploymentId !== 'string' ||
    !HOSTED_ID_PATTERN.test(binding.deploymentId) ||
    typeof binding.bootId !== 'string' ||
    !HOSTED_ID_PATTERN.test(binding.bootId) ||
    typeof binding.workspaceId !== 'string' ||
    !HOSTED_ID_PATTERN.test(binding.workspaceId) ||
    !Number.isSafeInteger(binding.mountGeneration) ||
    (binding.mountGeneration as number) < 1 ||
    typeof binding.bootstrapDigest !== 'string' ||
    !SHA256_PATTERN.test(binding.bootstrapDigest) ||
    typeof binding.ownerArtifactDigest !== 'string' ||
    !ARTIFACT_DIGEST_PATTERN.test(binding.ownerArtifactDigest) ||
    typeof binding.proofKeyId !== 'string' ||
    !SHA256_PATTERN.test(binding.proofKeyId)
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-bootstrap-binding-invalid');
  }
  return Object.freeze({
    deploymentId: binding.deploymentId,
    bootId: binding.bootId,
    workspaceId: binding.workspaceId,
    mountGeneration: binding.mountGeneration as number,
    bootstrapDigest: binding.bootstrapDigest,
    ownerArtifactDigest: binding.ownerArtifactDigest,
    proofKeyId: binding.proofKeyId,
  });
}

function assertBootstrapBinding(
  binding: OrchestratorLifecycleBootstrapBinding,
  serializedBootstrap: string,
  artifactDigest: string,
  proofKeyId: string
): void {
  const digest = createHash('sha256').update(serializedBootstrap, 'utf8').digest('hex');
  const parsedBootstrap = JSON.parse(serializedBootstrap) as unknown;
  if (JSON.stringify(parsedBootstrap) !== serializedBootstrap) {
    throw new TypeError('hosted-lifecycle-owner-admission-bootstrap-noncanonical');
  }
  const bootstrap = readExactRecord(parsedBootstrap, [
    'format',
    'issuedAtMs',
    'expiresAtMs',
    'actorId',
    'authorizedScope',
    'deploymentId',
    'bootId',
    'workspaceId',
    'runtimeInstance',
    'workspaceManifest',
  ]);
  if (
    binding.bootstrapDigest !== digest ||
    binding.ownerArtifactDigest !== artifactDigest ||
    binding.proofKeyId !== proofKeyId ||
    bootstrap.deploymentId !== binding.deploymentId ||
    bootstrap.bootId !== binding.bootId ||
    bootstrap.workspaceId !== binding.workspaceId
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-bootstrap-binding-invalid');
  }
  const manifest = readExactRecord(bootstrap.workspaceManifest, ['version', 'registrations']);
  if (manifest.version !== 1 || !Array.isArray(manifest.registrations)) {
    throw new TypeError('hosted-lifecycle-owner-admission-bootstrap-binding-invalid');
  }
  const matches = manifest.registrations.filter((registration) => {
    if (typeof registration !== 'object' || registration === null || Array.isArray(registration)) {
      return false;
    }
    const candidate = registration as Record<string, unknown>;
    if (candidate.workspaceId !== binding.workspaceId) return false;
    const mount = candidate.mountBinding;
    return (
      typeof mount === 'object' &&
      mount !== null &&
      !Array.isArray(mount) &&
      (mount as Record<string, unknown>).bootId === binding.bootId &&
      (mount as Record<string, unknown>).mountGeneration === binding.mountGeneration
    );
  });
  if (matches.length !== 1) {
    throw new TypeError('hosted-lifecycle-owner-admission-bootstrap-binding-invalid');
  }
}

function sameReleasePin(
  candidate: HostedLifecycleReleaseOwnerPin,
  artifact: ParsedOwnerArtifact
): boolean {
  return (
    candidate.artifactDigest === artifact.artifactDigest &&
    candidate.imageReference === artifact.imageReference &&
    candidate.artifactVersion === artifact.artifactVersion &&
    candidate.protocolVersion === artifact.protocolVersion
  );
}

function assertSameSocketIdentity(
  left: OrchestratorSocketIdentity,
  right: OrchestratorSocketIdentity
): void {
  if (
    left.device !== right.device ||
    left.inode !== right.inode ||
    left.uid !== right.uid ||
    left.gid !== right.gid ||
    left.mode !== right.mode
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-socket-substituted');
  }
}

function readExactRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('hosted-lifecycle-owner-admission-record-invalid');
  }
  const source = value as Record<string, unknown>;
  const actualKeys = Reflect.ownKeys(source);
  if (
    actualKeys.length !== keys.length ||
    actualKeys.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
    keys.some((key) => !Object.hasOwn(source, key))
  ) {
    throw new TypeError('hosted-lifecycle-owner-admission-record-invalid');
  }
  const snapshot: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(source, key);
    if (!descriptor?.enumerable || !('value' in descriptor)) {
      throw new TypeError('hosted-lifecycle-owner-admission-record-invalid');
    }
    snapshot[key] = descriptor.value;
  }
  return snapshot;
}
