import {
  createHash,
  createHmac,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  sign,
  timingSafeEqual,
} from 'node:crypto';
import { constants } from 'node:fs';
import {
  chmod,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  unlink,
  writeFile,
} from 'node:fs/promises';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createServer as createNetServer, type Socket } from 'node:net';

const TEAM_NAME = 'sandbox-hosted-team';
const TEAM_ID = `team_${'a'.repeat(32)}`;
const PUBLIC_WORKSPACE_ID = `workspace_${'c'.repeat(32)}`;
const RUNTIME_WORKSPACE_ID = `workspace_${'b'.repeat(32)}`;
const LEGACY_RUNTIME_WORKSPACE_ID = '-workspaces-sandbox';
const LEGACY_PUBLIC_WORKSPACE_ID = `workspace_${'d'.repeat(32)}`;
const ADOPTION_ID = `adoption_${'b'.repeat(32)}`;
const CREATED_AT = '2026-08-06T12:00:00.000Z';
const PUBLISHED_AT = '2026-08-06T12:00:10.000Z';
const COMMITTED_AT = '2026-08-06T12:00:20.000Z';
const DEPLOYMENT_ID = 'deployment_hosted-v1-e2e';
const CLAUDE_ROOT = process.env.E2E_SEED_CLAUDE_ROOT ?? '/data/.claude';
const APP_DATA_ROOT = process.env.E2E_SEED_APP_DATA_ROOT ?? '/data/.agent-teams';
const FAKE_RUNTIME_STATE_ROOT = process.env.E2E_FAKE_RUNTIME_STATE_ROOT ?? '/e2e-state';
const FAKE_RUNTIME_LIFECYCLE_TRACE_PATH = `${FAKE_RUNTIME_STATE_ROOT}/lifecycle-trace.json`;
const FAKE_RUNTIME_OWNER_MUTATION_ERROR_TRACE_PATH = `${FAKE_RUNTIME_STATE_ROOT}/owner-mutation-error-trace.json`;
const MAX_FAKE_RUNTIME_OWNER_MUTATION_ERROR_TRACE_ENTRIES = 32;
const SAFE_FAKE_RUNTIME_OWNER_MUTATION_ERROR = /^(?:fake_runtime|hosted_e2e)_[a-z0-9_]{1,127}$/u;
const FAKE_RUNTIME_OWNER_MUTATION_INTERNAL_ERROR = 'fake_runtime_task_mutation_internal_error';
const FAKE_RUNTIME_OWNER_GENERATION_PURPOSE = 'agent-teams.hosted-v1-e2e.owner-generation/v1';
const FAKE_RUNTIME_MOUNT_GENERATION_PURPOSE = 'agent-teams.hosted-v1-e2e.mount-generation/v1';
const MAX_FAKE_RUNTIME_OWNER_GENERATION = 1_000_000;
const AUTH_DATA_ROOT = `${APP_DATA_ROOT}/data`;
const OWNER_PROOF_DOMAIN = 'agent-teams.hosted-lifecycle.owner-proof/v1';
const MESSAGE_OWNER_PROOF_DOMAIN = 'agent-teams.hosted-team-message.owner-proof/v1';
const CLIENT_MESSAGE_ID_PATTERN = /^client_message_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const MAX_FAKE_RUNTIME_FRAME_BYTES = 64 * 1024;
const LIFECYCLE_RUN_ROOT = process.env.E2E_LIFECYCLE_RUN_ROOT ?? '/run/agent-teams-orchestrator';
const AUTH_DRAIN_ROOT = process.env.E2E_AUTH_DRAIN_ROOT ?? '/run/agent-teams-auth-drain';
const LIFECYCLE_TRUST_ROOT =
  process.env.E2E_LIFECYCLE_TRUST_ROOT ?? '/run/agent-teams-lifecycle-trust';
const LIFECYCLE_LAUNCHER_ROOT =
  process.env.E2E_LIFECYCLE_LAUNCHER_ROOT ?? '/run/agent-teams-lifecycle-launcher';
const LIFECYCLE_SOCKET_PATH = `${LIFECYCLE_RUN_ROOT}/orchestrator-lifecycle.sock`;
const AUTH_DRAIN_SOCKET_PATH = `${AUTH_DRAIN_ROOT}/auth-drain.sock`;
const AUTH_DRAIN_EVIDENCE_PATH = `${AUTH_DRAIN_ROOT}/drain-proof.json`;
const LIFECYCLE_OWNER_MANIFEST_PATH = `${LIFECYCLE_RUN_ROOT}/lifecycle-owner-admission.json`;
const LIFECYCLE_TRUST_ANCHOR_PATH = `${LIFECYCLE_TRUST_ROOT}/trust-anchor`;
const LIFECYCLE_RELEASE_PIN_PATH = `${LIFECYCLE_TRUST_ROOT}/release-owner-pin.json`;
const LIFECYCLE_LAUNCHER_PRIVATE_KEY_PATH =
  `${LIFECYCLE_LAUNCHER_ROOT}/owner-admission-private-key.pem`;
const LIFECYCLE_OWNER_ADMISSION_DOMAIN = 'agent-teams.hosted-lifecycle-owner-admission/v2';

export interface FakeRuntimeLifecycleOwnerArtifact {
  readonly artifactDigest: string;
  readonly imageReference: string;
  readonly artifactVersion: string;
  readonly protocolVersion: number;
}

export interface FakeRuntimeLifecycleReleasePin {
  readonly artifact: FakeRuntimeLifecycleOwnerArtifact;
  readonly launcherPublicKey: string;
  readonly launcherKeyId: string;
}

export interface FakeRuntimeSocketIdentity {
  readonly device: string;
  readonly inode: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

export function fakeRuntimeBootstrapMountGeneration(bootstrap: string, bootId: string): number {
  let value: unknown;
  try {
    value = JSON.parse(bootstrap);
  } catch {
    throw new Error('hosted_e2e_lifecycle_bootstrap_invalid');
  }
  if (
    JSON.stringify(value) !== bootstrap ||
    !isRecord(value) ||
    value.deploymentId !== DEPLOYMENT_ID ||
    value.bootId !== bootId ||
    value.workspaceId !== RUNTIME_WORKSPACE_ID ||
    !isRecord(value.workspaceManifest) ||
    !Array.isArray(value.workspaceManifest.registrations)
  ) {
    throw new Error('hosted_e2e_lifecycle_bootstrap_invalid');
  }
  const registrations = value.workspaceManifest.registrations.filter((registration) => {
    if (!isRecord(registration) || !isRecord(registration.mountBinding)) return false;
    return (
      registration.workspaceId === RUNTIME_WORKSPACE_ID &&
      registration.mountBinding.bootId === bootId
    );
  });
  const mountGeneration = registrations[0]?.mountBinding;
  if (
    registrations.length !== 1 ||
    !isRecord(mountGeneration) ||
    !Number.isSafeInteger(mountGeneration.mountGeneration) ||
    (mountGeneration.mountGeneration as number) < 1
  ) {
    throw new Error('hosted_e2e_lifecycle_bootstrap_invalid');
  }
  return mountGeneration.mountGeneration as number;
}

async function readFakeRuntimePrivateFile(path: string, maximumBytes: number): Promise<string> {
  const before = await lstat(path, { bigint: true });
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const opened = await handle.stat({ bigint: true });
    const expectedUid = BigInt(process.getuid?.() ?? 1000);
    const expectedGid = BigInt(process.getgid?.() ?? 1000);
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      !opened.isFile() ||
      before.dev !== opened.dev ||
      before.ino !== opened.ino ||
      opened.nlink !== 1n ||
      opened.uid !== expectedUid ||
      opened.gid !== expectedGid ||
      Number(opened.mode & 0o777n) !== 0o400 ||
      opened.size < 1n ||
      opened.size > BigInt(maximumBytes)
    ) {
      throw new Error('hosted_e2e_lifecycle_trust_file_invalid');
    }
    const body = await handle.readFile('utf8');
    const after = await handle.stat({ bigint: true });
    const membership = await lstat(path, { bigint: true });
    if (
      opened.dev !== after.dev ||
      opened.ino !== after.ino ||
      opened.size !== after.size ||
      opened.mtimeNs !== after.mtimeNs ||
      opened.ctimeNs !== after.ctimeNs ||
      membership.isSymbolicLink() ||
      membership.dev !== after.dev ||
      membership.ino !== after.ino ||
      Buffer.byteLength(body, 'utf8') !== Number(after.size)
    ) {
      throw new Error('hosted_e2e_lifecycle_trust_file_substituted');
    }
    return body;
  } finally {
    await handle.close();
  }
}

async function lifecycleTrustAnchor(): Promise<string> {
  if (
    process.env.HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR_FILE !== LIFECYCLE_TRUST_ANCHOR_PATH ||
    process.env.HOSTED_LIFECYCLE_ORCHESTRATOR_TRUST_ANCHOR !== undefined
  ) {
    throw new Error('hosted_e2e_lifecycle_trust_anchor_invalid');
  }
  const serialized = await readFakeRuntimePrivateFile(LIFECYCLE_TRUST_ANCHOR_PATH, 65);
  const value = serialized.endsWith('\n') ? serialized.slice(0, -1) : serialized;
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error('hosted_e2e_lifecycle_trust_anchor_invalid');
  }
  return value;
}

async function lifecycleOwnerReleasePin(): Promise<FakeRuntimeLifecycleReleasePin> {
  if (process.env.HOSTED_LIFECYCLE_OWNER_RELEASE_PIN_FILE !== LIFECYCLE_RELEASE_PIN_PATH) {
    throw new Error('hosted_e2e_lifecycle_release_pin_invalid');
  }
  const serializedWithNewline = await readFakeRuntimePrivateFile(LIFECYCLE_RELEASE_PIN_PATH, 1_024);
  const serialized = serializedWithNewline.endsWith('\n')
    ? serializedWithNewline.slice(0, -1)
    : serializedWithNewline;
  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch {
    throw new Error('hosted_e2e_lifecycle_release_pin_invalid');
  }
  if (JSON.stringify(value) !== serialized || !isRecord(value)) {
    throw new Error('hosted_e2e_lifecycle_release_pin_invalid');
  }
  const artifact = value.artifact;
  const launcher = value.launcher;
  if (
    !hasExactKeys(value, ['format', 'artifact', 'launcher']) ||
    value.format !== 'agent-teams.hosted-lifecycle-owner-release-pin/v2' ||
    !isRecord(artifact) ||
    !hasExactKeys(artifact, [
      'artifactDigest',
      'imageReference',
      'artifactVersion',
      'protocolVersion',
    ]) ||
    typeof artifact.artifactDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(artifact.artifactDigest) ||
    typeof artifact.imageReference !== 'string' ||
    !artifact.imageReference.endsWith(`@${artifact.artifactDigest}`) ||
    typeof artifact.artifactVersion !== 'string' ||
    !/^1\.0\.0-e2e$/u.test(artifact.artifactVersion) ||
    artifact.protocolVersion !== 2 ||
    !isRecord(launcher) ||
    !hasExactKeys(launcher, ['algorithm', 'publicKey', 'keyId']) ||
    launcher.algorithm !== 'ed25519' ||
    typeof launcher.publicKey !== 'string' ||
    !/^[A-Za-z0-9_-]{43}$/u.test(launcher.publicKey) ||
    typeof launcher.keyId !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(launcher.keyId) ||
    sha256(Buffer.from(launcher.publicKey, 'base64url')) !== launcher.keyId
  ) {
    throw new Error('hosted_e2e_lifecycle_release_pin_invalid');
  }
  return Object.freeze({
    artifact: Object.freeze({
      artifactDigest: artifact.artifactDigest,
      imageReference: artifact.imageReference,
      artifactVersion: artifact.artifactVersion,
      protocolVersion: artifact.protocolVersion,
    }),
    launcherPublicKey: launcher.publicKey,
    launcherKeyId: launcher.keyId,
  });
}

async function lifecycleLauncherPrivateKey(
  releasePin: FakeRuntimeLifecycleReleasePin
): Promise<string> {
  const serialized = await readFakeRuntimePrivateFile(LIFECYCLE_LAUNCHER_PRIVATE_KEY_PATH, 2_048);
  const privateKey = createPrivateKey(serialized);
  const publicJwk = createPublicKey(privateKey).export({ format: 'jwk' });
  if (
    publicJwk.kty !== 'OKP' ||
    publicJwk.crv !== 'Ed25519' ||
    publicJwk.x !== releasePin.launcherPublicKey ||
    sha256(Buffer.from(releasePin.launcherPublicKey, 'base64url')) !== releasePin.launcherKeyId
  ) {
    throw new Error('hosted_e2e_lifecycle_launcher_private_key_invalid');
  }
  return serialized;
}

export function fakeRuntimeLifecycleOwnerAdmissionManifest(input: {
  readonly artifact: FakeRuntimeLifecycleOwnerArtifact;
  readonly bootstrap: string;
  readonly launcherKeyId: string;
  readonly launcherPrivateKey: string;
  readonly launcherPublicKey: string;
  readonly mountGeneration: number;
  readonly ownerGeneration: number;
  readonly socketIdentity: FakeRuntimeSocketIdentity;
  readonly trustAnchor: string;
}): Readonly<{
  readonly bootstrapBinding: Readonly<Record<string, unknown>>;
  readonly ownerBinding: Readonly<Record<string, unknown>>;
  readonly serializedManifest: string;
}> {
  const bootstrapValue: unknown = JSON.parse(input.bootstrap);
  if (
    JSON.stringify(bootstrapValue) !== input.bootstrap ||
    !isRecord(bootstrapValue) ||
    bootstrapValue.deploymentId !== DEPLOYMENT_ID ||
    typeof bootstrapValue.bootId !== 'string' ||
    bootstrapValue.workspaceId !== RUNTIME_WORKSPACE_ID ||
    !Number.isSafeInteger(input.mountGeneration) ||
    input.mountGeneration < 1 ||
    !Number.isSafeInteger(input.ownerGeneration) ||
    input.ownerGeneration < 1 ||
    input.ownerGeneration >= MAX_FAKE_RUNTIME_OWNER_GENERATION ||
    !/^[0-9a-f]{64}$/u.test(input.trustAnchor) ||
    !/^[0-9a-f]{64}$/u.test(input.launcherKeyId) ||
    !/^[A-Za-z0-9_-]{43}$/u.test(input.launcherPublicKey) ||
    sha256(Buffer.from(input.launcherPublicKey, 'base64url')) !== input.launcherKeyId ||
    !/^sha256:[0-9a-f]{64}$/u.test(input.artifact.artifactDigest) ||
    !input.artifact.imageReference.endsWith(`@${input.artifact.artifactDigest}`) ||
    input.artifact.artifactVersion !== '1.0.0-e2e' ||
    input.artifact.protocolVersion !== 2 ||
    !/^\d{1,32}$/u.test(input.socketIdentity.device) ||
    !/^\d{1,32}$/u.test(input.socketIdentity.inode) ||
    !Number.isSafeInteger(input.socketIdentity.uid) ||
    input.socketIdentity.uid < 0 ||
    !Number.isSafeInteger(input.socketIdentity.gid) ||
    input.socketIdentity.gid < 0 ||
    input.socketIdentity.mode !== 0o600
  ) {
    throw new Error('hosted_e2e_lifecycle_owner_manifest_input_invalid');
  }
  assertFakeRuntimeMountGenerationCurrent({
    expectedMountGeneration: input.mountGeneration,
    receivedMountGeneration: fakeRuntimeBootstrapMountGeneration(
      input.bootstrap,
      String(bootstrapValue.bootId)
    ),
  });
  const launcherPrivateKey = createPrivateKey(input.launcherPrivateKey);
  const launcherPublicJwk = createPublicKey(launcherPrivateKey).export({ format: 'jwk' });
  if (
    launcherPublicJwk.kty !== 'OKP' ||
    launcherPublicJwk.crv !== 'Ed25519' ||
    launcherPublicJwk.x !== input.launcherPublicKey
  ) {
    throw new Error('hosted_e2e_lifecycle_owner_manifest_input_invalid');
  }
  const marker = fakeRuntimeOwnerMarker(bootstrapValue.bootId);
  const proofKeyId = createHash('sha256')
    .update(Buffer.from(input.trustAnchor, 'hex'))
    .digest('hex');
  const bootstrapBinding = Object.freeze({
    deploymentId: DEPLOYMENT_ID,
    bootId: bootstrapValue.bootId,
    workspaceId: RUNTIME_WORKSPACE_ID,
    mountGeneration: input.mountGeneration,
    bootstrapDigest: sha256(input.bootstrap),
    ownerArtifactDigest: input.artifact.artifactDigest,
    proofKeyId,
  });
  const ownerBinding = Object.freeze({
    ownerAuthority: `owner-authority_hosted-v1-e2e-${marker}`,
    ownerGeneration: input.ownerGeneration,
    ownerSessionId: `owner-session_hosted-v1-e2e-${marker}-${input.ownerGeneration}`,
    socketIdentity: input.socketIdentity,
  });
  const payload = JSON.stringify({
    format: 'agent-teams.hosted-lifecycle-owner-admission-payload/v2',
    artifact: input.artifact,
    ownerBinding,
    bootstrapBinding,
    socketPath: LIFECYCLE_SOCKET_PATH,
  });
  const signature = sign(
    null,
    Buffer.from(`${LIFECYCLE_OWNER_ADMISSION_DOMAIN}\u0000${payload}`, 'utf8'),
    launcherPrivateKey
  ).toString('base64url');
  return Object.freeze({
    bootstrapBinding,
    ownerBinding,
    serializedManifest: `${JSON.stringify({
      format: LIFECYCLE_OWNER_ADMISSION_DOMAIN,
      payload,
      authentication: {
        algorithm: 'ed25519',
        launcherKeyId: input.launcherKeyId,
        signature,
      },
    })}\n`,
  });
}

export function fakeRuntimeReadinessSessionBinding(
  admittedOwnerBinding: Readonly<Record<string, unknown>>,
  expectedOwnerBinding: unknown
): Readonly<Record<string, unknown>> {
  if (
    !isRecord(expectedOwnerBinding) ||
    canonicalJson(expectedOwnerBinding) !== canonicalJson(admittedOwnerBinding) ||
    !isRecord(admittedOwnerBinding.socketIdentity)
  ) {
    throw new Error('fake_runtime_authenticated_owner_handoff_mismatch');
  }
  // Each lease gets a distinct object identity while retaining the one durable admitted value.
  // An older connection's close handler therefore cannot clear a newer retry lease.
  return Object.freeze({
    ...admittedOwnerBinding,
    socketIdentity: Object.freeze({ ...admittedOwnerBinding.socketIdentity }),
  });
}

export function createFakeRuntimeReadinessLeasePublication(owner: {
  binding: Record<string, unknown> | null;
}): Readonly<{
  publish(binding: Record<string, unknown>): void;
  close(): void;
}> {
  let connectionClosed = false;
  let publishedBinding: Record<string, unknown> | null = null;
  return Object.freeze({
    publish(binding: Record<string, unknown>): void {
      if (connectionClosed) {
        throw new Error('fake_runtime_readiness_connection_closed');
      }
      publishedBinding = binding;
      owner.binding = binding;
    },
    close(): void {
      connectionClosed = true;
      if (publishedBinding !== null && owner.binding === publishedBinding) {
        owner.binding = null;
      }
    },
  });
}

/** Installs idempotent readiness revocation on both terminal socket events before frame handling. */
export function registerFakeRuntimeReadinessLeaseCleanup(
  connection: Readonly<{
    once(event: 'close' | 'error', listener: (error?: unknown) => void): unknown;
  }>,
  closeLease: () => void
): void {
  let closed = false;
  const cleanup = (): void => {
    if (closed) return;
    closed = true;
    closeLease();
  };
  connection.once('close', cleanup);
  // An explicit error listener is required: destroy(error) may emit error before close, and an
  // unhandled socket error must never strand the already-published owner binding or crash the
  // fixture process before revocation.
  connection.once('error', cleanup);
}

export function fakeRuntimeLifecycleProof(
  trustAnchor: string,
  direction: 'readiness' | 'readiness-request' | 'request' | 'response',
  envelope: Record<string, unknown> | string
): string {
  const serializedEnvelope = typeof envelope === 'string' ? envelope : JSON.stringify(envelope);
  return createHmac('sha256', Buffer.from(trustAnchor, 'hex'))
    .update(`${OWNER_PROOF_DOMAIN}\u0000${direction}\u0000${serializedEnvelope}`)
    .digest('hex');
}

function parseAuthenticatedFakeRuntimeReadinessFrame(
  frame: string,
  trustAnchor: string
): Readonly<{ value: Record<string, unknown>; serializedUnsignedEnvelope: string }> {
  const newline = frame.indexOf('\n');
  if (newline < 1 || newline !== frame.length - 1) {
    throw new Error('fake_runtime_readiness_frame_invalid');
  }
  const body = frame.slice(0, -1);
  assertNoDuplicateFakeRuntimeJsonKeys(body);
  const value: unknown = JSON.parse(body);
  if (!isRecord(value) || typeof value.controllerProof !== 'string') {
    throw new Error('fake_runtime_readiness_frame_invalid');
  }
  const suffix = `,"controllerProof":"${value.controllerProof}"}`;
  if (!body.endsWith(suffix) || !/^[0-9a-f]{64}$/u.test(value.controllerProof)) {
    throw new Error('fake_runtime_readiness_frame_invalid');
  }
  const serializedUnsignedEnvelope = `${body.slice(0, -suffix.length)}}`;
  const expected = fakeRuntimeLifecycleProof(
    trustAnchor,
    'readiness-request',
    serializedUnsignedEnvelope
  );
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(value.controllerProof, 'hex'))) {
    throw new Error('fake_runtime_readiness_proof_invalid');
  }
  return Object.freeze({ value, serializedUnsignedEnvelope });
}

interface FakeRuntimeLifecycleSignedFrame {
  readonly value: Record<string, unknown>;
  readonly serializedUnsignedEnvelope: string;
  readonly ownerProof: string;
}

function assertNoDuplicateFakeRuntimeJsonKeys(source: string): void {
  let cursor = 0;
  const fail = (): never => {
    throw new Error('fake_runtime_lifecycle_signed_frame_invalid');
  };
  const whitespace = (): void => {
    while (/\s/u.test(source[cursor] ?? '')) cursor += 1;
  };
  const stringToken = (): string => {
    if (source[cursor] !== '"') fail();
    const start = cursor++;
    while (cursor < source.length) {
      const character = source[cursor++];
      if (character === '"') return JSON.parse(source.slice(start, cursor)) as string;
      if (character === '\\') {
        if (cursor >= source.length) fail();
        cursor += 1;
      } else if ((character?.charCodeAt(0) ?? 0) < 0x20) {
        fail();
      }
    }
    return fail();
  };
  const value = (): void => {
    whitespace();
    if (source[cursor] === '{') {
      cursor += 1;
      whitespace();
      const keys = new Set<string>();
      if (source[cursor] === '}') {
        cursor += 1;
        return;
      }
      for (;;) {
        whitespace();
        const key = stringToken();
        if (keys.has(key)) fail();
        keys.add(key);
        whitespace();
        if (source[cursor++] !== ':') fail();
        value();
        whitespace();
        const delimiter = source[cursor++];
        if (delimiter === '}') return;
        if (delimiter !== ',') fail();
      }
    }
    if (source[cursor] === '[') {
      cursor += 1;
      whitespace();
      if (source[cursor] === ']') {
        cursor += 1;
        return;
      }
      for (;;) {
        value();
        whitespace();
        const delimiter = source[cursor++];
        if (delimiter === ']') return;
        if (delimiter !== ',') fail();
      }
    }
    if (source[cursor] === '"') {
      stringToken();
      return;
    }
    const start = cursor;
    while (cursor < source.length && !/[\s,}\]]/u.test(source[cursor] ?? '')) cursor += 1;
    if (cursor === start) fail();
  };
  value();
  whitespace();
  if (cursor !== source.length) fail();
}

/** Preserves the exact request bytes authenticated by the production client's wire proof. */
function parseFakeRuntimeLifecycleSignedFrame(frame: string): FakeRuntimeLifecycleSignedFrame {
  const newline = frame.indexOf('\n');
  if (newline < 1 || newline !== frame.length - 1) {
    throw new Error('fake_runtime_lifecycle_signed_frame_invalid');
  }
  const body = frame.slice(0, -1);
  assertNoDuplicateFakeRuntimeJsonKeys(body);
  const value: unknown = JSON.parse(body);
  if (!isRecord(value) || typeof value.ownerProof !== 'string') {
    throw new Error('fake_runtime_lifecycle_signed_frame_invalid');
  }
  const ownerProof = value.ownerProof;
  if (!/^[0-9a-f]{64}$/u.test(ownerProof)) {
    throw new Error('fake_runtime_lifecycle_signed_frame_invalid');
  }
  const proofSuffix = `,"ownerProof":"${ownerProof}"}`;
  if (!body.endsWith(proofSuffix)) {
    throw new Error('fake_runtime_lifecycle_signed_frame_invalid');
  }
  const serializedUnsignedEnvelope = `${body.slice(0, -proofSuffix.length)}}`;
  const unsigned: unknown = JSON.parse(serializedUnsignedEnvelope);
  if (
    !isRecord(unsigned) ||
    Object.hasOwn(unsigned, 'ownerProof') ||
    Reflect.ownKeys(unsigned).length + 1 !== Reflect.ownKeys(value).length
  ) {
    throw new Error('fake_runtime_lifecycle_signed_frame_invalid');
  }
  return Object.freeze({ value, serializedUnsignedEnvelope, ownerProof });
}

export function verifyFakeRuntimeLifecycleRequestFrame(
  frame: string,
  trustAnchor: string
): FakeRuntimeLifecycleSignedFrame {
  if (!/^[0-9a-f]{64}$/u.test(trustAnchor)) {
    throw new Error('fake_runtime_owner_proof_invalid');
  }
  const signed = parseFakeRuntimeLifecycleSignedFrame(frame);
  const expected = fakeRuntimeLifecycleProof(
    trustAnchor,
    'request',
    signed.serializedUnsignedEnvelope
  );
  if (!timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(signed.ownerProof, 'hex'))) {
    throw new Error('fake_runtime_owner_proof_invalid');
  }
  return signed;
}

function writeFakeRuntimeLifecycleSignedFrame(
  socket: Socket,
  trustAnchor: string,
  direction: 'response',
  envelope: Record<string, unknown>
): void {
  const serializedUnsignedEnvelope = JSON.stringify(envelope);
  const ownerProof = fakeRuntimeLifecycleProof(trustAnchor, direction, serializedUnsignedEnvelope);
  socket.end(`${serializedUnsignedEnvelope.slice(0, -1)},"ownerProof":"${ownerProof}"}\n`);
}

function messageProof(
  trustAnchor: string,
  operation: 'message_persist' | 'message_deliver' | 'task_mutate',
  direction: 'request' | 'response',
  envelope: Record<string, unknown>
): string {
  return createHmac('sha256', Buffer.from(trustAnchor, 'hex'))
    .update(
      `${MESSAGE_OWNER_PROOF_DOMAIN}\u0000${operation}\u0000${direction}\u0000${JSON.stringify(envelope)}`
    )
    .digest('hex');
}

function sha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex');
}

interface FakeRuntimeOwnerEffectFence {
  readonly grantRevision: string;
  readonly identityChecksum: string;
}

function requireFakeRuntimeOwnerEffectFence(value: unknown): FakeRuntimeOwnerEffectFence {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['grantRevision', 'identityChecksum']) ||
    typeof value.grantRevision !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.grantRevision) ||
    typeof value.identityChecksum !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.identityChecksum)
  ) {
    throw new Error('fake_runtime_owner_effect_fence_invalid');
  }
  return Object.freeze({
    grantRevision: value.grantRevision,
    identityChecksum: value.identityChecksum,
  });
}

const FAKE_RUNTIME_PROOF_OWNER_EFFECT_FENCE = Object.freeze({
  grantRevision: sha256('agent-teams.hosted-v1-e2e.proof-grant-revision/v1'),
  identityChecksum: sha256('agent-teams.hosted-v1-e2e.proof-identity-checksum/v1'),
});

function hostedWorkspaceGrantRevision(userId: string, runtimeWorkspaceId: string): string {
  return sha256(
    JSON.stringify([
      'agent-teams.hosted-v1-e2e.workspace-grant-revision/v1',
      userId,
      runtimeWorkspaceId,
    ])
  );
}

export function fakeRuntimeLifecycleRunId(teamId: string, commandFingerprint: string): string {
  if (!/^team_[0-9a-f]{32}$/u.test(teamId) || !/^[0-9a-f]{64}$/u.test(commandFingerprint)) {
    throw new Error('fake_runtime_lifecycle_run_identity_invalid');
  }
  return `run_${sha256(
    JSON.stringify({
      domain: 'agent-teams.hosted-v1-e2e.lifecycle-run/v2',
      teamId,
      commandFingerprint,
    })
  ).slice(0, 32)}`;
}

function canonicalJson(value: unknown): string {
  const normalize = (candidate: unknown): unknown => {
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') {
      return candidate;
    }
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new TypeError('hosted_e2e_event_number_invalid');
      return candidate;
    }
    if (Array.isArray(candidate)) return candidate.map(normalize);
    if (typeof candidate !== 'object') throw new TypeError('hosted_e2e_event_json_invalid');
    const normalized: Record<string, unknown> = {};
    for (const key of Object.keys(candidate).sort((left, right) => left.localeCompare(right))) {
      const child = (candidate as Record<string, unknown>)[key];
      if (child !== undefined) normalized[key] = normalize(child);
    }
    return normalized;
  };
  return JSON.stringify(normalize(value));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}

export interface FakeRuntimeOwnerMutationErrorTraceEntry {
  readonly sequence: number;
  readonly operation: 'task_mutate';
  readonly stage: 'error';
  readonly reason: string;
}

export interface FakeRuntimeOwnerMutationErrorTrace {
  record(error: unknown): Promise<void>;
}

export function sanitizeFakeRuntimeOwnerMutationError(error: unknown): string {
  const reason = error instanceof Error ? error.message : '';
  return SAFE_FAKE_RUNTIME_OWNER_MUTATION_ERROR.test(reason)
    ? reason
    : FAKE_RUNTIME_OWNER_MUTATION_INTERNAL_ERROR;
}

export function createFakeRuntimeOwnerMutationErrorTrace(
  path: string
): FakeRuntimeOwnerMutationErrorTrace {
  let sequence = 0;
  let entries: readonly FakeRuntimeOwnerMutationErrorTraceEntry[] = Object.freeze([]);
  let writeTail = Promise.resolve();
  return Object.freeze({
    record(error: unknown): Promise<void> {
      const entry = Object.freeze({
        sequence: (sequence += 1),
        operation: 'task_mutate' as const,
        stage: 'error' as const,
        reason: sanitizeFakeRuntimeOwnerMutationError(error),
      });
      entries = Object.freeze(
        [...entries, entry].slice(-MAX_FAKE_RUNTIME_OWNER_MUTATION_ERROR_TRACE_ENTRIES)
      );
      const serialized = `${JSON.stringify(entries)}\n`;
      writeTail = writeTail.then(() => writeFile(path, serialized, { mode: 0o600 }));
      return writeTail;
    },
  });
}

function parseFakeRuntimeLifecycleCommand(value: unknown): Record<string, unknown> {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    !['launch', 'cancel', 'stop', 'recover'].includes(String(value.action)) ||
    typeof value.commandId !== 'string' ||
    !/^lifecycle-command_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(value.commandId) ||
    typeof value.idempotencyKey !== 'string' ||
    !/^idempotency_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(value.idempotencyKey) ||
    value.workspaceId !== PUBLIC_WORKSPACE_ID ||
    value.teamId !== TEAM_ID ||
    typeof value.expectedRevision !== 'string' ||
    !/^revision_[A-Za-z0-9_-]{32,128}$/u.test(value.expectedRevision) ||
    !hasExactKeys(
      value,
      value.action === 'launch'
        ? [
            'schemaVersion',
            'action',
            'commandId',
            'idempotencyKey',
            'workspaceId',
            'teamId',
            'expectedRevision',
          ]
        : [
            'schemaVersion',
            'action',
            'commandId',
            'idempotencyKey',
            'workspaceId',
            'teamId',
            'expectedRevision',
            'runId',
          ]
    ) ||
    (value.action !== 'launch' &&
      (typeof value.runId !== 'string' ||
        !/^run_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(value.runId)))
  ) {
    throw new Error('fake_runtime_lifecycle_command_invalid');
  }
  return Object.freeze({ ...value });
}

export function fakeRuntimeLifecycleDurableCommand(
  command: Record<string, unknown>,
  context: Record<string, unknown>,
  authority: Record<string, unknown>
): FakeRuntimeLifecycleDurableCommand {
  const ownerEffectFence = requireFakeRuntimeOwnerEffectFence(authority.ownerEffectFence);
  const commandFingerprint = Object.freeze({
    algorithm: 'sha256' as const,
    version: 1 as const,
    digest: sha256(
      JSON.stringify([
        'agent-teams.hosted-lifecycle-command/v1',
        command.schemaVersion,
        command.action,
        command.commandId,
        command.idempotencyKey,
        command.workspaceId,
        command.teamId,
        command.expectedRevision,
        command.action === 'launch' ? null : command.runId,
        ownerEffectFence.grantRevision,
        ownerEffectFence.identityChecksum,
      ])
    ),
  });
  return Object.freeze({
    schemaVersion: 1 as const,
    commandFingerprint,
    idempotency: Object.freeze({
      deploymentId: String(context.deploymentId),
      actorId: String(context.actorId),
      action: String(command.action),
      idempotencyKey: String(command.idempotencyKey),
    }),
    resource: Object.freeze({
      bootId: String(context.bootId),
      workspaceId: String(command.workspaceId),
      teamId: String(command.teamId),
      runId: command.action === 'launch' ? null : String(command.runId),
      expectedRevision: String(command.expectedRevision),
      restoreGeneration: Number(authority.restoreGeneration),
      mountGeneration: Number(authority.mountGeneration),
      ownerEffectFence,
    }),
  });
}

function requireFakeRuntimeLifecycleDurableCommand(
  value: unknown,
  command: Record<string, unknown>,
  context: Record<string, unknown>,
  authority: Record<string, unknown>
): FakeRuntimeLifecycleDurableCommand {
  const expected = fakeRuntimeLifecycleDurableCommand(command, context, authority);
  if (!isRecord(value) || canonicalJson(value) !== canonicalJson(expected)) {
    throw new Error('fake_runtime_lifecycle_durable_command_invalid');
  }
  return expected;
}

function fakeRuntimeLifecycleLedgerKey(durableCommand: FakeRuntimeLifecycleDurableCommand): string {
  return JSON.stringify([
    durableCommand.idempotency.deploymentId,
    durableCommand.idempotency.actorId,
    durableCommand.idempotency.action,
    durableCommand.idempotency.idempotencyKey,
  ]);
}

function fakeRuntimeLifecycleFinalRevision(
  durableCommand: FakeRuntimeLifecycleDurableCommand
): string {
  return `revision_${sha256(
    JSON.stringify([
      'agent-teams.hosted-v1-e2e.lifecycle-postimage/v1',
      durableCommand.commandFingerprint.digest,
      durableCommand.resource,
    ])
  )}`;
}

interface FakeRuntimeOwnerGenerationState {
  readonly schemaVersion: 1;
  readonly purpose: typeof FAKE_RUNTIME_OWNER_GENERATION_PURPOSE;
  readonly marker: string;
  readonly generation: number;
}

function fakeRuntimeOwnerMarker(bootId: string): string {
  const match = /^boot_hosted-v1-e2e-([0-9a-f]{48})$/u.exec(bootId);
  if (!match?.[1]) throw new Error('hosted_e2e_fake_runtime_boot_id_invalid');
  return match[1];
}

async function assertFakeRuntimeStateRoot(stateRoot: string): Promise<void> {
  const rootStat = await lstat(stateRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('hosted_e2e_fake_runtime_state_root_invalid');
  }
}

async function readFakeRuntimeOwnerGeneration(marker: string, stateRoot: string): Promise<number> {
  await assertFakeRuntimeStateRoot(stateRoot);
  const statePath = `${stateRoot}/owner-generation.json`;
  let stateStat;
  try {
    stateStat = await lstat(statePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  if (
    !stateStat.isFile() ||
    stateStat.isSymbolicLink() ||
    stateStat.nlink !== 1 ||
    stateStat.size > 512 ||
    (stateStat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && stateStat.uid !== process.getuid())
  ) {
    throw new Error('hosted_e2e_fake_runtime_owner_generation_invalid');
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    throw new Error('hosted_e2e_fake_runtime_owner_generation_invalid');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'purpose', 'marker', 'generation']) ||
    value.schemaVersion !== 1 ||
    value.purpose !== FAKE_RUNTIME_OWNER_GENERATION_PURPOSE ||
    value.marker !== marker ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1
  ) {
    throw new Error('hosted_e2e_fake_runtime_owner_generation_invalid');
  }
  return value.generation as number;
}

async function writeFakeRuntimeOwnerGeneration(
  state: FakeRuntimeOwnerGenerationState,
  stateRoot: string
): Promise<void> {
  await assertFakeRuntimeStateRoot(stateRoot);
  const statePath = `${stateRoot}/owner-generation.json`;
  const temporaryPath = `${statePath}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(`${JSON.stringify(state)}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, statePath);
    const rootHandle = await open(stateRoot, 'r');
    try {
      await rootHandle.sync();
    } finally {
      await rootHandle.close();
    }
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

const fakeRuntimeOwnerGenerationQueue = createFakeRuntimeStateMutationQueue();

export async function reserveFakeRuntimeOwnerGeneration(
  bootId: string,
  stateRoot = FAKE_RUNTIME_STATE_ROOT
): Promise<number> {
  return fakeRuntimeOwnerGenerationQueue.run(async () => {
    const marker = fakeRuntimeOwnerMarker(bootId);
    const previous = await readFakeRuntimeOwnerGeneration(marker, stateRoot);
    if (previous >= MAX_FAKE_RUNTIME_OWNER_GENERATION - 1) {
      throw new Error('hosted_e2e_fake_runtime_owner_generation_exhausted');
    }
    const generation = previous + 1;
    await writeFakeRuntimeOwnerGeneration(
      {
        schemaVersion: 1,
        purpose: FAKE_RUNTIME_OWNER_GENERATION_PURPOSE,
        marker,
        generation,
      },
      stateRoot
    );
    return generation;
  });
}

export async function readFakeRuntimeMountGeneration(
  bootId: string,
  stateRoot = FAKE_RUNTIME_STATE_ROOT
): Promise<number> {
  const marker = fakeRuntimeOwnerMarker(bootId);
  await assertFakeRuntimeStateRoot(stateRoot);
  const statePath = `${stateRoot}/mount-generation.json`;
  const stateStat = await lstat(statePath);
  if (
    !stateStat.isFile() ||
    stateStat.isSymbolicLink() ||
    stateStat.nlink !== 1 ||
    stateStat.size < 1 ||
    stateStat.size > 512 ||
    (stateStat.mode & 0o077) !== 0 ||
    (typeof process.getuid === 'function' && stateStat.uid !== process.getuid())
  ) {
    throw new Error('hosted_e2e_fake_runtime_mount_generation_invalid');
  }
  let value: unknown;
  try {
    value = JSON.parse(await readFile(statePath, 'utf8'));
  } catch {
    throw new Error('hosted_e2e_fake_runtime_mount_generation_invalid');
  }
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['schemaVersion', 'purpose', 'marker', 'generation']) ||
    value.schemaVersion !== 1 ||
    value.purpose !== FAKE_RUNTIME_MOUNT_GENERATION_PURPOSE ||
    value.marker !== marker ||
    !Number.isSafeInteger(value.generation) ||
    (value.generation as number) < 1
  ) {
    throw new Error('hosted_e2e_fake_runtime_mount_generation_invalid');
  }
  return value.generation as number;
}

export function assertFakeRuntimeMountGenerationCurrent(input: {
  readonly expectedMountGeneration: number;
  readonly receivedMountGeneration: number;
}): void {
  if (
    !Number.isSafeInteger(input.expectedMountGeneration) ||
    input.expectedMountGeneration < 1 ||
    !Number.isSafeInteger(input.receivedMountGeneration) ||
    input.receivedMountGeneration < 1
  ) {
    throw new Error('fake_runtime_mount_generation_invalid');
  }
  if (input.receivedMountGeneration !== input.expectedMountGeneration) {
    throw new Error('fake_runtime_mount_generation_stale');
  }
}

async function seedSandbox(): Promise<void> {
  const { default: Database } = await import('better-sqlite3');
  const { parseTeamIdentityRecord } =
    // @ts-expect-error The fixture seed executes source TypeScript through tsx.
    await import('../../../src/features/internal-storage/contracts/teamIdentityStorageContracts.ts');
  const { projectedRevision } =
    // @ts-expect-error The fixture seed executes source TypeScript through tsx.
    await import('../../../src/main/composition/hosted/teamLifecycleReadShared.ts');
  const { runInternalStorageMigrations } =
    // @ts-expect-error The fixture seed executes source TypeScript through tsx.
    await import('../../../src/features/internal-storage/main/infrastructure/worker/internalStorageMigrations.ts');
  const { TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS } =
    // @ts-expect-error The fixture seed executes source TypeScript through tsx.
    await import('../../../src/features/internal-storage/main/infrastructure/worker/teamIdentityStorageSchema.ts');
  const marker = JSON.parse(
    await readFile(process.env.E2E_SEED_MARKER_PATH ?? '/e2e-owner.json', 'utf8')
  ) as Record<string, unknown>;
  if (
    marker.schemaVersion !== 1 ||
    marker.purpose !== 'hosted-v1-browser-e2e' ||
    typeof marker.marker !== 'string' ||
    !/^[0-9a-f]{48}$/.test(marker.marker)
  ) {
    throw new Error('hosted_e2e_seed_marker_invalid');
  }

  const teamDirectory = `${CLAUDE_ROOT}/teams/${TEAM_NAME}`;
  if ((await realpath(teamDirectory)) !== teamDirectory) {
    throw new Error('hosted_e2e_seed_team_root_invalid');
  }
  const teamStat = await lstat(teamDirectory, { bigint: true });
  if (!teamStat.isDirectory() || teamStat.isSymbolicLink()) {
    throw new Error('hosted_e2e_seed_team_root_invalid');
  }
  const identity = await readFile(`${teamDirectory}/team.identity.json`, 'utf8');
  const identityChecksum = sha256(identity);
  const directoryFingerprint = sha256(
    JSON.stringify({
      schemaVersion: 1,
      canonicalPath: `/data/.claude/teams/${TEAM_NAME}`,
      device: teamStat.dev.toString(),
      inode: teamStat.ino.toString(),
    })
  );
  const intentChecksum = sha256(
    JSON.stringify({
      schemaVersion: 1,
      intentId: ADOPTION_ID,
      teamId: TEAM_ID,
      legacyKey: TEAM_NAME,
      directoryFingerprint,
      workspaceId: RUNTIME_WORKSPACE_ID,
      workspaceBindingGeneration: 1,
      expectedIdentityChecksum: identityChecksum,
      preparedAt: CREATED_AT,
    })
  );
  const initialLifecycleRevision = projectedRevision(
    parseTeamIdentityRecord({
      teamId: TEAM_ID,
      state: 'active',
      legacyKey: TEAM_NAME,
      directoryFingerprint,
      workspaceBinding: { workspaceId: RUNTIME_WORKSPACE_ID, generation: 1 },
      adoptionIntentId: ADOPTION_ID,
      identityChecksum,
      createdAt: CREATED_AT,
      activatedAt: COMMITTED_AT,
      tombstonedAt: null,
    }),
    { teamName: TEAM_NAME }
  );

  await Promise.all([
    mkdir(`${APP_DATA_ROOT}/storage`, { recursive: true }),
    mkdir(`${AUTH_DATA_ROOT}/storage`, { recursive: true }),
  ]);
  const database = new Database(`${APP_DATA_ROOT}/storage/app.db`);
  try {
    database.pragma('journal_mode = DELETE');
    for (const statement of TEAM_IDENTITY_STORAGE_MIGRATION_STATEMENTS) database.exec(statement);
    database
      .prepare(
        `INSERT INTO team_identity_records (
          team_id, state, legacy_key, directory_fingerprint, workspace_id,
          workspace_binding_generation, adoption_intent_id, identity_checksum,
          created_at, activated_at, tombstoned_at
        ) VALUES (?, 'active', ?, ?, ?, 1, ?, ?, ?, ?, NULL)`
      )
      .run(
        TEAM_ID,
        TEAM_NAME,
        directoryFingerprint,
        RUNTIME_WORKSPACE_ID,
        ADOPTION_ID,
        identityChecksum,
        CREATED_AT,
        COMMITTED_AT
      );
    database
      .prepare(
        `INSERT INTO legacy_team_key_reservations (
          legacy_key, team_id, state, reserved_at, tombstoned_at, tombstone_reason
        ) VALUES (?, ?, 'active', ?, NULL, NULL)`
      )
      .run(TEAM_NAME, TEAM_ID, CREATED_AT);
    database
      .prepare(
        `INSERT INTO team_adoption_intents (
          intent_id, team_id, state, legacy_key, directory_fingerprint, workspace_id,
          workspace_binding_generation, expected_identity_checksum, intent_checksum,
          prepared_at, file_published_at, published_identity_checksum,
          committed_at, committed_identity_checksum
        ) VALUES (?, ?, 'committed', ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        ADOPTION_ID,
        TEAM_ID,
        TEAM_NAME,
        directoryFingerprint,
        RUNTIME_WORKSPACE_ID,
        identityChecksum,
        intentChecksum,
        CREATED_AT,
        PUBLISHED_AT,
        identityChecksum,
        COMMITTED_AT,
        identityChecksum
      );
  } finally {
    database.close();
  }

  const authDatabase = new Database(`${AUTH_DATA_ROOT}/storage/app.db`);
  try {
    authDatabase.pragma('journal_mode = DELETE');
    runInternalStorageMigrations(authDatabase);
    seedHostedWorkspaceAccess(authDatabase);
  } finally {
    authDatabase.close();
  }
  if (process.env.E2E_FAKE_RUNTIME_STATE_ROOT !== undefined) {
    await writeRuntimeState(
      {
        schemaVersion: 1,
        lifecycleInitialRevision: initialLifecycleRevision,
        activeRuns: [],
        commands: [],
        eventIds: [],
        messageLedger: [],
        taskLedger: [],
        lifecycleCommandLedger: [],
        lifecycleReleaseLedger: [],
      },
      `${process.env.E2E_FAKE_RUNTIME_STATE_ROOT}/runtime-state.json`
    );
  }
}

function seedHostedWorkspaceAccess(database: {
  prepare(sql: string): { run(...values: unknown[]): unknown };
  transaction<T>(operation: () => T): () => T;
}): void {
  const authMode = process.env.E2E_SEED_AUTH_MODE;
  const issuer = process.env.E2E_SEED_OIDC_ISSUER;
  const plan = hostedWorkspaceAccessSeedPlan(authMode, issuer);
  const seededAt = Date.parse(CREATED_AT);
  database.transaction(() => {
    database
      .prepare(
        `INSERT INTO users (user_id, display_name, status, created_at, updated_at)
         VALUES (?, ?, 'active', ?, ?)`
      )
      .run(plan.userId, plan.displayName, seededAt, seededAt);
    if (plan.authMode === 'personal') {
      database
        .prepare(
          `INSERT INTO personal_owners (singleton, operator_id, user_id, created_at)
           VALUES (1, ?, ?, ?)`
        )
        .run(`operator_${'1'.repeat(32)}`, plan.userId, seededAt);
    } else {
      database
        .prepare(
          `INSERT INTO external_identities
             (issuer, subject, user_id, provider_id, created_at, last_authenticated_at)
           VALUES (?, 'hosted-v1-e2e-owner', ?, 'synthetic-oidc', ?, ?)`
        )
        .run(plan.issuer, plan.userId, seededAt, seededAt);
    }
    for (const workspace of plan.workspaces) {
      database
        .prepare(
          `INSERT INTO hosted_workspaces
             (runtime_workspace_id, public_workspace_id, display_name, status, registered_at, registered_by)
           VALUES (?, ?, ?, 'active', ?, NULL)`
        )
        .run(
          workspace.runtimeWorkspaceId,
          workspace.publicWorkspaceId,
          workspace.displayName,
          seededAt
        );
      database
        .prepare(
          `INSERT INTO hosted_workspace_grants
             (user_id, runtime_workspace_id, grant_generation, grant_revision, granted_at, granted_by)
           VALUES (?, ?, 0, ?, ?, 'local-cli')`
        )
        .run(plan.userId, workspace.runtimeWorkspaceId, workspace.grantRevision, seededAt);
    }
  })();
}

export function hostedWorkspaceAccessSeedPlan(
  authMode: string | undefined,
  issuer: string | undefined
) {
  if (authMode !== 'personal' && authMode !== 'oidc') {
    throw new Error('hosted_e2e_seed_auth_mode_invalid');
  }
  if (authMode === 'oidc' && (!issuer || new URL(issuer).protocol !== 'https:')) {
    throw new Error('hosted_e2e_seed_oidc_issuer_invalid');
  }
  const userId = authMode === 'personal' ? `user_${'1'.repeat(32)}` : `user_${'2'.repeat(32)}`;
  return Object.freeze({
    authMode,
    issuer: authMode === 'oidc' ? issuer : null,
    userId,
    displayName: authMode === 'personal' ? 'Personal deployment owner' : 'Synthetic OIDC Owner',
    workspaces: Object.freeze([
      Object.freeze({
        runtimeWorkspaceId: LEGACY_RUNTIME_WORKSPACE_ID,
        publicWorkspaceId: LEGACY_PUBLIC_WORKSPACE_ID,
        displayName: 'sandbox',
        grantRevision: hostedWorkspaceGrantRevision(userId, LEGACY_RUNTIME_WORKSPACE_ID),
      }),
      Object.freeze({
        runtimeWorkspaceId: RUNTIME_WORKSPACE_ID,
        publicWorkspaceId: PUBLIC_WORKSPACE_ID,
        displayName: 'Hosted v1 E2E sandbox',
        grantRevision: hostedWorkspaceGrantRevision(userId, RUNTIME_WORKSPACE_ID),
      }),
    ]),
  });
}

function sendJson(response: ServerResponse, value: unknown, statusCode = 200): void {
  const body = JSON.stringify(value);
  response.writeHead(statusCode, {
    'cache-control': 'no-store',
    'content-length': Buffer.byteLength(body),
    'content-type': 'application/json',
    'x-content-type-options': 'nosniff',
  });
  response.end(body);
}

async function requestBody(request: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    bytes += buffer.byteLength;
    if (bytes > 16 * 1024) throw new Error('hosted_e2e_oidc_body_too_large');
    chunks.push(buffer);
  }
  return Buffer.concat(chunks, bytes).toString('utf8');
}

async function serveSyntheticOidcProvider(): Promise<void> {
  const issuer = process.env.HOSTED_E2E_OIDC_ORIGIN;
  const hostedOrigin = process.env.HOSTED_E2E_ORIGIN;
  const clientId = process.env.OIDC_CLIENT_ID;
  const port = Number(process.env.PORT ?? 8080);
  const role = process.env.HOSTED_E2E_OIDC_ROLE ?? 'owner';
  if (
    !issuer ||
    !hostedOrigin ||
    !clientId ||
    new URL(issuer).protocol !== 'https:' ||
    new URL(hostedOrigin).protocol !== 'https:' ||
    !Number.isSafeInteger(port) ||
    port < 1024 ||
    port > 65_535
  ) {
    throw new Error('hosted_e2e_oidc_configuration_invalid');
  }
  const redirectUri = `${hostedOrigin}/api/auth/oidc/callback`;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', {
    modulusLength: 2048,
  });
  const publicJwk = {
    ...(publicKey.export({ format: 'jwk' }) as Record<string, unknown>),
    alg: 'RS256',
    kid: 'hosted-v1-e2e-key',
    use: 'sig',
  };
  const codes = new Map<string, { readonly challenge: string; readonly nonce: string }>();
  const signedIdToken = (nonce: string): string => {
    const now = Math.floor(Date.now() / 1000);
    const header = Buffer.from(
      JSON.stringify({ alg: 'RS256', kid: 'hosted-v1-e2e-key', typ: 'JWT' })
    ).toString('base64url');
    const payload = Buffer.from(
      JSON.stringify({
        iss: issuer,
        sub: 'hosted-v1-e2e-owner',
        aud: clientId,
        exp: now + 300,
        iat: now,
        nonce,
        sid: 'hosted-v1-e2e-provider-session',
        name: 'Synthetic OIDC Owner',
        realm_access: { roles: [`agent-teams-${role}`] },
      })
    ).toString('base64url');
    const signingInput = `${header}.${payload}`;
    const signature = sign('RSA-SHA256', Buffer.from(signingInput), privateKey).toString(
      'base64url'
    );
    return `${signingInput}.${signature}`;
  };

  const server = createServer(async (request, response) => {
    try {
      const url = new URL(request.url ?? '/', issuer);
      if (request.method === 'GET' && url.pathname === '/health') {
        sendJson(response, { ok: true });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/.well-known/openid-configuration') {
        sendJson(response, {
          issuer,
          authorization_endpoint: `${issuer}/authorize`,
          token_endpoint: `${issuer}/token`,
          jwks_uri: `${issuer}/jwks`,
          end_session_endpoint: `${issuer}/logout`,
          token_endpoint_auth_methods_supported: ['none'],
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/jwks') {
        sendJson(response, { keys: [publicJwk] });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/authorize') {
        const state = url.searchParams.get('state');
        const nonce = url.searchParams.get('nonce');
        const challenge = url.searchParams.get('code_challenge');
        if (
          url.searchParams.get('client_id') !== clientId ||
          url.searchParams.get('redirect_uri') !== redirectUri ||
          url.searchParams.get('response_type') !== 'code' ||
          url.searchParams.get('code_challenge_method') !== 'S256' ||
          !url.searchParams.get('scope')?.split(' ').includes('openid') ||
          !state ||
          !nonce ||
          !challenge ||
          !/^[A-Za-z0-9_-]{32,}$/.test(state) ||
          !/^[A-Za-z0-9_-]{32,}$/.test(nonce) ||
          !/^[A-Za-z0-9_-]{43}$/.test(challenge)
        ) {
          sendJson(response, { error: 'invalid_request' }, 400);
          return;
        }
        if (codes.size >= 32) {
          sendJson(response, { error: 'temporarily_unavailable' }, 503);
          return;
        }
        const code = randomBytes(32).toString('base64url');
        codes.set(code, { challenge, nonce });
        const callback = new URL(redirectUri);
        callback.searchParams.set('code', code);
        callback.searchParams.set('state', state);
        response.writeHead(302, {
          'cache-control': 'no-store',
          location: callback.toString(),
        });
        response.end();
        return;
      }
      if (request.method === 'POST' && url.pathname === '/token') {
        const body = new URLSearchParams(await requestBody(request));
        const code = body.get('code');
        const verifier = body.get('code_verifier');
        const attempt = code ? codes.get(code) : undefined;
        if (
          body.get('grant_type') !== 'authorization_code' ||
          body.get('client_id') !== clientId ||
          body.get('redirect_uri') !== redirectUri ||
          !code ||
          !verifier ||
          !attempt ||
          createHash('sha256').update(verifier).digest('base64url') !== attempt.challenge
        ) {
          sendJson(response, { error: 'invalid_grant' }, 400);
          return;
        }
        codes.delete(code);
        sendJson(response, {
          token_type: 'Bearer',
          expires_in: 300,
          id_token: signedIdToken(attempt.nonce),
        });
        return;
      }
      if (request.method === 'GET' && url.pathname === '/logout') {
        const destination = url.searchParams.get('post_logout_redirect_uri');
        const parsedDestination = destination ? new URL(destination) : null;
        if (
          !destination ||
          parsedDestination?.origin !== hostedOrigin ||
          parsedDestination?.pathname !== '/' ||
          parsedDestination?.search !== '' ||
          parsedDestination?.hash !== ''
        ) {
          sendJson(response, { error: 'invalid_request' }, 400);
          return;
        }
        response.writeHead(302, {
          'cache-control': 'no-store',
          location: destination,
        });
        response.end();
        return;
      }
      sendJson(response, { error: 'not_found' }, 404);
    } catch {
      sendJson(response, { error: 'provider_unavailable' }, 503);
    }
  });
  await new Promise<void>((resolveListen, reject) => {
    server.once('error', reject);
    server.listen(port, '0.0.0.0', resolveListen);
  });
  const stop = (): void => {
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

function writeLine(socket: Socket, value: unknown): void {
  socket.end(`${JSON.stringify(value)}\n`);
}

interface FakeRuntimeCommand {
  readonly action: string;
  readonly commandId: string;
  readonly eventId?: string;
  readonly runId: string;
  readonly teamId: string;
  readonly workspaceId: string;
  readonly resourceRevision: string;
  readonly durableCommand?: FakeRuntimeLifecycleDurableCommand;
}

interface FakeRuntimeLifecycleDurableCommand {
  readonly schemaVersion: 1;
  readonly commandFingerprint: Readonly<{
    algorithm: 'sha256';
    version: 1;
    digest: string;
  }>;
  readonly idempotency: Readonly<{
    deploymentId: string;
    actorId: string;
    action: string;
    idempotencyKey: string;
  }>;
  readonly resource: Readonly<{
    bootId: string;
    workspaceId: string;
    teamId: string;
    runId: string | null;
    expectedRevision: string;
    restoreGeneration: number;
    mountGeneration: number;
    ownerEffectFence: FakeRuntimeOwnerEffectFence;
  }>;
}

interface FakeRuntimeLifecycleCommandLedgerEntry {
  readonly key: string;
  readonly command: Record<string, unknown>;
  readonly durableCommand: FakeRuntimeLifecycleDurableCommand;
  readonly state: 'started' | 'settled' | 'operator_required';
  readonly result?: Record<string, unknown>;
}

interface FakeRuntimeLifecycleReleaseLedgerEntry {
  readonly key: string;
  readonly authorization: Record<string, unknown>;
  readonly ownerBinding: Record<string, unknown>;
  /** Owner-local revocation generation in which this idempotent release was committed. */
  readonly drainEpoch: number;
}

interface FakeRuntimeState {
  readonly schemaVersion: 1;
  readonly lifecycleInitialRevision?: string;
  readonly activeRuns: readonly Readonly<{ teamId: string; runId: string }>[];
  readonly commands: readonly FakeRuntimeCommand[];
  readonly eventIds: readonly string[];
  readonly messageLedger: readonly FakeRuntimeMessageLedgerEntry[];
  readonly taskLedger?: readonly FakeRuntimeTaskLedgerEntry[];
  readonly lifecycleCommandLedger?: readonly FakeRuntimeLifecycleCommandLedgerEntry[];
  readonly lifecycleReleaseLedger?: readonly FakeRuntimeLifecycleReleaseLedgerEntry[];
}

export type FakeRuntimeAuthDrainRequest =
  | Readonly<{ operation: 'auth_drain'; resetGeneration: number }>
  | Readonly<{ operation: 'auth_drain_release'; resetGeneration: number }>;

export function parseFakeRuntimeAuthDrainRequest(value: unknown): FakeRuntimeAuthDrainRequest {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['operation', 'resetGeneration']) ||
    (value.operation !== 'auth_drain' && value.operation !== 'auth_drain_release') ||
    typeof value.resetGeneration !== 'number' ||
    !Number.isSafeInteger(value.resetGeneration) ||
    value.resetGeneration <= 0
  ) {
    throw new Error('hosted_e2e_auth_drain_request_invalid');
  }
  return Object.freeze({
    operation: value.operation,
    resetGeneration: value.resetGeneration,
  });
}

export function createFakeRuntimeAuthDrainEpochFence(): {
  issue(): number;
  drain(): number;
  isCurrent(issuedEpoch: number): boolean;
} {
  let epoch = 0;
  return Object.freeze({
    issue: () => epoch,
    drain: () => {
      epoch += 1;
      return epoch;
    },
    isCurrent: (issuedEpoch: number) => issuedEpoch === epoch,
  });
}

export function createFakeRuntimeAuthDrainCoordinator(input: {
  readonly publish: (resetGeneration: number) => Promise<void>;
  readonly invalidate: () => Promise<void>;
  readonly revokeIssued: () => void;
  readonly advanceEpoch: () => void;
}): {
  handle(request: FakeRuntimeAuthDrainRequest): Promise<Readonly<Record<string, unknown>>>;
  isDrained(): boolean;
} {
  let state:
    | Readonly<{
        resetGeneration: number;
        publication: 'indeterminate' | 'confirmed';
      }>
    | null = null;
  const confirm = async (resetGeneration: number): Promise<Readonly<Record<string, unknown>>> => {
    try {
      await input.publish(resetGeneration);
      input.advanceEpoch();
      input.revokeIssued();
      state = Object.freeze({ resetGeneration, publication: 'confirmed' });
      return Object.freeze({ resetGeneration });
    } catch (error) {
      try {
        await input.invalidate();
        state = null;
      } catch {
        // Published bytes may be visible even though durability was not acknowledged. Keep the
        // owner fenced until the same drain is fully republished and authorization is revoked.
      }
      throw error;
    }
  };
  return Object.freeze({
    isDrained: () => state !== null,
    handle: async (request) => {
      if (request.operation === 'auth_drain_release') {
        if (request.resetGeneration !== state?.resetGeneration) {
          throw new Error('hosted_e2e_auth_drain_request_invalid');
        }
        if (state.publication !== 'confirmed') {
          throw new Error('hosted_e2e_auth_drain_unconfirmed');
        }
        await input.invalidate();
        state = null;
        return Object.freeze({ released: true });
      }
      if (state !== null) {
        if (request.resetGeneration !== state.resetGeneration) {
          throw new Error('hosted_e2e_auth_drain_unconfirmed');
        }
        if (state.publication === 'confirmed') {
          return Object.freeze({ resetGeneration: request.resetGeneration });
        }
        return confirm(request.resetGeneration);
      }
      state = Object.freeze({
        resetGeneration: request.resetGeneration,
        publication: 'indeterminate',
      });
      return confirm(request.resetGeneration);
    },
  });
}

export async function invalidateFakeRuntimeAuthDrainEvidence(path: string): Promise<void> {
  await rm(path, { force: true });
  await syncParentDirectory(path);
}

export async function publishFakeRuntimeAuthDrainEvidence(input: {
  readonly state: FakeRuntimeState;
  readonly resetGeneration: number;
  readonly observedAt: number;
  readonly path: string;
}): Promise<Readonly<{ resetGeneration: number }>> {
  if (
    !Number.isSafeInteger(input.resetGeneration) ||
    input.resetGeneration <= 0 ||
    !Number.isSafeInteger(input.observedAt)
  ) {
    throw new Error('hosted_e2e_auth_drain_request_invalid');
  }
  if (!Array.isArray(input.state.activeRuns) || input.state.activeRuns.length !== 0) {
    throw new Error('hosted_e2e_auth_drain_unconfirmed');
  }
  await durableReplaceText(
    input.path,
    `${JSON.stringify({
      format: 'agent-teams-runtime-drain/v1',
      deploymentId: DEPLOYMENT_ID,
      restoreGeneration: 0,
      purpose: 'host_reset',
      resetGeneration: input.resetGeneration,
      outcome: 'drained',
      evidenceRef: `fake-runtime:drain:host-reset-${input.resetGeneration}`,
      observedAt: input.observedAt,
      expiresAt: input.observedAt + 60_000,
    })}\n`
  );
  return Object.freeze({ resetGeneration: input.resetGeneration });
}

export async function startFakeRuntimeAuthDrainServer(input: {
  readonly socketPath: string;
  readonly queue: FakeRuntimeStateMutationQueue;
  readonly coordinator: ReturnType<typeof createFakeRuntimeAuthDrainCoordinator>;
}): Promise<{ close(): Promise<void> }> {
  const sockets = new Set<Socket>();
  const server = createNetServer({ allowHalfOpen: true }, (socket) => {
    sockets.add(socket);
    let body = '';
    let handled = false;
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      if (handled) return;
      body += chunk;
      if (Buffer.byteLength(body) > 1024) {
        handled = true;
        socket.end('{"ok":false,"code":"request_invalid"}\n');
      }
    });
    socket.once('end', () => {
      const newline = body.indexOf('\n');
      if (handled) return;
      if (newline < 0 || newline !== body.length - 1) {
        handled = true;
        socket.end('{"ok":false,"code":"request_invalid"}\n');
        return;
      }
      handled = true;
      void input.queue
        .run(() =>
          input.coordinator.handle(
            parseFakeRuntimeAuthDrainRequest(JSON.parse(body.slice(0, newline)))
          )
        )
        .then(
          (value) => socket.end(`${JSON.stringify({ ok: true, value })}\n`),
          (error) =>
            socket.end(
              `${JSON.stringify({
                ok: false,
                code:
                  error instanceof Error &&
                  error.message === 'hosted_e2e_auth_drain_unconfirmed'
                    ? 'drain_unconfirmed'
                    : 'request_invalid',
              })}\n`
            )
        );
    });
    socket.once('close', () => sockets.delete(socket));
    socket.once('error', () => undefined);
  });
  await rm(input.socketPath, { force: true });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(input.socketPath, resolve);
  });
  await chmod(input.socketPath, 0o600);
  return Object.freeze({
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      );
      await rm(input.socketPath, { force: true });
    },
  });
}

interface FakeRuntimeTaskLedgerEntry {
  readonly key: string;
  readonly fingerprint: string;
  readonly receipt: Record<string, unknown>;
  /** Exact validated WAL bytes represented structurally so every historical receipt is derivable. */
  readonly wal: FakeRuntimeTaskWal;
}

interface FakeRuntimeMessageLedgerEntry {
  readonly key: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly clientMessageId: string;
  readonly textHash: string;
  readonly messageId: string;
  readonly delivered: boolean;
}

export function fakeRuntimeProjectedMessageId(input: {
  readonly teamId: string;
  readonly rawMessageId: string;
  readonly from: string;
  readonly to: string | null;
}): string {
  return `message_${sha256(
    JSON.stringify({ domain: 'hosted-team-message-inbox/v1', ...input })
  ).slice(0, 32)}`;
}

export function fakeRuntimeAuthorizationIdentity(
  ownerBinding: Record<string, unknown>,
  counter: number
): Readonly<{ grantId: string; authorizationGeneration: string }> {
  if (!Number.isSafeInteger(counter) || counter < 1) {
    throw new Error('fake_runtime_authorization_counter_invalid');
  }
  const namespace = sha256(canonicalJson(ownerBinding)).slice(0, 16);
  const sequence = counter.toString().padStart(8, '0');
  return Object.freeze({
    grantId: `grant_hosted-v1-${namespace}-${sequence}`,
    authorizationGeneration: `authorization-generation_hosted-v1-e2e-${namespace}-${sequence}`,
  });
}

function fakeRuntimeLifecycleAcceptedResult(
  command: Record<string, unknown>,
  durableCommand: FakeRuntimeLifecycleDurableCommand
): Record<string, unknown> {
  return Object.freeze({
    schemaVersion: 1,
    kind: 'accepted',
    action: command.action,
    commandId: command.commandId,
    workspaceId: command.workspaceId,
    teamId: command.teamId,
    runId:
      command.action === 'launch'
        ? fakeRuntimeLifecycleRunId(
            String(command.teamId),
            durableCommand.commandFingerprint.digest
          )
        : command.runId,
    resourceRevision: fakeRuntimeLifecycleFinalRevision(durableCommand),
  });
}

type FakeRuntimeLifecycleNegativeDecision =
  | {
      readonly kind: 'conflict';
      readonly reason: 'stale_revision' | 'stale_run';
      readonly currentRevision: string;
    }
  | { readonly kind: 'not_found' };

function fakeRuntimeLifecycleNegativeResult(
  command: Record<string, unknown>,
  decision: FakeRuntimeLifecycleNegativeDecision
): Record<string, unknown> {
  const identity = {
    schemaVersion: 1 as const,
    action: command.action,
    commandId: command.commandId,
    workspaceId: command.workspaceId,
    teamId: command.teamId,
  };
  return decision.kind === 'conflict'
    ? Object.freeze({
        ...identity,
        kind: 'conflict' as const,
        reason: decision.reason,
        currentRevision: decision.currentRevision,
      })
    : Object.freeze({ ...identity, kind: 'not_found' as const });
}

function parseFakeRuntimeLifecycleSettledResult(
  value: unknown,
  command: Record<string, unknown>,
  durableCommand: FakeRuntimeLifecycleDurableCommand
): Record<string, unknown> {
  if (!isRecord(value)) throw new Error('fake_runtime_lifecycle_ledger_invalid');
  if (value.kind === 'accepted') {
    const expected = fakeRuntimeLifecycleAcceptedResult(command, durableCommand);
    if (canonicalJson(value) !== canonicalJson(expected)) {
      throw new Error('fake_runtime_lifecycle_ledger_invalid');
    }
    return expected;
  }
  if (
    value.kind === 'conflict' &&
    (value.reason === 'stale_revision' || value.reason === 'stale_run') &&
    typeof value.currentRevision === 'string' &&
    /^revision_[A-Za-z0-9_-]{32,128}$/u.test(value.currentRevision)
  ) {
    const expected = fakeRuntimeLifecycleNegativeResult(command, {
      kind: 'conflict',
      reason: value.reason,
      currentRevision: value.currentRevision,
    });
    if (canonicalJson(value) !== canonicalJson(expected)) {
      throw new Error('fake_runtime_lifecycle_ledger_invalid');
    }
    return expected;
  }
  if (value.kind === 'not_found') {
    const expected = fakeRuntimeLifecycleNegativeResult(command, { kind: 'not_found' });
    if (canonicalJson(value) !== canonicalJson(expected)) {
      throw new Error('fake_runtime_lifecycle_ledger_invalid');
    }
    return expected;
  }
  throw new Error('fake_runtime_lifecycle_ledger_invalid');
}

function parseFakeRuntimeLifecycleLedger(
  value: readonly FakeRuntimeLifecycleCommandLedgerEntry[] | undefined
): readonly FakeRuntimeLifecycleCommandLedgerEntry[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 512) {
    throw new Error('fake_runtime_lifecycle_ledger_invalid');
  }
  const parsed = value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(
        candidate,
        candidate.state === 'settled'
          ? ['key', 'command', 'durableCommand', 'state', 'result']
          : ['key', 'command', 'durableCommand', 'state']
      ) ||
      typeof candidate.key !== 'string' ||
      !['started', 'settled', 'operator_required'].includes(String(candidate.state))
    ) {
      throw new Error('fake_runtime_lifecycle_ledger_invalid');
    }
    const command = parseFakeRuntimeLifecycleCommand(candidate.command);
    if (!isRecord(candidate.durableCommand)) {
      throw new Error('fake_runtime_lifecycle_ledger_invalid');
    }
    const supplied = candidate.durableCommand;
    if (
      !isRecord(supplied.idempotency) ||
      !isRecord(supplied.resource) ||
      !isRecord(supplied.commandFingerprint)
    ) {
      throw new Error('fake_runtime_lifecycle_ledger_invalid');
    }
    const expected = fakeRuntimeLifecycleDurableCommand(
      command,
      {
        deploymentId: supplied.idempotency.deploymentId,
        actorId: supplied.idempotency.actorId,
        bootId: supplied.resource.bootId,
      },
      {
        restoreGeneration: supplied.resource.restoreGeneration,
        mountGeneration: supplied.resource.mountGeneration,
        ownerEffectFence: supplied.resource.ownerEffectFence,
      }
    );
    if (
      canonicalJson(supplied) !== canonicalJson(expected) ||
      candidate.key !== fakeRuntimeLifecycleLedgerKey(expected)
    ) {
      throw new Error('fake_runtime_lifecycle_ledger_invalid');
    }
    const result =
      candidate.state === 'settled'
        ? parseFakeRuntimeLifecycleSettledResult(candidate.result, command, expected)
        : undefined;
    return Object.freeze({
      key: candidate.key,
      command,
      durableCommand: expected,
      state: candidate.state,
      ...(result === undefined ? {} : { result }),
    }) as FakeRuntimeLifecycleCommandLedgerEntry;
  });
  if (new Set(parsed.map((entry) => entry.key)).size !== parsed.length) {
    throw new Error('fake_runtime_lifecycle_ledger_invalid');
  }
  return Object.freeze(parsed);
}

function parseFakeRuntimeLifecycleReleaseLedger(
  value: readonly FakeRuntimeLifecycleReleaseLedgerEntry[] | undefined
): readonly FakeRuntimeLifecycleReleaseLedgerEntry[] {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 512) {
    throw new Error('fake_runtime_lifecycle_release_ledger_invalid');
  }
  const parsed = value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['key', 'authorization', 'ownerBinding', 'drainEpoch']) ||
      typeof candidate.key !== 'string' ||
      !isRecord(candidate.authorization) ||
      !isRecord(candidate.ownerBinding) ||
      !Number.isSafeInteger(candidate.drainEpoch) ||
      (candidate.drainEpoch as number) < 0
    ) {
      throw new Error('fake_runtime_lifecycle_release_ledger_invalid');
    }
    return Object.freeze({
      key: candidate.key,
      authorization: Object.freeze({ ...candidate.authorization }),
      ownerBinding: Object.freeze({ ...candidate.ownerBinding }),
      drainEpoch: candidate.drainEpoch as number,
    });
  });
  if (new Set(parsed.map((entry) => entry.key)).size !== parsed.length) {
    throw new Error('fake_runtime_lifecycle_release_ledger_invalid');
  }
  return Object.freeze(parsed);
}

function withFakeRuntimeLifecycleRelease(
  state: FakeRuntimeState,
  entry: FakeRuntimeLifecycleReleaseLedgerEntry
): FakeRuntimeState {
  const ledger = parseFakeRuntimeLifecycleReleaseLedger(state.lifecycleReleaseLedger);
  return Object.freeze({
    ...state,
    lifecycleReleaseLedger: Object.freeze([
      ...ledger.filter((candidate) => candidate.key !== entry.key),
      entry,
    ]),
  });
}

interface FakeRuntimeInboxOperationMarker {
  readonly schemaVersion: 1;
  readonly domain: 'agent-teams.hosted-v1-e2e.message-persist/v1';
  readonly actorId: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly clientMessageId: string;
  readonly textHash: string;
  readonly messageId: string;
}

export interface FakeRuntimeMessagePersistenceInput {
  readonly runtimeStatePath: string;
  readonly inboxPath: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly clientMessageId: string;
  readonly text: string;
  readonly timestamp?: string;
  readonly ownerProvenance?: Readonly<{
    trustAnchor: string;
    deploymentId: string;
    bootId: string;
    mountGeneration: number;
    ownerBinding: Readonly<Record<string, unknown>>;
  }>;
  /** Test-only serialization seam after the durable row set was observed and before publication. */
  readonly afterInboxRead?: () => void | Promise<void>;
  /** Last authority fence before either the inbox row or replay ledger can be committed. */
  readonly beforeCommit?: () => void | Promise<void>;
  /** Test-only crash seam. The inbox rename has committed before this hook runs. */
  readonly afterInboxRename?: () => void | Promise<void>;
  /** Test-only race seam after the diagnostic ledger fsync and before final acknowledgement. */
  readonly afterLedgerWrite?: () => void | Promise<void>;
}

export type FakeRuntimeMessagePersistenceResult =
  | {
      readonly kind: 'persisted' | 'idempotent_replay';
      readonly entry: FakeRuntimeMessageLedgerEntry;
    }
  | { readonly kind: 'conflict' };

export interface FakeRuntimeMessageDeliveryInput {
  readonly runtimeStatePath: string;
  readonly inboxPath: string;
  readonly actorId: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly clientMessageId: string;
  readonly messageId: string;
  readonly text: string;
  /** Test-only crash seam. The atomic recipient acknowledgement already committed. */
  readonly afterInboxRename?: () => void | Promise<void>;
  /** Last authority fence before either the acknowledgement or replay ledger can be committed. */
  readonly beforeCommit?: () => void | Promise<void>;
  /** Test-only race seam after the diagnostic ledger fsync and before final acknowledgement. */
  readonly afterLedgerWrite?: () => void | Promise<void>;
}

const runtimeStatePath = `${FAKE_RUNTIME_STATE_ROOT}/runtime-state.json`;

async function readRuntimeState(path = runtimeStatePath): Promise<FakeRuntimeState> {
  try {
    return JSON.parse(await readFile(path, 'utf8')) as FakeRuntimeState;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return {
      schemaVersion: 1,
      activeRuns: [],
      commands: [],
      eventIds: [],
      messageLedger: [],
      taskLedger: [],
      lifecycleCommandLedger: [],
      lifecycleReleaseLedger: [],
    };
  }
}

function parentDirectory(path: string): string {
  const separator = path.lastIndexOf('/');
  if (separator < 1) throw new Error('hosted_e2e_durable_path_invalid');
  return path.slice(0, separator);
}

async function syncParentDirectory(path: string): Promise<void> {
  const directory = await open(parentDirectory(path), 'r');
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}

/** Publishes bytes only after the file and its directory entry are durable. */
async function durableReplaceText(path: string, text: string): Promise<void> {
  const temporaryPath = `${path}.tmp-${process.pid}-${randomBytes(8).toString('hex')}`;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporaryPath, path);
    await syncParentDirectory(path);
  } catch (error) {
    await rm(temporaryPath, { force: true });
    throw error;
  }
}

async function durableReplaceTextIfUnchanged(
  path: string,
  text: string,
  expectedText: string | null,
  beforeDetach?: () => void | Promise<void>
): Promise<void> {
  const suffix = `${process.pid}-${randomBytes(16).toString('hex')}`;
  const temporaryPath = `${path}.wal-stage-${suffix}`;
  const pinPath = `${path}.wal-pin-${suffix}`;
  let temporaryCreated = false;
  let pinCreated = false;
  let targetRemoved = false;
  try {
    const handle = await open(temporaryPath, 'wx', 0o600);
    temporaryCreated = true;
    try {
      await handle.writeFile(text, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
    if (expectedText !== null) {
      try {
        await lstat(pinPath);
        throw new Error('fake_runtime_task_wal_artifact_collision');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      await beforeDetach?.();
      try {
        await rename(path, pinPath);
        pinCreated = true;
        targetRemoved = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          throw new Error('fake_runtime_task_wal_target_raced');
        }
        throw error;
      }
      const [pinStat, pinText] = await Promise.all([
        lstat(pinPath, { bigint: true }),
        readFile(pinPath, 'utf8'),
      ]);
      if (!pinStat.isFile() || pinStat.isSymbolicLink() || pinText !== expectedText) {
        throw new Error('fake_runtime_task_wal_target_raced');
      }
    } else {
      await beforeDetach?.();
    }
    try {
      await link(temporaryPath, path);
      targetRemoved = false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
        throw new Error('fake_runtime_task_wal_target_raced');
      }
      throw error;
    }
    await syncParentDirectory(path);
    const [publishedStat, stagedStat, publishedText] = await Promise.all([
      lstat(path, { bigint: true }),
      lstat(temporaryPath, { bigint: true }),
      readFile(path, 'utf8'),
    ]);
    if (
      publishedStat.dev !== stagedStat.dev ||
      publishedStat.ino !== stagedStat.ino ||
      publishedText !== text
    ) {
      throw new Error('fake_runtime_task_wal_target_raced');
    }
    if (pinCreated && (await readFile(pinPath, 'utf8')) !== expectedText) {
      const current = await lstat(path, { bigint: true });
      if (current.dev !== stagedStat.dev || current.ino !== stagedStat.ino) {
        throw new Error('fake_runtime_task_wal_target_raced');
      }
      await unlink(path);
      targetRemoved = true;
      try {
        await link(pinPath, path);
        targetRemoved = false;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
      await syncParentDirectory(path);
      throw new Error('fake_runtime_task_wal_target_raced');
    }
    if (pinCreated) {
      await unlink(pinPath);
      pinCreated = false;
    }
    await unlink(temporaryPath);
    temporaryCreated = false;
    await syncParentDirectory(path);
  } catch (error) {
    if (targetRemoved && pinCreated) {
      try {
        await link(pinPath, path);
        targetRemoved = false;
      } catch (restoreError) {
        if ((restoreError as NodeJS.ErrnoException).code !== 'EEXIST') throw restoreError;
      }
      await syncParentDirectory(path).catch(() => undefined);
    }
    if (pinCreated) await rm(pinPath, { force: true }).catch(() => undefined);
    if (temporaryCreated) await rm(temporaryPath, { force: true }).catch(() => undefined);
    await syncParentDirectory(path).catch(() => undefined);
    throw error;
  }
}

/** Makes removal of a completed WAL durable before the caller reports settlement. */
async function durableRemoveFile(path: string): Promise<void> {
  await rm(path, { force: true });
  await syncParentDirectory(path);
}

async function writeRuntimeState(state: FakeRuntimeState, path = runtimeStatePath): Promise<void> {
  await durableReplaceText(path, `${JSON.stringify(state, null, 2)}\n`);
}

async function appendLaunchProgressEvent(
  command: Record<string, unknown>,
  runId: string,
  databasePath = `${AUTH_DATA_ROOT}/storage/app.db`,
  beforeEffect: () => void = () => undefined
): Promise<string> {
  const { DatabaseSync } = await import('node:sqlite');
  // The module load is asynchronous. Revalidate the serialized owner lease and deadline after it,
  // immediately before opening or mutating the coordination database.
  beforeEffect();
  const database = new DatabaseSync(databasePath);
  database.exec('PRAGMA busy_timeout = 5000');
  try {
    beforeEffect();
    database.exec('BEGIN IMMEDIATE');
    try {
      // BEGIN may have waited for another writer. Do not publish the first row under an expired or
      // rebound authority merely because the fence was valid before lock acquisition.
      beforeEffect();
      const now = new Date().toISOString();
      const eventEpoch = `epoch-initial-v1-${sha256(DEPLOYMENT_ID).slice(0, 24)}`;
      database
        .prepare(
          `INSERT OR IGNORE INTO coordination_event_journal_metadata (
            deployment_id, event_epoch, retention_floor_sequence,
            high_watermark_sequence, created_at, updated_at
          ) VALUES (?, ?, 0, 0, ?, ?)`
        )
        .run(DEPLOYMENT_ID, eventEpoch, now, now);
      const metadata = database
        .prepare(
          `SELECT event_epoch, high_watermark_sequence
           FROM coordination_event_journal_metadata WHERE deployment_id = ?`
        )
        .get(DEPLOYMENT_ID) as { event_epoch: string; high_watermark_sequence: number } | undefined;
      if (!metadata) throw new Error('hosted_e2e_event_metadata_missing');
      if (metadata.event_epoch !== eventEpoch) throw new Error('hosted_e2e_event_epoch_mismatch');
      const sequence = metadata.high_watermark_sequence + 1;
      const eventId = `event_hosted-v1-e2e-launch-${sequence}`;
      const teamId = String(command.teamId);
      // Lifecycle commands use the public workspace identity at the HTTP edge,
      // while durable coordination events retain the internal runtime identity
      // and are projected back to the public ID by the hosted authorizer.
      const workspaceId = RUNTIME_WORKSPACE_ID;
      const eventBody = canonicalJson({
        schemaVersion: 1,
        eventId,
        scope: { kind: 'team', scopeId: teamId },
        workspaceId,
        teamId,
        runId,
        actor: {
          kind: 'verified_runtime',
          actorRef: 'runtime_hosted-v1-e2e',
          runId,
        },
        eventType: 'team-lifecycle.run-accepted',
        resourceRevision: {
          resourceKey: teamId,
          generation: 1,
          revision: sequence,
        },
        emittedAt: now,
        payload: {
          fileWriterEpoch: 1,
          generation: 1,
          planHash: sha256(`${teamId}:${runId}`),
          runId,
          watcherWatermark: 0,
        },
      });
      database
        .prepare(
          `INSERT INTO coordination_event_journal (
            deployment_id, event_epoch, event_sequence, event_id, body_json,
            emitted_at, origin_command_id, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?)`
        )
        .run(DEPLOYMENT_ID, eventEpoch, sequence, eventId, eventBody, now, now);
      database
        .prepare(
          `UPDATE coordination_event_journal_metadata
           SET high_watermark_sequence = ?, updated_at = ?
           WHERE deployment_id = ? AND event_epoch = ?`
        )
        .run(sequence, now, DEPLOYMENT_ID, eventEpoch);
      database.exec('COMMIT');
      return eventId;
    } catch (error) {
      database.exec('ROLLBACK');
      throw error;
    }
  } finally {
    database.close();
  }
}

export async function recordRuntimeExecution(
  command: Record<string, unknown>,
  runId: string,
  path = runtimeStatePath,
  coordinationDatabasePath = `${AUTH_DATA_ROOT}/storage/app.db`,
  durableCommand?: FakeRuntimeLifecycleDurableCommand,
  resourceRevision = String(command.expectedRevision),
  beforeEffect: () => void = () => undefined
): Promise<void> {
  const action = String(command.action);
  const teamId = String(command.teamId);
  const previous = await readRuntimeState(path);
  const active = new Map(previous.activeRuns.map((run) => [run.teamId, run]));
  if (action === 'launch' || action === 'recover') active.set(teamId, { teamId, runId });
  if (action === 'stop' || action === 'cancel') active.delete(teamId);
  const eventIds = [...previous.eventIds];
  beforeEffect();
  const eventId =
    action === 'launch'
      ? await appendLaunchProgressEvent(command, runId, coordinationDatabasePath, beforeEffect)
      : undefined;
  if (eventId !== undefined) eventIds.push(eventId);
  const executed: FakeRuntimeCommand = {
    action,
    commandId: String(command.commandId),
    ...(eventId === undefined ? {} : { eventId }),
    runId,
    teamId,
    workspaceId: String(command.workspaceId),
    resourceRevision,
    ...(durableCommand === undefined ? {} : { durableCommand }),
  };
  beforeEffect();
  await writeRuntimeState(
    {
      schemaVersion: 1,
      ...(previous.lifecycleInitialRevision === undefined
        ? {}
        : { lifecycleInitialRevision: previous.lifecycleInitialRevision }),
      activeRuns: [...active.values()],
      commands: [...previous.commands, executed],
      eventIds,
      messageLedger: previous.messageLedger,
      taskLedger: previous.taskLedger ?? [],
      lifecycleCommandLedger: previous.lifecycleCommandLedger ?? [],
      lifecycleReleaseLedger: previous.lifecycleReleaseLedger ?? [],
    },
    path
  );
}

type FakeRuntimeLifecycleLedgerResolution =
  | { readonly kind: 'not_started' }
  | { readonly kind: 'idempotency_mismatch' }
  | { readonly kind: 'operator_required' }
  | {
      readonly kind: 'settled';
      readonly entry: FakeRuntimeLifecycleCommandLedgerEntry;
      readonly replayed: boolean;
    };

type FakeRuntimeLifecycleAdmission =
  | { readonly kind: 'admit'; readonly exactReplay: boolean }
  | { readonly kind: 'stale_revision'; readonly currentRevision: string }
  | { readonly kind: 'stale_run'; readonly currentRevision: string }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'idempotency_mismatch' }
  | { readonly kind: 'operator_required' };

function assertFakeRuntimeCommandRow(candidate: FakeRuntimeCommand): void {
  const expectedKeys = [
    'action',
    'commandId',
    ...(candidate.action === 'launch' ? ['eventId'] : []),
    'runId',
    'teamId',
    'workspaceId',
    'resourceRevision',
    ...(candidate.durableCommand === undefined ? [] : ['durableCommand']),
  ];
  if (
    !isRecord(candidate) ||
    !hasExactKeys(candidate, expectedKeys) ||
    !['launch', 'recover', 'stop', 'cancel'].includes(candidate.action) ||
    typeof candidate.commandId !== 'string' ||
    typeof candidate.runId !== 'string' ||
    !/^run_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(candidate.runId) ||
    typeof candidate.teamId !== 'string' ||
    typeof candidate.workspaceId !== 'string' ||
    typeof candidate.resourceRevision !== 'string' ||
    !/^revision_[A-Za-z0-9_-]{32,128}$/u.test(candidate.resourceRevision) ||
    (candidate.action === 'launch' &&
      (typeof candidate.eventId !== 'string' ||
        !/^event_hosted-v1-e2e-launch-[1-9][0-9]*$/u.test(candidate.eventId)))
  ) {
    throw new Error('fake_runtime_lifecycle_postimage_invalid');
  }
}

/** Validates the complete append-only effect history before any historical receipt is replayed. */
function fakeRuntimeLifecycleProjectionMatches(state: FakeRuntimeState): boolean {
  try {
    const active = new Map<string, Readonly<{ teamId: string; runId: string }>>();
    const eventIds: string[] = [];
    for (const command of state.commands) {
      assertFakeRuntimeCommandRow(command);
      if (command.action === 'launch' || command.action === 'recover') {
        active.set(command.teamId, { teamId: command.teamId, runId: command.runId });
      } else {
        active.delete(command.teamId);
      }
      if (command.eventId !== undefined) eventIds.push(command.eventId);
    }
    const expectedRuns = [...active.values()].sort((left, right) =>
      left.teamId.localeCompare(right.teamId)
    );
    const actualRuns = [...state.activeRuns].sort((left, right) =>
      left.teamId.localeCompare(right.teamId)
    );
    return (
      canonicalJson(actualRuns) === canonicalJson(expectedRuns) &&
      canonicalJson(state.eventIds) === canonicalJson(eventIds)
    );
  } catch {
    return false;
  }
}

function fakeRuntimeLifecycleCanonicalRevision(
  state: FakeRuntimeState,
  workspaceId: unknown,
  teamId: unknown
): string | null {
  let revision: string | null = state.lifecycleInitialRevision ?? null;
  if (revision !== null && !/^revision_[A-Za-z0-9_-]{32,128}$/u.test(revision)) {
    throw new Error('fake_runtime_lifecycle_initial_revision_invalid');
  }
  for (const candidate of state.commands) {
    if (candidate.workspaceId !== workspaceId || candidate.teamId !== teamId) continue;
    assertFakeRuntimeCommandRow(candidate);
    revision = candidate.resourceRevision;
  }
  return revision;
}

function inspectFakeRuntimeLifecycleAdmission(
  state: FakeRuntimeState,
  command: Record<string, unknown>,
  durableCommand: FakeRuntimeLifecycleDurableCommand
): FakeRuntimeLifecycleAdmission {
  const ledger = parseFakeRuntimeLifecycleLedger(state.lifecycleCommandLedger);
  const key = fakeRuntimeLifecycleLedgerKey(durableCommand);
  const existing = ledger.find((entry) => entry.key === key);
  const exactReplay =
    existing !== undefined &&
    canonicalJson(existing.command) === canonicalJson(command) &&
    canonicalJson(existing.durableCommand) === canonicalJson(durableCommand);
  if (exactReplay) return Object.freeze({ kind: 'admit', exactReplay: true });
  if (existing !== undefined) return Object.freeze({ kind: 'idempotency_mismatch' });
  if (!fakeRuntimeLifecycleProjectionMatches(state)) {
    return Object.freeze({ kind: 'operator_required' });
  }
  if (
    ledger.some(
      (entry) =>
        entry.state !== 'settled' &&
        entry.command.workspaceId === command.workspaceId &&
        entry.command.teamId === command.teamId
    )
  ) {
    return Object.freeze({ kind: 'operator_required' });
  }
  const currentRevision = fakeRuntimeLifecycleCanonicalRevision(
    state,
    command.workspaceId,
    command.teamId
  );
  if (currentRevision !== null && currentRevision !== command.expectedRevision) {
    return Object.freeze({ kind: 'stale_revision', currentRevision });
  }
  const activeRuns = state.activeRuns.filter((entry) => entry.teamId === command.teamId);
  if (activeRuns.length > 1) return Object.freeze({ kind: 'operator_required' });
  const latestCommand = [...state.commands]
    .reverse()
    .find(
      (candidate) =>
        candidate.workspaceId === command.workspaceId && candidate.teamId === command.teamId
    );
  if (
    command.action !== 'launch' &&
    activeRuns[0] !== undefined &&
    activeRuns[0].runId !== command.runId
  ) {
    return Object.freeze({
      kind: 'stale_run',
      currentRevision: currentRevision ?? String(command.expectedRevision),
    });
  }
  if ((command.action === 'stop' || command.action === 'cancel') && activeRuns.length === 0) {
    return Object.freeze({ kind: 'not_found' });
  }
  if (
    command.action === 'recover' &&
    (latestCommand === undefined || latestCommand.runId !== command.runId)
  ) {
    return latestCommand === undefined
      ? Object.freeze({ kind: 'not_found' })
      : Object.freeze({
          kind: 'stale_run',
          currentRevision: currentRevision ?? String(command.expectedRevision),
        });
  }
  if (command.action === 'launch' && activeRuns.length !== 0) {
    return Object.freeze({ kind: 'operator_required' });
  }
  return Object.freeze({ kind: 'admit', exactReplay: false });
}

function replaceFakeRuntimeLifecycleLedgerEntry(
  state: FakeRuntimeState,
  entry: FakeRuntimeLifecycleCommandLedgerEntry
): FakeRuntimeState {
  const ledger = parseFakeRuntimeLifecycleLedger(state.lifecycleCommandLedger);
  return Object.freeze({
    ...state,
    lifecycleCommandLedger: Object.freeze([
      ...ledger.filter((candidate) => candidate.key !== entry.key),
      entry,
    ]),
  });
}

function fakeRuntimeLifecycleCommandPostimageMatches(
  state: FakeRuntimeState,
  command: Record<string, unknown>,
  durableCommand: FakeRuntimeLifecycleDurableCommand
): boolean {
  const finalRevision = fakeRuntimeLifecycleFinalRevision(durableCommand);
  const runId =
    command.action === 'launch'
      ? fakeRuntimeLifecycleRunId(String(command.teamId), durableCommand.commandFingerprint.digest)
      : String(command.runId);
  const matches = state.commands.filter(
    (candidate) =>
      candidate.commandId === command.commandId &&
      candidate.teamId === command.teamId &&
      candidate.workspaceId === command.workspaceId
  );
  const exactCommand = matches[0];
  const commandPostimageMatches =
    matches.length === 1 &&
    isRecord(exactCommand) &&
    hasExactKeys(exactCommand, [
      'action',
      'commandId',
      ...(command.action === 'launch' ? ['eventId'] : []),
      'runId',
      'teamId',
      'workspaceId',
      'resourceRevision',
      'durableCommand',
    ]) &&
    exactCommand.action === command.action &&
    exactCommand.runId === runId &&
    exactCommand.resourceRevision === finalRevision &&
    canonicalJson(exactCommand.durableCommand) === canonicalJson(durableCommand);
  return commandPostimageMatches;
}

function fakeRuntimeLifecycleCurrentPostimageMatches(
  state: FakeRuntimeState,
  command: Record<string, unknown>,
  durableCommand: FakeRuntimeLifecycleDurableCommand
): boolean {
  if (
    !fakeRuntimeLifecycleCommandPostimageMatches(state, command, durableCommand) ||
    !fakeRuntimeLifecycleProjectionMatches(state)
  ) {
    return false;
  }
  const latest = [...state.commands]
    .reverse()
    .find(
      (candidate) =>
        candidate.workspaceId === command.workspaceId && candidate.teamId === command.teamId
    );
  if (latest?.commandId !== command.commandId) return false;
  const runId =
    command.action === 'launch'
      ? fakeRuntimeLifecycleRunId(String(command.teamId), durableCommand.commandFingerprint.digest)
      : String(command.runId);
  const active = state.activeRuns.filter((candidate) => candidate.teamId === command.teamId);
  const runPostimageMatches =
    command.action === 'launch' || command.action === 'recover'
      ? active.length === 1 &&
        isRecord(active[0]) &&
        hasExactKeys(active[0], ['teamId', 'runId']) &&
        active[0].runId === runId
      : active.length === 0;
  return runPostimageMatches;
}

async function resolveFakeRuntimeLifecycleLedger(
  command: Record<string, unknown>,
  durableCommand: FakeRuntimeLifecycleDurableCommand
): Promise<FakeRuntimeLifecycleLedgerResolution> {
  const state = await readRuntimeState();
  const ledger = parseFakeRuntimeLifecycleLedger(state.lifecycleCommandLedger);
  const key = fakeRuntimeLifecycleLedgerKey(durableCommand);
  const existing = ledger.find((entry) => entry.key === key);
  if (existing === undefined) return Object.freeze({ kind: 'not_started' });
  if (
    canonicalJson(existing.command) !== canonicalJson(command) ||
    canonicalJson(existing.durableCommand) !== canonicalJson(durableCommand)
  ) {
    return Object.freeze({ kind: 'idempotency_mismatch' });
  }
  if (existing.state === 'settled') {
    if (
      fakeRuntimeLifecycleCommandPostimageMatches(state, command, durableCommand) &&
      fakeRuntimeLifecycleProjectionMatches(state)
    ) {
      return Object.freeze({ kind: 'settled', entry: existing, replayed: true });
    }
    const operatorRequired = Object.freeze({
      key: existing.key,
      command: existing.command,
      durableCommand: existing.durableCommand,
      state: 'operator_required' as const,
    });
    await writeRuntimeState(replaceFakeRuntimeLifecycleLedgerEntry(state, operatorRequired));
    return Object.freeze({ kind: 'operator_required' });
  }
  if (existing.state === 'operator_required') {
    return Object.freeze({ kind: 'operator_required' });
  }
  const next: FakeRuntimeLifecycleCommandLedgerEntry = fakeRuntimeLifecycleCurrentPostimageMatches(
    state,
    command,
    durableCommand
  )
    ? Object.freeze({
        ...existing,
        state: 'settled' as const,
        result: fakeRuntimeLifecycleAcceptedResult(command, durableCommand),
      })
    : Object.freeze({ ...existing, state: 'operator_required' as const });
  await writeRuntimeState(replaceFakeRuntimeLifecycleLedgerEntry(state, next));
  return next.state === 'settled'
    ? Object.freeze({ kind: 'settled', entry: next, replayed: true })
    : Object.freeze({ kind: 'operator_required' });
}

async function executeFakeRuntimeLifecycleDurably(
  command: Record<string, unknown>,
  durableCommand: FakeRuntimeLifecycleDurableCommand,
  beforeEffect: () => void = () => undefined
): Promise<FakeRuntimeLifecycleLedgerResolution> {
  const existing = await resolveFakeRuntimeLifecycleLedger(command, durableCommand);
  if (existing.kind !== 'not_started') return existing;
  const before = await readRuntimeState();
  const admission = inspectFakeRuntimeLifecycleAdmission(before, command, durableCommand);
  if (admission.kind !== 'admit') {
    return Object.freeze({ kind: 'operator_required' });
  }
  const started: FakeRuntimeLifecycleCommandLedgerEntry = Object.freeze({
    key: fakeRuntimeLifecycleLedgerKey(durableCommand),
    command: Object.freeze({ ...command }),
    durableCommand,
    state: 'started',
  });
  // This fsynced state is the uncertainty boundary: no effect can begin before it is durable.
  await writeRuntimeState(replaceFakeRuntimeLifecycleLedgerEntry(before, started));
  beforeEffect();
  const runId =
    command.action === 'launch'
      ? fakeRuntimeLifecycleRunId(String(command.teamId), durableCommand.commandFingerprint.digest)
      : String(command.runId);
  const finalRevision = fakeRuntimeLifecycleFinalRevision(durableCommand);
  await recordRuntimeExecution(
    command,
    runId,
    runtimeStatePath,
    `${AUTH_DATA_ROOT}/storage/app.db`,
    durableCommand,
    finalRevision,
    beforeEffect
  );
  const afterEffect = await readRuntimeState();
  if (!fakeRuntimeLifecycleCurrentPostimageMatches(afterEffect, command, durableCommand)) {
    const operatorRequired = Object.freeze({
      ...started,
      state: 'operator_required' as const,
    });
    await writeRuntimeState(replaceFakeRuntimeLifecycleLedgerEntry(afterEffect, operatorRequired));
    return Object.freeze({ kind: 'operator_required' });
  }
  // The external state and coordination-event effects are now durable. Revalidate the exact
  // owner/grant/identity fence again before publishing settlement so revocation racing the fsync
  // can never receive a success response from the old authority.
  beforeEffect();
  const settled: FakeRuntimeLifecycleCommandLedgerEntry = Object.freeze({
    ...started,
    state: 'settled',
    result: fakeRuntimeLifecycleAcceptedResult(command, durableCommand),
  });
  // The settled receipt and exact postimage are fsynced before a success response is possible.
  await writeRuntimeState(replaceFakeRuntimeLifecycleLedgerEntry(afterEffect, settled));
  beforeEffect();
  return Object.freeze({ kind: 'settled', entry: settled, replayed: false });
}

function fakeRuntimeLifecycleDurableOutcome(
  resolution: FakeRuntimeLifecycleLedgerResolution,
  durableCommand: FakeRuntimeLifecycleDurableCommand,
  authorization: Record<string, unknown>,
  operation: 'execute' | 'replay_lookup'
): Record<string, unknown> {
  if (resolution.kind !== 'settled') {
    return Object.freeze({ schemaVersion: 2, kind: resolution.kind, durableCommand });
  }
  const finalRevision = fakeRuntimeLifecycleFinalRevision(durableCommand);
  return Object.freeze({
    schemaVersion: 2,
    kind: 'settled',
    durableCommand,
    result: Object.freeze({
      ...resolution.entry.result,
      kind: operation === 'execute' && !resolution.replayed ? 'accepted' : 'idempotent_replay',
    }),
    authorization: Object.freeze({ ...authorization, resourceRevision: finalRevision }),
  });
}

function parseFakeRuntimeInboxOperationMarker(
  value: unknown
): FakeRuntimeInboxOperationMarker | null {
  if (!isRecord(value) || !hasExactKeys(value, ['hostedOperation'])) return null;
  const marker = value.hostedOperation;
  if (
    !isRecord(marker) ||
    !hasExactKeys(marker, [
      'schemaVersion',
      'domain',
      'actorId',
      'workspaceId',
      'teamId',
      'clientMessageId',
      'textHash',
      'messageId',
    ]) ||
    marker.schemaVersion !== 1 ||
    marker.domain !== 'agent-teams.hosted-v1-e2e.message-persist/v1' ||
    typeof marker.actorId !== 'string' ||
    typeof marker.workspaceId !== 'string' ||
    typeof marker.teamId !== 'string' ||
    typeof marker.clientMessageId !== 'string' ||
    !CLIENT_MESSAGE_ID_PATTERN.test(marker.clientMessageId) ||
    typeof marker.textHash !== 'string' ||
    !/^[0-9a-f]{64}$/.test(marker.textHash) ||
    typeof marker.messageId !== 'string'
  ) {
    throw new Error('hosted_e2e_fake_runtime_operation_marker_invalid');
  }
  return marker as unknown as FakeRuntimeInboxOperationMarker;
}

function fakeRuntimeMessageLedgerEntry(
  marker: FakeRuntimeInboxOperationMarker
): FakeRuntimeMessageLedgerEntry {
  const key = [marker.actorId, marker.workspaceId, marker.teamId, marker.clientMessageId].join(
    '\u0000'
  );
  const expectedMessageId = `message_${sha256(`${key}\u0000${marker.textHash}`).slice(0, 32)}`;
  if (marker.messageId !== expectedMessageId) {
    throw new Error('hosted_e2e_fake_runtime_operation_marker_invalid');
  }
  return {
    key,
    actorId: marker.actorId,
    workspaceId: marker.workspaceId,
    teamId: marker.teamId,
    clientMessageId: marker.clientMessageId,
    textHash: marker.textHash,
    messageId: marker.messageId,
    delivered: false,
  };
}

function normalizedFakeRuntimeMessageText(text: string): string {
  return text.replace(/\r\n?/gu, '\n').trim();
}

/**
 * Treats the inbox row, not its self-described marker, as the durable message postimage. A marker
 * can be used for replay only when every derived field recomputes from the actual row.
 */
function fakeRuntimeMessageLedgerEntryFromInboxRow(
  message: Record<string, unknown>
): FakeRuntimeMessageLedgerEntry {
  const rowKeys = [
    'from',
    'to',
    'text',
    'timestamp',
    'source',
    'messageId',
    'hostedOperation',
    ...(Object.hasOwn(message, 'hostedOwnerProvenance') ? ['hostedOwnerProvenance'] : []),
    ...(Object.hasOwn(message, 'hostedDelivery') ? ['hostedDelivery'] : []),
  ];
  const marker = parseFakeRuntimeInboxOperationMarker({
    hostedOperation: message.hostedOperation,
  });
  if (
    !hasExactKeys(message, rowKeys) ||
    marker === null ||
    message.from !== 'user' ||
    typeof message.text !== 'string' ||
    message.to !== 'team-lead' ||
    message.source !== 'user_sent' ||
    typeof message.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(message.timestamp)) ||
    new Date(message.timestamp).toISOString() !== message.timestamp ||
    message.messageId !== marker.messageId ||
    sha256(normalizedFakeRuntimeMessageText(message.text)) !== marker.textHash
  ) {
    throw new Error('hosted_e2e_fake_runtime_operation_marker_invalid');
  }
  const entry = fakeRuntimeMessageLedgerEntry(marker);
  if (
    Object.hasOwn(message, 'hostedDelivery') &&
    !sameFakeRuntimeDeliveryMarker(message.hostedDelivery, fakeRuntimeDeliveryMarker(entry))
  ) {
    throw new Error('hosted_e2e_fake_runtime_operation_marker_invalid');
  }
  return entry;
}

async function reconcileFakeRuntimeMessageLedger(
  path: string,
  entry: FakeRuntimeMessageLedgerEntry
): Promise<void> {
  const state = await readRuntimeState(path);
  const ledger = parseFakeRuntimeMessageLedger(state.messageLedger);
  const existing = ledger.find((candidate) => candidate.key === entry.key);
  if (existing !== undefined) {
    if (
      existing.actorId !== entry.actorId ||
      existing.workspaceId !== entry.workspaceId ||
      existing.teamId !== entry.teamId ||
      existing.clientMessageId !== entry.clientMessageId ||
      existing.textHash !== entry.textHash ||
      existing.messageId !== entry.messageId
    ) {
      throw new Error('hosted_e2e_fake_runtime_message_ledger_conflict');
    }
    return;
  }
  await writeRuntimeState({ ...state, messageLedger: [...ledger, entry] }, path);
}

function parseFakeRuntimeMessageLedger(value: unknown): readonly FakeRuntimeMessageLedgerEntry[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new Error('hosted_e2e_fake_runtime_message_ledger_invalid');
  }
  const entries = value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, [
        'key',
        'actorId',
        'workspaceId',
        'teamId',
        'clientMessageId',
        'textHash',
        'messageId',
        'delivered',
      ]) ||
      typeof candidate.actorId !== 'string' ||
      typeof candidate.workspaceId !== 'string' ||
      typeof candidate.teamId !== 'string' ||
      typeof candidate.clientMessageId !== 'string' ||
      !CLIENT_MESSAGE_ID_PATTERN.test(candidate.clientMessageId) ||
      typeof candidate.textHash !== 'string' ||
      !/^[0-9a-f]{64}$/u.test(candidate.textHash) ||
      typeof candidate.messageId !== 'string' ||
      !/^message_[0-9a-f]{32}$/u.test(candidate.messageId) ||
      typeof candidate.delivered !== 'boolean'
    ) {
      throw new Error('hosted_e2e_fake_runtime_message_ledger_invalid');
    }
    const key = [
      candidate.actorId,
      candidate.workspaceId,
      candidate.teamId,
      candidate.clientMessageId,
    ].join('\u0000');
    if (candidate.key !== key) {
      throw new Error('hosted_e2e_fake_runtime_message_ledger_invalid');
    }
    return Object.freeze({
      key,
      actorId: candidate.actorId,
      workspaceId: candidate.workspaceId,
      teamId: candidate.teamId,
      clientMessageId: candidate.clientMessageId,
      textHash: candidate.textHash,
      messageId: candidate.messageId,
      delivered: candidate.delivered,
    });
  });
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) {
    throw new Error('hosted_e2e_fake_runtime_message_ledger_invalid');
  }
  return Object.freeze(entries);
}

/**
 * Commits the fake runtime's message operation marker with the inbox row in one atomic rename.
 * The separate diagnostic ledger is recoverable: every retry derives replay/conflict from the
 * inbox marker first and repairs a missing ledger row before returning the stable receipt.
 */
export async function persistFakeRuntimeInboxMessage(
  input: FakeRuntimeMessagePersistenceInput
): Promise<FakeRuntimeMessagePersistenceResult> {
  if (!CLIENT_MESSAGE_ID_PATTERN.test(input.clientMessageId)) {
    throw new Error('hosted_e2e_fake_runtime_client_message_id_invalid');
  }
  await mkdir(input.inboxPath.slice(0, input.inboxPath.lastIndexOf('/')), {
    recursive: true,
  });
  let messages: unknown[] = [];
  let inboxPreimage: string | null = null;
  try {
    inboxPreimage = await readFile(input.inboxPath, 'utf8');
    const value: unknown = JSON.parse(inboxPreimage);
    if (!Array.isArray(value)) throw new Error('hosted_e2e_fake_runtime_inbox_invalid');
    messages = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  await input.afterInboxRead?.();
  const textHash = sha256(normalizedFakeRuntimeMessageText(input.text));
  const operationKey = [input.actorId, input.workspaceId, input.teamId, input.clientMessageId].join(
    '\u0000'
  );
  const initialLedger = parseFakeRuntimeMessageLedger(
    (await readRuntimeState(input.runtimeStatePath)).messageLedger
  );
  const durableLedgerEntry = initialLedger.find((candidate) => candidate.key === operationKey);
  let replay: FakeRuntimeMessageLedgerEntry | null = null;
  for (const message of messages) {
    if (!isRecord(message) || !Object.hasOwn(message, 'hostedOperation')) continue;
    const candidate = fakeRuntimeMessageLedgerEntryFromInboxRow(message);
    if (candidate.key !== operationKey) continue;
    if (replay !== null) throw new Error('hosted_e2e_fake_runtime_operation_marker_duplicate');
    replay = candidate;
  }
  if (replay !== null) {
    if (replay.textHash !== textHash) return { kind: 'conflict' };
    await input.beforeCommit?.();
    if ((await optionalText(input.inboxPath)) !== inboxPreimage) {
      throw new Error('hosted_e2e_fake_runtime_inbox_raced');
    }
    await reconcileFakeRuntimeMessageLedger(input.runtimeStatePath, replay);
    await input.afterLedgerWrite?.();
    if ((await optionalText(input.inboxPath)) !== inboxPreimage) {
      throw new Error('hosted_e2e_fake_runtime_inbox_raced');
    }
    return { kind: 'idempotent_replay', entry: replay };
  }
  if (durableLedgerEntry !== undefined) {
    throw new Error('hosted_e2e_fake_runtime_message_ledger_orphaned');
  }

  const entry: FakeRuntimeMessageLedgerEntry = {
    key: operationKey,
    actorId: input.actorId,
    workspaceId: input.workspaceId,
    teamId: input.teamId,
    clientMessageId: input.clientMessageId,
    textHash,
    messageId: `message_${sha256(`${operationKey}\u0000${textHash}`).slice(0, 32)}`,
    delivered: false,
  };
  const marker: FakeRuntimeInboxOperationMarker = {
    schemaVersion: 1,
    domain: 'agent-teams.hosted-v1-e2e.message-persist/v1',
    actorId: entry.actorId,
    workspaceId: entry.workspaceId,
    teamId: entry.teamId,
    clientMessageId: entry.clientMessageId,
    textHash: entry.textHash,
    messageId: entry.messageId,
  };
  const timestamp = input.timestamp ?? new Date().toISOString();
  const ownerBinding = input.ownerProvenance?.ownerBinding;
  const ownerProvenanceUnsigned =
    input.ownerProvenance === undefined || !isRecord(ownerBinding)
      ? null
      : {
          schemaVersion: 1,
          domain: 'agent-teams.hosted-team-message.inbox-provenance/v1',
          actorId: input.actorId,
          deploymentId: input.ownerProvenance.deploymentId,
          bootId: input.ownerProvenance.bootId,
          workspaceId: input.workspaceId,
          mountGeneration: input.ownerProvenance.mountGeneration,
          teamId: input.teamId,
          messageId: entry.messageId,
          from: 'user',
          to: 'team-lead',
          target: 'team-lead',
          textHash: sha256(input.text),
          createdAtMs: Date.parse(timestamp),
          ownerAuthority: ownerBinding.ownerAuthority,
          ownerGeneration: ownerBinding.ownerGeneration,
          ownerSessionId: ownerBinding.ownerSessionId,
        };
  const hostedOwnerProvenance =
    ownerProvenanceUnsigned === null
      ? null
      : {
          ...ownerProvenanceUnsigned,
          ownerProof: createHmac('sha256', Buffer.from(input.ownerProvenance!.trustAnchor, 'hex'))
            .update(
              `agent-teams.hosted-team-message.inbox-provenance/v1\u0000${JSON.stringify(
                ownerProvenanceUnsigned
              )}`,
              'utf8'
            )
            .digest('hex'),
        };
  const next = [
    ...messages,
    {
      from: 'user',
      to: 'team-lead',
      text: input.text,
      timestamp,
      source: 'user_sent',
      messageId: entry.messageId,
      hostedOperation: marker,
      ...(hostedOwnerProvenance === null ? {} : { hostedOwnerProvenance }),
    },
  ];
  await input.beforeCommit?.();
  if ((await optionalText(input.inboxPath)) !== inboxPreimage) {
    throw new Error('hosted_e2e_fake_runtime_inbox_raced');
  }
  const publishedInboxText = `${JSON.stringify(next, null, 2)}\n`;
  await durableReplaceText(input.inboxPath, publishedInboxText);
  await input.afterInboxRename?.();
  if ((await optionalText(input.inboxPath)) !== publishedInboxText) {
    throw new Error('hosted_e2e_fake_runtime_inbox_raced');
  }
  await reconcileFakeRuntimeMessageLedger(input.runtimeStatePath, entry);
  await input.afterLedgerWrite?.();
  if ((await optionalText(input.inboxPath)) !== publishedInboxText) {
    throw new Error('hosted_e2e_fake_runtime_inbox_raced');
  }
  return { kind: 'persisted', entry };
}

const FAKE_RUNTIME_DELIVERY_DOMAIN = 'agent-teams.hosted-v1-e2e.message-delivery/v1';

function fakeRuntimeDeliveryMarker(entry: FakeRuntimeMessageLedgerEntry) {
  return Object.freeze({
    schemaVersion: 1 as const,
    domain: FAKE_RUNTIME_DELIVERY_DOMAIN,
    actorId: entry.actorId,
    workspaceId: entry.workspaceId,
    teamId: entry.teamId,
    clientMessageId: entry.clientMessageId,
    textHash: entry.textHash,
    messageId: entry.messageId,
    recipient: 'team-lead' as const,
    acknowledgement: 'durable' as const,
  });
}

function sameFakeRuntimeDeliveryMarker(
  value: unknown,
  expected: ReturnType<typeof fakeRuntimeDeliveryMarker>
): boolean {
  return isRecord(value) && canonicalJson(value) === canonicalJson(expected);
}

async function reconcileFakeRuntimeMessageDelivery(
  path: string,
  entry: FakeRuntimeMessageLedgerEntry
): Promise<void> {
  const state = await readRuntimeState(path);
  const ledger = parseFakeRuntimeMessageLedger(state.messageLedger);
  const existing = ledger.find((candidate) => candidate.key === entry.key);
  if (
    existing !== undefined &&
    (existing.actorId !== entry.actorId ||
      existing.workspaceId !== entry.workspaceId ||
      existing.teamId !== entry.teamId ||
      existing.clientMessageId !== entry.clientMessageId ||
      existing.textHash !== entry.textHash ||
      existing.messageId !== entry.messageId)
  ) {
    throw new Error('hosted_e2e_fake_runtime_message_ledger_conflict');
  }
  const delivered = { ...entry, delivered: true };
  await writeRuntimeState(
    {
      ...state,
      messageLedger:
        existing === undefined
          ? [...ledger, delivered]
          : ledger.map((candidate) => (candidate.key === entry.key ? delivered : candidate)),
    },
    path
  );
}

/**
 * Records delivery only by atomically embedding an exact durable acknowledgement in the actual
 * recipient inbox row. The diagnostic ledger is repaired from that acknowledgement after a crash.
 */
export async function deliverFakeRuntimeInboxMessage(
  input: FakeRuntimeMessageDeliveryInput
): Promise<'delivered' | 'operator_required'> {
  if (!CLIENT_MESSAGE_ID_PATTERN.test(input.clientMessageId)) return 'operator_required';
  let messages: unknown[];
  let inboxPreimage: string;
  try {
    inboxPreimage = await readFile(input.inboxPath, 'utf8');
    const value: unknown = JSON.parse(inboxPreimage);
    if (!Array.isArray(value)) throw new Error('hosted_e2e_fake_runtime_inbox_invalid');
    messages = value;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'operator_required';
    throw error;
  }
  const operationKey = [input.actorId, input.workspaceId, input.teamId, input.clientMessageId].join(
    '\u0000'
  );
  const textHash = sha256(normalizedFakeRuntimeMessageText(input.text));
  let matchIndex = -1;
  let expectedEntry: FakeRuntimeMessageLedgerEntry | null = null;
  for (const [index, message] of messages.entries()) {
    if (!isRecord(message) || !Object.hasOwn(message, 'hostedOperation')) continue;
    const candidate = fakeRuntimeMessageLedgerEntryFromInboxRow(message);
    if (candidate.key !== operationKey) continue;
    const projectedMessageId = fakeRuntimeProjectedMessageId({
      teamId: candidate.teamId,
      rawMessageId: candidate.messageId,
      from: String(message.from),
      to: typeof message.to === 'string' ? message.to : null,
    });
    if (
      projectedMessageId !== input.messageId ||
      candidate.textHash !== textHash ||
      message.to !== 'team-lead' ||
      message.text !== input.text
    ) {
      return 'operator_required';
    }
    if (matchIndex !== -1) throw new Error('hosted_e2e_fake_runtime_operation_marker_duplicate');
    matchIndex = index;
    expectedEntry = candidate;
  }
  if (matchIndex === -1 || expectedEntry === null) return 'operator_required';
  const message = messages[matchIndex] as Record<string, unknown>;
  const marker = fakeRuntimeDeliveryMarker(expectedEntry);
  const ledger = parseFakeRuntimeMessageLedger(
    (await readRuntimeState(input.runtimeStatePath)).messageLedger
  );
  const durableEntry = ledger.find((candidate) => candidate.key === operationKey);
  if (
    durableEntry !== undefined &&
    (durableEntry.actorId !== expectedEntry.actorId ||
      durableEntry.workspaceId !== expectedEntry.workspaceId ||
      durableEntry.teamId !== expectedEntry.teamId ||
      durableEntry.clientMessageId !== expectedEntry.clientMessageId ||
      durableEntry.textHash !== expectedEntry.textHash ||
      durableEntry.messageId !== expectedEntry.messageId)
  ) {
    return 'operator_required';
  }
  let durableInboxPostimage = inboxPreimage;
  if (Object.hasOwn(message, 'hostedDelivery')) {
    if (!sameFakeRuntimeDeliveryMarker(message.hostedDelivery, marker)) {
      return 'operator_required';
    }
  } else {
    if (durableEntry?.delivered === true) return 'operator_required';
    messages = messages.map((candidate, index) =>
      index === matchIndex && isRecord(candidate)
        ? { ...candidate, hostedDelivery: marker }
        : candidate
    );
    await input.beforeCommit?.();
    if ((await optionalText(input.inboxPath)) !== inboxPreimage) {
      throw new Error('hosted_e2e_fake_runtime_inbox_raced');
    }
    durableInboxPostimage = `${JSON.stringify(messages, null, 2)}\n`;
    await durableReplaceText(input.inboxPath, durableInboxPostimage);
    await input.afterInboxRename?.();
  }
  await input.beforeCommit?.();
  if ((await optionalText(input.inboxPath)) !== durableInboxPostimage) {
    throw new Error('hosted_e2e_fake_runtime_inbox_raced');
  }
  await reconcileFakeRuntimeMessageDelivery(input.runtimeStatePath, expectedEntry);
  await input.afterLedgerWrite?.();
  if ((await optionalText(input.inboxPath)) !== durableInboxPostimage) {
    throw new Error('hosted_e2e_fake_runtime_inbox_raced');
  }
  return 'delivered';
}

const TASKS_DIRECTORY = `${CLAUDE_ROOT}/tasks/${TEAM_NAME}`;
const TEAM_DIRECTORY = `${CLAUDE_ROOT}/teams/${TEAM_NAME}`;
const TASK_KANBAN_PATH = `${TEAM_DIRECTORY}/kanban-state.json`;
const TASK_WAL_PATH = `${FAKE_RUNTIME_STATE_ROOT}/task-mutation.wal.json`;
const TASK_CRASH_PATH = `${FAKE_RUNTIME_STATE_ROOT}/task-mutation.crash.json`;
const E2E_MEMBER_ID = `member_${'f'.repeat(32)}`;
const TASK_COLUMNS = ['todo', 'in_progress', 'review', 'approved', 'done'] as const;
// Standalone fake-runtime code cannot import the application bundle. Keep this exact grammar in
// contract with IDEMPOTENCY_KEY in src/features/team-task-board/contracts/hosted.ts.
const CANONICAL_HOSTED_TASK_IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/u;

export function isFakeRuntimeHostedTaskIdempotencyKey(value: unknown): value is string {
  return typeof value === 'string' && CANONICAL_HOSTED_TASK_IDEMPOTENCY_KEY.test(value);
}

function taskIdFor(rawTaskId: string): string {
  return `task_${sha256(
    JSON.stringify({
      domain: 'hosted-task-board-task/v1',
      teamId: TEAM_ID,
      rawTaskId,
    })
  ).slice(0, 32)}`;
}

async function optionalText(path: string): Promise<string | null> {
  try {
    return await readFile(path, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

interface FakeRuntimeTaskBoardSnapshot {
  readonly revision: string;
  readonly files: Map<string, { record: Record<string, unknown>; text: string }>;
  readonly kanban: Record<string, unknown>;
  readonly kanbanText: string | null;
  readonly rosterFiles: readonly (readonly [string, string | null])[];
}

function fakeRuntimeTaskBoardRevision(
  sourceGeneration: string,
  taskFiles: readonly (readonly [string, string])[],
  kanbanText: string | null,
  rosterFiles: readonly (readonly [string, string | null])[]
): string {
  return `revision_${sha256(
    JSON.stringify({
      domain: 'hosted-task-board-revision/v3',
      sourceGeneration,
      taskFiles: taskFiles.map(([name, text]) => [name, sha256(text)]),
      kanban: kanbanText === null ? null : sha256(kanbanText),
      roster: rosterFiles.map(([name, text]) => [name, text === null ? null : sha256(text)]),
    })
  )}`;
}

const FAKE_RUNTIME_TASK_COMMAND_COMMON_KEYS = [
  'schemaVersion',
  'commandId',
  'idempotencyKey',
  'teamId',
  'expectedSourceGeneration',
  'expectedRevision',
  'kind',
] as const;

interface FakeRuntimeParsedTaskCommand extends Record<string, unknown> {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly teamId: string;
  readonly expectedSourceGeneration: string;
  readonly expectedRevision: string;
  readonly kind: string;
}

function parseFakeRuntimeTaskCommand(value: unknown): FakeRuntimeParsedTaskCommand {
  if (
    !isRecord(value) ||
    value.schemaVersion !== 1 ||
    typeof value.commandId !== 'string' ||
    !/^command_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(value.commandId) ||
    !isFakeRuntimeHostedTaskIdempotencyKey(value.idempotencyKey) ||
    value.teamId !== TEAM_ID ||
    typeof value.expectedSourceGeneration !== 'string' ||
    !/^generation_[A-Za-z0-9_-]{32,128}$/u.test(value.expectedSourceGeneration) ||
    typeof value.expectedRevision !== 'string' ||
    !/^revision_[A-Za-z0-9_-]{32,128}$/u.test(value.expectedRevision) ||
    typeof value.kind !== 'string'
  ) {
    throw new Error('fake_runtime_task_command_invalid');
  }
  const exact = (keys: readonly string[]): void => {
    if (!hasExactKeys(value, [...FAKE_RUNTIME_TASK_COMMAND_COMMON_KEYS, ...keys])) {
      throw new Error('fake_runtime_task_command_invalid');
    }
  };
  const taskId = (candidate: unknown): boolean =>
    typeof candidate === 'string' && /^task_[0-9a-f]{32}$/u.test(candidate);
  const status = (candidate: unknown): boolean =>
    ['pending', 'in_progress', 'completed', 'deleted'].includes(String(candidate));
  const column = (candidate: unknown): boolean =>
    TASK_COLUMNS.includes(candidate as (typeof TASK_COLUMNS)[number]);
  switch (value.kind) {
    case 'create_task':
      exact(['subject', 'description', 'status', 'ownerId', 'column', 'order']);
      if (
        typeof value.subject !== 'string' ||
        (value.description !== null && typeof value.description !== 'string') ||
        !status(value.status) ||
        (value.ownerId !== null &&
          (typeof value.ownerId !== 'string' || !/^member_[0-9a-f]{32}$/u.test(value.ownerId))) ||
        !column(value.column) ||
        !Number.isSafeInteger(value.order) ||
        (value.order as number) < 0
      ) {
        throw new Error('fake_runtime_task_command_invalid');
      }
      break;
    case 'update_details': {
      const optional = ['subject', 'description'].filter((key) => Object.hasOwn(value, key));
      exact(['taskId', ...optional]);
      if (
        !taskId(value.taskId) ||
        optional.length < 1 ||
        (Object.hasOwn(value, 'subject') && typeof value.subject !== 'string') ||
        (Object.hasOwn(value, 'description') &&
          value.description !== null &&
          typeof value.description !== 'string')
      ) {
        throw new Error('fake_runtime_task_command_invalid');
      }
      break;
    }
    case 'update_status':
      exact(['taskId', 'status']);
      if (!taskId(value.taskId) || !status(value.status)) {
        throw new Error('fake_runtime_task_command_invalid');
      }
      break;
    case 'update_owner':
      exact(['taskId', 'ownerId']);
      if (
        !taskId(value.taskId) ||
        (value.ownerId !== null &&
          (typeof value.ownerId !== 'string' || !/^member_[0-9a-f]{32}$/u.test(value.ownerId)))
      ) {
        throw new Error('fake_runtime_task_command_invalid');
      }
      break;
    case 'move_task':
      exact(['taskId', 'column', 'order']);
      if (
        !taskId(value.taskId) ||
        !column(value.column) ||
        !Number.isSafeInteger(value.order) ||
        (value.order as number) < 0
      ) {
        throw new Error('fake_runtime_task_command_invalid');
      }
      break;
    case 'reorder_column':
      exact(['column', 'orderedTaskIds']);
      if (
        !column(value.column) ||
        !Array.isArray(value.orderedTaskIds) ||
        value.orderedTaskIds.length > 512 ||
        !value.orderedTaskIds.every(taskId) ||
        new Set(value.orderedTaskIds).size !== value.orderedTaskIds.length
      ) {
        throw new Error('fake_runtime_task_command_invalid');
      }
      return Object.freeze({
        ...value,
        orderedTaskIds: Object.freeze([...value.orderedTaskIds]),
      }) as unknown as FakeRuntimeParsedTaskCommand;
    case 'update_relationship':
      exact(['action', 'taskId', 'otherTaskId', 'relationship']);
      if (
        (value.action !== 'add' && value.action !== 'remove') ||
        !taskId(value.taskId) ||
        !taskId(value.otherTaskId) ||
        value.taskId === value.otherTaskId ||
        (value.relationship !== 'blocks' && value.relationship !== 'related')
      ) {
        throw new Error('fake_runtime_task_command_invalid');
      }
      break;
    default:
      throw new Error('fake_runtime_task_command_invalid');
  }
  return Object.freeze({ ...value }) as FakeRuntimeParsedTaskCommand;
}

/** Must remain byte-for-byte compatible with the hosted task mutation adapter fingerprint. */
export function fakeRuntimeTaskPayloadFingerprint(command: Record<string, unknown>): string {
  const common = [
    command.schemaVersion,
    command.commandId,
    command.idempotencyKey,
    command.teamId,
    command.expectedSourceGeneration,
    command.expectedRevision,
    command.kind,
  ];
  const payload = (() => {
    switch (command.kind) {
      case 'create_task':
        return [
          ...common,
          command.subject,
          command.description,
          command.status,
          command.ownerId,
          command.column,
          command.order,
        ];
      case 'update_details':
        return [
          ...common,
          command.taskId,
          Object.hasOwn(command, 'subject'),
          command.subject ?? null,
          Object.hasOwn(command, 'description'),
          command.description ?? null,
        ];
      case 'update_status':
        return [...common, command.taskId, command.status];
      case 'update_owner':
        return [...common, command.taskId, command.ownerId];
      case 'move_task':
        return [...common, command.taskId, command.column, command.order];
      case 'reorder_column':
        return [...common, command.column, command.orderedTaskIds];
      case 'update_relationship':
        return [
          ...common,
          command.action,
          command.taskId,
          command.otherTaskId,
          command.relationship,
        ];
      default:
        throw new Error('fake_runtime_task_kind_invalid');
    }
  })();
  return createHash('sha256').update(JSON.stringify(payload)).digest('base64url');
}

async function taskBoardSnapshot(sourceGeneration: string): Promise<FakeRuntimeTaskBoardSnapshot> {
  const names = (await readdir(TASKS_DIRECTORY)).filter((name) =>
    /^[A-Za-z0-9._-]+\.json$/u.test(name)
  );
  const files = new Map<string, { record: Record<string, unknown>; text: string }>();
  for (const name of names) {
    const text = await readFile(`${TASKS_DIRECTORY}/${name}`, 'utf8');
    const value: unknown = JSON.parse(text);
    if (!isRecord(value) || typeof value.id !== 'string')
      throw new Error('fake_runtime_task_invalid');
    files.set(name, { record: value, text });
  }
  const kanbanText = await optionalText(TASK_KANBAN_PATH);
  const kanbanValue: unknown = kanbanText === null ? {} : JSON.parse(kanbanText);
  if (!isRecord(kanbanValue)) throw new Error('fake_runtime_task_kanban_invalid');
  const rosterNames = ['config.json', 'members.meta.json'];
  const rosterFiles = await Promise.all(
    rosterNames.map(async (name) => {
      const text = await optionalText(`${TEAM_DIRECTORY}/${name}`);
      return [name, text] as const;
    })
  );
  const taskFiles = [...files.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([name, value]) => [name, value.text] as const);
  return {
    revision: fakeRuntimeTaskBoardRevision(sourceGeneration, taskFiles, kanbanText, rosterFiles),
    files,
    kanban: kanbanValue,
    kanbanText,
    rosterFiles,
  };
}

function serializeRecord(value: Record<string, unknown>): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}

interface FakeRuntimeTaskWalPreimage {
  readonly taskFiles: readonly (readonly [string, string])[];
  readonly kanbanText: string | null;
  readonly rosterFiles: readonly (readonly [string, string | null])[];
}

interface FakeRuntimeTaskWal {
  readonly schemaVersion: 3;
  readonly operation: 'task_mutate';
  readonly key: string;
  readonly fingerprint: string;
  readonly commandId: string;
  readonly teamId: string;
  readonly sourceGeneration: string;
  readonly command: Record<string, unknown>;
  readonly timestamp: string;
  readonly preimage: FakeRuntimeTaskWalPreimage;
  readonly affectedTaskIds: readonly string[];
  readonly writes: readonly (readonly [string, string])[];
}

function fakeRuntimeTaskWalPreimage(
  snapshot: FakeRuntimeTaskBoardSnapshot
): FakeRuntimeTaskWalPreimage {
  return Object.freeze({
    taskFiles: Object.freeze(
      [...snapshot.files.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([name, value]) => Object.freeze([name, value.text] as const))
    ),
    kanbanText: snapshot.kanbanText,
    rosterFiles: Object.freeze(
      snapshot.rosterFiles.map(([name, text]) => Object.freeze([name, text] as const))
    ),
  });
}

function parseFakeRuntimeTaskWalPreimage(value: unknown): FakeRuntimeTaskWalPreimage {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['taskFiles', 'kanbanText', 'rosterFiles']) ||
    !Array.isArray(value.taskFiles) ||
    value.taskFiles.length > 512 ||
    (value.kanbanText !== null && typeof value.kanbanText !== 'string') ||
    !Array.isArray(value.rosterFiles) ||
    value.rosterFiles.length !== 2
  ) {
    throw new Error('fake_runtime_task_wal_preimage_invalid');
  }
  const taskFiles = value.taskFiles.map((candidate) => {
    if (
      !Array.isArray(candidate) ||
      candidate.length !== 2 ||
      typeof candidate[0] !== 'string' ||
      !/^[A-Za-z0-9._-]+\.json$/u.test(candidate[0]) ||
      typeof candidate[1] !== 'string'
    ) {
      throw new Error('fake_runtime_task_wal_preimage_invalid');
    }
    const record: unknown = JSON.parse(candidate[1]);
    if (!isRecord(record) || typeof record.id !== 'string') {
      throw new Error('fake_runtime_task_wal_preimage_invalid');
    }
    return Object.freeze([candidate[0], candidate[1]] as const);
  });
  if (
    new Set(taskFiles.map(([name]) => name)).size !== taskFiles.length ||
    taskFiles.some(
      ([name], index) => index > 0 && taskFiles[index - 1]![0].localeCompare(name) >= 0
    )
  ) {
    throw new Error('fake_runtime_task_wal_preimage_invalid');
  }
  const kanban: unknown = value.kanbanText === null ? {} : JSON.parse(value.kanbanText);
  if (!isRecord(kanban)) throw new Error('fake_runtime_task_wal_preimage_invalid');
  const rosterFiles = value.rosterFiles.map((candidate, index) => {
    const expectedName = ['config.json', 'members.meta.json'][index];
    if (
      !Array.isArray(candidate) ||
      candidate.length !== 2 ||
      candidate[0] !== expectedName ||
      (candidate[1] !== null && typeof candidate[1] !== 'string')
    ) {
      throw new Error('fake_runtime_task_wal_preimage_invalid');
    }
    return Object.freeze([candidate[0], candidate[1]] as const);
  });
  return Object.freeze({
    taskFiles: Object.freeze(taskFiles),
    kanbanText: value.kanbanText,
    rosterFiles: Object.freeze(rosterFiles),
  });
}

function fakeRuntimeTaskSnapshotFromWalPreimage(
  sourceGeneration: string,
  preimage: FakeRuntimeTaskWalPreimage
): FakeRuntimeTaskBoardSnapshot {
  const files = new Map<string, { record: Record<string, unknown>; text: string }>();
  for (const [name, text] of preimage.taskFiles) {
    files.set(name, { record: JSON.parse(text) as Record<string, unknown>, text });
  }
  return {
    revision: fakeRuntimeTaskBoardRevision(
      sourceGeneration,
      preimage.taskFiles,
      preimage.kanbanText,
      preimage.rosterFiles
    ),
    files,
    kanban:
      preimage.kanbanText === null
        ? {}
        : (JSON.parse(preimage.kanbanText) as Record<string, unknown>),
    kanbanText: preimage.kanbanText,
    rosterFiles: preimage.rosterFiles,
  };
}

function parseFakeRuntimeTaskWal(value: unknown): FakeRuntimeTaskWal {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'schemaVersion',
      'operation',
      'key',
      'fingerprint',
      'commandId',
      'teamId',
      'sourceGeneration',
      'command',
      'timestamp',
      'preimage',
      'affectedTaskIds',
      'writes',
    ]) ||
    value.schemaVersion !== 3 ||
    value.operation !== 'task_mutate' ||
    typeof value.key !== 'string' ||
    typeof value.fingerprint !== 'string' ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(value.fingerprint) ||
    typeof value.commandId !== 'string' ||
    value.teamId !== TEAM_ID ||
    typeof value.sourceGeneration !== 'string' ||
    !isRecord(value.command) ||
    typeof value.timestamp !== 'string' ||
    !Number.isFinite(Date.parse(value.timestamp)) ||
    new Date(value.timestamp).toISOString() !== value.timestamp ||
    !Array.isArray(value.affectedTaskIds) ||
    !value.affectedTaskIds.every((taskId) => typeof taskId === 'string') ||
    !Array.isArray(value.writes) ||
    value.writes.length < 1
  ) {
    throw new Error('fake_runtime_task_wal_invalid');
  }
  const writes = value.writes.map((candidate) => {
    if (
      !Array.isArray(candidate) ||
      candidate.length !== 2 ||
      typeof candidate[0] !== 'string' ||
      typeof candidate[1] !== 'string' ||
      (candidate[0] !== TASK_KANBAN_PATH &&
        (!candidate[0].startsWith(`${TASKS_DIRECTORY}/`) ||
          !/^[A-Za-z0-9._-]+\.json$/u.test(candidate[0].slice(TASKS_DIRECTORY.length + 1))))
    ) {
      throw new Error('fake_runtime_task_wal_invalid');
    }
    return [candidate[0], candidate[1]] as const;
  });
  if (new Set(writes.map(([path]) => path)).size !== writes.length) {
    throw new Error('fake_runtime_task_wal_invalid');
  }
  let command: FakeRuntimeParsedTaskCommand;
  try {
    command = parseFakeRuntimeTaskCommand(value.command);
  } catch {
    throw new Error('fake_runtime_task_wal_command_invalid');
  }
  const expectedKey = [
    String(command.teamId),
    String(command.expectedSourceGeneration),
    String(command.idempotencyKey),
  ].join('\u0000');
  if (
    command.schemaVersion !== 1 ||
    command.teamId !== value.teamId ||
    command.commandId !== value.commandId ||
    command.expectedSourceGeneration !== value.sourceGeneration ||
    value.key !== expectedKey ||
    value.fingerprint !== fakeRuntimeTaskPayloadFingerprint(command)
  ) {
    throw new Error('fake_runtime_task_wal_fingerprint_invalid');
  }
  const preimage = parseFakeRuntimeTaskWalPreimage(value.preimage);
  const preimageSnapshot = fakeRuntimeTaskSnapshotFromWalPreimage(value.sourceGeneration, preimage);
  if (preimageSnapshot.revision !== command.expectedRevision) {
    throw new Error('fake_runtime_task_wal_preimage_revision_invalid');
  }
  let expected: FakeRuntimeTaskMutationPlan;
  try {
    expected = planFakeRuntimeTaskMutation(command, preimageSnapshot, value.timestamp);
  } catch {
    throw new Error('fake_runtime_task_wal_postimage_invalid');
  }
  if (
    JSON.stringify(writes) !== JSON.stringify([...expected.writes]) ||
    JSON.stringify([...value.affectedTaskIds].sort()) !== JSON.stringify(expected.affectedTaskIds)
  ) {
    throw new Error('fake_runtime_task_wal_postimage_invalid');
  }
  return {
    schemaVersion: 3,
    operation: 'task_mutate',
    key: value.key,
    fingerprint: value.fingerprint,
    commandId: value.commandId,
    teamId: value.teamId,
    sourceGeneration: value.sourceGeneration,
    command: Object.freeze({ ...command }),
    timestamp: value.timestamp,
    preimage,
    affectedTaskIds: [...value.affectedTaskIds].sort(),
    writes,
  };
}

async function publishFakeRuntimeTaskWrites(
  wal: FakeRuntimeTaskWal,
  afterRename?: (publishedCount: number) => void | Promise<void>,
  beforeTargetPublish?: (path: string, publishedCount: number) => void | Promise<void>
): Promise<void> {
  const taskPreimages = new Map(wal.preimage.taskFiles);
  let publishedCount = 0;
  for (const [path, text] of wal.writes) {
    // A task/provider writer may advance files independently of the owner queue. Recheck the full
    // WAL preimage before every publication so an observed newer row is never replaced.
    await assertFakeRuntimeTaskWalRecoveryPreimages(wal);
    const preimage =
      path === TASK_KANBAN_PATH
        ? wal.preimage.kanbanText
        : (taskPreimages.get(path.slice(TASKS_DIRECTORY.length + 1)) ?? null);
    const current = await optionalText(path);
    if (current !== preimage && current !== text) {
      throw new Error('fake_runtime_task_wal_target_raced');
    }
    if (current !== text) {
      await durableReplaceTextIfUnchanged(path, text, preimage, () =>
        beforeTargetPublish?.(path, publishedCount)
      );
    }
    publishedCount += 1;
    await afterRename?.(publishedCount);
  }
}

function fakeRuntimeTaskWalPostimage(wal: FakeRuntimeTaskWal): {
  readonly taskFiles: readonly (readonly [string, string])[];
  readonly kanbanText: string | null;
  readonly rosterFiles: readonly (readonly [string, string | null])[];
} {
  const taskFiles = new Map(wal.preimage.taskFiles);
  let kanbanText = wal.preimage.kanbanText;
  for (const [path, text] of wal.writes) {
    if (path === TASK_KANBAN_PATH) kanbanText = text;
    else taskFiles.set(path.slice(TASKS_DIRECTORY.length + 1), text);
  }
  return Object.freeze({
    taskFiles: Object.freeze(
      [...taskFiles.entries()]
        .sort(([left], [right]) => left.localeCompare(right))
        .map((entry) => Object.freeze(entry))
    ),
    kanbanText,
    rosterFiles: wal.preimage.rosterFiles,
  });
}

function taskReceiptFromWal(wal: FakeRuntimeTaskWal): Record<string, unknown> {
  const after = fakeRuntimeTaskWalPostimage(wal);
  return {
    schemaVersion: 1,
    outcome: 'committed',
    commandId: wal.commandId,
    teamId: wal.teamId,
    sourceGeneration: wal.sourceGeneration,
    revision: fakeRuntimeTaskBoardRevision(
      wal.sourceGeneration,
      after.taskFiles,
      after.kanbanText,
      after.rosterFiles
    ),
    affectedTaskIds: [...wal.affectedTaskIds],
  };
}

async function assertFakeRuntimeTaskWalPostimagesCurrent(wal: FakeRuntimeTaskWal): Promise<void> {
  const expected = fakeRuntimeTaskWalPostimage(wal);
  const currentTaskNames = (await readdir(TASKS_DIRECTORY))
    .filter((name) => /^[A-Za-z0-9._-]+\.json$/u.test(name))
    .sort((left, right) => left.localeCompare(right));
  if (canonicalJson(currentTaskNames) !== canonicalJson(expected.taskFiles.map(([name]) => name))) {
    throw new Error('fake_runtime_task_wal_postimage_raced');
  }
  for (const [name, text] of expected.taskFiles) {
    if ((await optionalText(`${TASKS_DIRECTORY}/${name}`)) !== text) {
      throw new Error('fake_runtime_task_wal_postimage_raced');
    }
  }
  if ((await optionalText(TASK_KANBAN_PATH)) !== expected.kanbanText) {
    throw new Error('fake_runtime_task_wal_postimage_raced');
  }
  for (const [name, text] of expected.rosterFiles) {
    if ((await optionalText(`${TEAM_DIRECTORY}/${name}`)) !== text) {
      throw new Error('fake_runtime_task_wal_postimage_raced');
    }
  }
}

async function fakeRuntimeTaskWalPostimagesAreCurrent(wal: FakeRuntimeTaskWal): Promise<boolean> {
  for (const [path, text] of wal.writes) {
    if ((await optionalText(path)) !== text) return false;
  }
  return true;
}

async function assertFakeRuntimeTaskWalRecoveryPreimages(wal: FakeRuntimeTaskWal): Promise<void> {
  const currentRoster = await Promise.all(
    ['config.json', 'members.meta.json'].map(async (name) =>
      Object.freeze([name, await optionalText(`${TEAM_DIRECTORY}/${name}`)] as const)
    )
  );
  if (JSON.stringify(currentRoster) !== JSON.stringify(wal.preimage.rosterFiles)) {
    throw new Error('fake_runtime_task_wal_preimage_raced');
  }
  const taskPreimages = new Map(wal.preimage.taskFiles);
  const taskTargets = new Set(
    wal.writes
      .map(([path]) =>
        path.startsWith(`${TASKS_DIRECTORY}/`) ? path.slice(TASKS_DIRECTORY.length + 1) : null
      )
      .filter((name): name is string => name !== null)
  );
  const currentTaskNames = (await readdir(TASKS_DIRECTORY))
    .filter((name) => /^[A-Za-z0-9._-]+\.json$/u.test(name))
    .sort((left, right) => left.localeCompare(right));
  const allowedTaskNames = new Set([...taskPreimages.keys(), ...taskTargets]);
  if (
    currentTaskNames.some((name) => !allowedTaskNames.has(name)) ||
    [...taskPreimages.keys()].some((name) => !currentTaskNames.includes(name))
  ) {
    throw new Error('fake_runtime_task_wal_membership_raced');
  }
  for (const [name, preimage] of taskPreimages) {
    if (taskTargets.has(name)) continue;
    if ((await optionalText(`${TASKS_DIRECTORY}/${name}`)) !== preimage) {
      throw new Error('fake_runtime_task_wal_preimage_raced');
    }
  }
  if (
    !wal.writes.some(([path]) => path === TASK_KANBAN_PATH) &&
    (await optionalText(TASK_KANBAN_PATH)) !== wal.preimage.kanbanText
  ) {
    throw new Error('fake_runtime_task_wal_preimage_raced');
  }
  for (const [path, postimage] of wal.writes) {
    const preimage =
      path === TASK_KANBAN_PATH
        ? wal.preimage.kanbanText
        : (taskPreimages.get(path.slice(TASKS_DIRECTORY.length + 1)) ?? null);
    const current = await optionalText(path);
    if (current !== preimage && current !== postimage) {
      throw new Error('fake_runtime_task_wal_target_raced');
    }
  }
}

async function recoverFakeRuntimeTaskMutationWal(): Promise<void> {
  const walText = await optionalText(TASK_WAL_PATH);
  if (walText === null) return;
  const wal = parseFakeRuntimeTaskWal(JSON.parse(walText));
  await assertFakeRuntimeTaskWalRecoveryPreimages(wal);
  const state = await readRuntimeState();
  const taskLedger = parseFakeRuntimeTaskLedger(state.taskLedger ?? []);
  const priorEntries = taskLedger.filter((entry) => entry.key === wal.key);
  if (priorEntries.length > 1) throw new Error('fake_runtime_task_wal_ledger_mismatch');
  const prior = priorEntries[0];
  if (prior !== undefined) {
    if (
      prior.fingerprint !== wal.fingerprint ||
      canonicalJson(prior.wal) !== canonicalJson(wal) ||
      !(await fakeRuntimeTaskWalPostimagesAreCurrent(wal))
    ) {
      throw new Error('fake_runtime_task_wal_replay_mismatch');
    }
    const receipt = taskReceiptFromWal(wal);
    if (canonicalJson(prior.receipt) !== canonicalJson(receipt)) {
      throw new Error('fake_runtime_task_wal_replay_mismatch');
    }
    await assertFakeRuntimeTaskWalPostimagesCurrent(wal);
    await durableRemoveFile(TASK_WAL_PATH);
    return;
  }
  if (wal.fingerprint !== fakeRuntimeTaskPayloadFingerprint(wal.command)) {
    throw new Error('fake_runtime_task_wal_ledger_mismatch');
  }
  await publishFakeRuntimeTaskWrites(wal);
  await assertFakeRuntimeTaskWalPostimagesCurrent(wal);
  const receipt = taskReceiptFromWal(wal);
  await writeRuntimeState({
    ...state,
    taskLedger: [...taskLedger, { key: wal.key, fingerprint: wal.fingerprint, receipt, wal }],
  });
  await assertFakeRuntimeTaskWalPostimagesCurrent(wal);
  await durableRemoveFile(TASK_WAL_PATH);
}

async function crashAfterConfiguredTaskRename(
  commandId: string,
  publishedCount: number
): Promise<void> {
  const crashText = await optionalText(TASK_CRASH_PATH);
  if (crashText === null) return;
  const crash: unknown = JSON.parse(crashText);
  if (
    !isRecord(crash) ||
    !hasExactKeys(crash, ['schemaVersion', 'commandId', 'afterRenames']) ||
    crash.schemaVersion !== 1 ||
    crash.commandId !== commandId ||
    !Number.isSafeInteger(crash.afterRenames) ||
    (crash.afterRenames as number) < 1
  ) {
    throw new Error('fake_runtime_task_crash_fixture_invalid');
  }
  if (publishedCount !== crash.afterRenames) return;
  await rm(TASK_CRASH_PATH, { force: true });
  process.exit(86);
}

function rawTaskForId(
  files: Map<string, { record: Record<string, unknown>; text: string }>,
  taskId: unknown
): { name: string; rawTaskId: string; record: Record<string, unknown> } {
  for (const [name, value] of files) {
    const rawTaskId = String(value.record.id);
    if (taskIdFor(rawTaskId) === taskId) return { name, rawTaskId, record: { ...value.record } };
  }
  throw new Error('fake_runtime_task_not_found');
}

function fakeRuntimeRelationshipList(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 512 ||
    !value.every((entry) => typeof entry === 'string' && entry.length > 0) ||
    new Set(value).size !== value.length
  ) {
    throw new Error('fake_runtime_task_relationship_conflict');
  }
  return [...value];
}

function boardPlacements(
  files: Map<string, { record: Record<string, unknown>; text: string }>,
  kanban: Record<string, unknown>
): {
  placements: Record<string, Record<string, unknown> & { column: string }>;
  orders: Record<string, string[]>;
} {
  const configured = isRecord(kanban.tasks) ? kanban.tasks : {};
  const configuredOrders = isRecord(kanban.columnOrder) ? kanban.columnOrder : {};
  const placements: Record<string, Record<string, unknown> & { column: string }> = {};
  const orders = Object.fromEntries(TASK_COLUMNS.map((column) => [column, []])) as Record<
    string,
    string[]
  >;
  const active = [...files.values()]
    .filter(({ record }) => record.status !== 'deleted')
    .sort((left, right) =>
      taskIdFor(String(left.record.id)).localeCompare(taskIdFor(String(right.record.id)))
    );
  for (const { record } of active) {
    const rawTaskId = String(record.id);
    const configuredPlacement = isRecord(configured[rawTaskId]) ? configured[rawTaskId] : null;
    const fallback =
      record.status === 'in_progress'
        ? 'in_progress'
        : record.status === 'completed'
          ? 'done'
          : 'todo';
    placements[rawTaskId] = {
      ...(configuredPlacement ?? {}),
      column:
        configuredPlacement &&
        TASK_COLUMNS.includes(configuredPlacement.column as (typeof TASK_COLUMNS)[number])
          ? String(configuredPlacement.column)
          : fallback,
    };
  }
  for (const column of TASK_COLUMNS) {
    const configuredOrder = Array.isArray(configuredOrders[column])
      ? configuredOrders[column].filter(
          (value): value is string =>
            typeof value === 'string' && placements[value]?.column === column
        )
      : [];
    const remaining = Object.keys(placements).filter(
      (rawTaskId) =>
        placements[rawTaskId]?.column === column && !configuredOrder.includes(rawTaskId)
    );
    orders[column] = [...configuredOrder, ...remaining];
  }
  return { placements, orders };
}

interface FakeRuntimeTaskMutationPlan {
  readonly affectedTaskIds: readonly string[];
  readonly writes: ReadonlyMap<string, string>;
}

/** Pure deterministic postimage calculation shared by admission and crash recovery verification. */
function planFakeRuntimeTaskMutation(
  command: Record<string, unknown>,
  before: FakeRuntimeTaskBoardSnapshot,
  timestamp: string
): FakeRuntimeTaskMutationPlan {
  const { placements, orders } = boardPlacements(before.files, before.kanban);
  const writes = new Map<string, string>();
  let affectedTaskIds: string[] = [];
  switch (command.kind) {
    case 'create_task': {
      const rawTaskId = `hosted-${sha256(JSON.stringify({ commandId: command.commandId })).slice(0, 40)}`;
      const name = `${rawTaskId}.json`;
      if (before.files.has(name)) throw new Error('fake_runtime_task_conflict');
      if (command.ownerId !== null && command.ownerId !== E2E_MEMBER_ID) {
        throw new Error('fake_runtime_task_owner_invalid');
      }
      const record: Record<string, unknown> = {
        id: rawTaskId,
        subject: command.subject,
        ...(command.description === null ? {} : { description: command.description }),
        status: command.status,
        ...(command.ownerId === null ? {} : { owner: command.ownerId }),
        blockedBy: [],
        blocks: [],
        related: [],
        createdAt: timestamp,
      };
      const text = serializeRecord(record);
      writes.set(`${TASKS_DIRECTORY}/${name}`, text);
      before.files.set(name, { record, text });
      placements[rawTaskId] = { column: String(command.column) };
      orders[String(command.column)]?.splice(Number(command.order), 0, rawTaskId);
      affectedTaskIds = [taskIdFor(rawTaskId)];
      break;
    }
    case 'update_details':
    case 'update_status':
    case 'update_owner': {
      const task = rawTaskForId(before.files, command.taskId);
      if (command.kind === 'update_details') {
        if (typeof command.subject === 'string') task.record.subject = command.subject;
        if (Object.hasOwn(command, 'description')) {
          if (command.description === null) delete task.record.description;
          else task.record.description = command.description;
        }
      } else if (command.kind === 'update_status') {
        if (task.record.status === command.status) throw new Error('fake_runtime_task_conflict');
        task.record.status = command.status;
      } else if (command.ownerId === null) delete task.record.owner;
      else if (command.ownerId === E2E_MEMBER_ID) task.record.owner = command.ownerId;
      else throw new Error('fake_runtime_task_owner_invalid');
      const text = serializeRecord(task.record);
      writes.set(`${TASKS_DIRECTORY}/${task.name}`, text);
      before.files.set(task.name, { record: task.record, text });
      affectedTaskIds = [String(command.taskId)];
      break;
    }
    case 'move_task': {
      const task = rawTaskForId(before.files, command.taskId);
      for (const values of Object.values(orders)) {
        const index = values.indexOf(task.rawTaskId);
        if (index >= 0) values.splice(index, 1);
      }
      const target = orders[String(command.column)];
      if (!target) throw new Error('fake_runtime_task_column_invalid');
      target.splice(Math.min(Number(command.order), target.length), 0, task.rawTaskId);
      placements[task.rawTaskId] = {
        column: String(command.column),
        ...(['review', 'approved'].includes(String(command.column)) ? { movedAt: timestamp } : {}),
      };
      affectedTaskIds = [String(command.taskId)];
      break;
    }
    case 'reorder_column': {
      if (!Array.isArray(command.orderedTaskIds)) throw new Error('fake_runtime_task_kind_invalid');
      const rawIds = command.orderedTaskIds.map(
        (taskId) => rawTaskForId(before.files, taskId).rawTaskId
      );
      orders[String(command.column)] = rawIds;
      affectedTaskIds = command.orderedTaskIds.map(String).sort();
      break;
    }
    case 'update_relationship': {
      const task = rawTaskForId(before.files, command.taskId);
      const other = rawTaskForId(before.files, command.otherTaskId);
      const [taskField, otherField] =
        command.relationship === 'blocks'
          ? (['blocks', 'blockedBy'] as const)
          : (['related', 'related'] as const);
      const taskValues = fakeRuntimeRelationshipList(task.record[taskField] ?? []);
      const otherValues = fakeRuntimeRelationshipList(other.record[otherField] ?? []);
      const taskHasOther = taskValues.includes(other.rawTaskId);
      const otherHasTask = otherValues.includes(task.rawTaskId);
      if (
        taskHasOther !== otherHasTask ||
        (command.action === 'add' && taskHasOther) ||
        (command.action === 'remove' && !taskHasOther)
      ) {
        throw new Error('fake_runtime_task_relationship_conflict');
      }
      task.record[taskField] =
        command.action === 'add'
          ? [...taskValues, other.rawTaskId]
          : taskValues.filter((value) => value !== other.rawTaskId);
      other.record[otherField] =
        command.action === 'add'
          ? [...otherValues, task.rawTaskId]
          : otherValues.filter((value) => value !== task.rawTaskId);
      const taskText = serializeRecord(task.record);
      const otherText = serializeRecord(other.record);
      writes.set(`${TASKS_DIRECTORY}/${task.name}`, taskText);
      writes.set(`${TASKS_DIRECTORY}/${other.name}`, otherText);
      before.files.set(task.name, { record: task.record, text: taskText });
      before.files.set(other.name, { record: other.record, text: otherText });
      affectedTaskIds = [String(command.taskId), String(command.otherTaskId)];
      break;
    }
    default:
      throw new Error('fake_runtime_task_kind_invalid');
  }
  if (
    command.kind === 'create_task' ||
    command.kind === 'update_status' ||
    command.kind === 'move_task' ||
    command.kind === 'reorder_column'
  ) {
    const configuredTasks = isRecord(before.kanban.tasks) ? before.kanban.tasks : {};
    const kanban = {
      ...before.kanban,
      tasks: { ...configuredTasks, ...placements },
      version: 1,
      columnOrder: Object.fromEntries(TASK_COLUMNS.map((column) => [column, orders[column]])),
    };
    writes.set(TASK_KANBAN_PATH, serializeRecord(kanban));
  }
  if (writes.size < 1) throw new Error('fake_runtime_task_conflict');
  return Object.freeze({ affectedTaskIds: Object.freeze(affectedTaskIds.sort()), writes });
}

function parseFakeRuntimeTaskLedger(value: unknown): readonly FakeRuntimeTaskLedgerEntry[] {
  if (!Array.isArray(value) || value.length > 10_000) {
    throw new Error('fake_runtime_task_ledger_invalid');
  }
  const entries = value.map((candidate) => {
    if (
      !isRecord(candidate) ||
      !hasExactKeys(candidate, ['key', 'fingerprint', 'receipt', 'wal']) ||
      typeof candidate.key !== 'string' ||
      typeof candidate.fingerprint !== 'string' ||
      !/^[A-Za-z0-9_-]{32,128}$/u.test(candidate.fingerprint) ||
      !isRecord(candidate.receipt) ||
      !hasExactKeys(candidate.receipt, [
        'schemaVersion',
        'outcome',
        'commandId',
        'teamId',
        'sourceGeneration',
        'revision',
        'affectedTaskIds',
      ]) ||
      candidate.receipt.schemaVersion !== 1 ||
      candidate.receipt.outcome !== 'committed' ||
      typeof candidate.receipt.commandId !== 'string' ||
      !/^command_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u.test(candidate.receipt.commandId) ||
      candidate.receipt.teamId !== TEAM_ID ||
      typeof candidate.receipt.sourceGeneration !== 'string' ||
      !/^generation_[A-Za-z0-9_-]{32,128}$/u.test(candidate.receipt.sourceGeneration) ||
      typeof candidate.receipt.revision !== 'string' ||
      !/^revision_[A-Za-z0-9_-]{32,128}$/u.test(candidate.receipt.revision) ||
      !Array.isArray(candidate.receipt.affectedTaskIds) ||
      candidate.receipt.affectedTaskIds.length > 512 ||
      !candidate.receipt.affectedTaskIds.every(
        (taskId) => typeof taskId === 'string' && /^task_[0-9a-f]{32}$/u.test(taskId)
      ) ||
      new Set(candidate.receipt.affectedTaskIds).size !== candidate.receipt.affectedTaskIds.length
    ) {
      throw new Error('fake_runtime_task_ledger_invalid');
    }
    let wal: FakeRuntimeTaskWal;
    try {
      wal = parseFakeRuntimeTaskWal(candidate.wal);
    } catch {
      throw new Error('fake_runtime_task_ledger_invalid');
    }
    const keyParts = candidate.key.split('\u0000');
    if (
      keyParts.length !== 3 ||
      keyParts[0] !== TEAM_ID ||
      keyParts[1] !== candidate.receipt.sourceGeneration ||
      !isFakeRuntimeHostedTaskIdempotencyKey(keyParts[2]) ||
      canonicalJson(candidate.receipt.affectedTaskIds) !==
        canonicalJson([...candidate.receipt.affectedTaskIds].sort()) ||
      candidate.key !== wal.key ||
      candidate.fingerprint !== wal.fingerprint ||
      canonicalJson(candidate.receipt) !== canonicalJson(taskReceiptFromWal(wal))
    ) {
      throw new Error('fake_runtime_task_ledger_invalid');
    }
    return Object.freeze({
      key: candidate.key,
      fingerprint: candidate.fingerprint,
      receipt: Object.freeze({
        schemaVersion: 1,
        outcome: 'committed',
        commandId: candidate.receipt.commandId,
        teamId: TEAM_ID,
        sourceGeneration: candidate.receipt.sourceGeneration,
        revision: candidate.receipt.revision,
        affectedTaskIds: Object.freeze([...candidate.receipt.affectedTaskIds]),
      }),
      wal,
    });
  });
  if (new Set(entries.map((entry) => entry.key)).size !== entries.length) {
    throw new Error('fake_runtime_task_ledger_invalid');
  }
  return Object.freeze(entries);
}

function fakeRuntimeTaskExpectedAffectedTaskIds(
  command: FakeRuntimeParsedTaskCommand
): readonly string[] {
  switch (command.kind) {
    case 'create_task':
      return Object.freeze([
        taskIdFor(
          `hosted-${sha256(JSON.stringify({ commandId: command.commandId })).slice(0, 40)}`
        ),
      ]);
    case 'reorder_column':
      return Object.freeze((command.orderedTaskIds as string[]).map(String).sort());
    case 'update_relationship':
      return Object.freeze([String(command.taskId), String(command.otherTaskId)].sort());
    default:
      return Object.freeze([String(command.taskId)]);
  }
}

async function assertFakeRuntimeTaskLedgerReplay(
  ledger: readonly FakeRuntimeTaskLedgerEntry[],
  entry: FakeRuntimeTaskLedgerEntry,
  command: FakeRuntimeParsedTaskCommand
): Promise<void> {
  if (
    entry.receipt.commandId !== command.commandId ||
    entry.receipt.teamId !== command.teamId ||
    entry.receipt.sourceGeneration !== command.expectedSourceGeneration ||
    canonicalJson(entry.receipt.affectedTaskIds) !==
      canonicalJson(fakeRuntimeTaskExpectedAffectedTaskIds(command)) ||
    canonicalJson(entry.wal.command) !== canonicalJson(command)
  ) {
    throw new Error('fake_runtime_task_ledger_invalid');
  }
  const entryIndex = ledger.indexOf(entry);
  const newerSameGeneration = ledger
    .slice(entryIndex + 1)
    .some((candidate) => candidate.receipt.sourceGeneration === command.expectedSourceGeneration);
  if (!newerSameGeneration && !(await fakeRuntimeTaskWalPostimagesAreCurrent(entry.wal))) {
    throw new Error('fake_runtime_task_ledger_postimage_mismatch');
  }
  if (!newerSameGeneration) await assertFakeRuntimeTaskWalPostimagesCurrent(entry.wal);
}

async function admitFakeRuntimeTaskMutation(
  request: Record<string, unknown>,
  afterStateRead?: () => void | Promise<void>,
  beforeCommit?: () => void | Promise<void>,
  afterRename?: (publishedCount: number) => void | Promise<void>,
  afterLedgerWrite?: () => void | Promise<void>,
  beforeTargetPublish?: (path: string, publishedCount: number) => void | Promise<void>
): Promise<Record<string, unknown>> {
  await recoverFakeRuntimeTaskMutationWal();
  if (!hasExactKeys(request, ['command', 'payloadFingerprint'])) {
    throw new Error('fake_runtime_task_request_invalid');
  }
  let command: FakeRuntimeParsedTaskCommand;
  try {
    command = parseFakeRuntimeTaskCommand(request.command);
  } catch {
    throw new Error('fake_runtime_task_request_invalid');
  }
  const fingerprint = request.payloadFingerprint;
  if (
    typeof fingerprint !== 'string' ||
    !/^[A-Za-z0-9_-]{32,128}$/u.test(fingerprint) ||
    fingerprint !== fakeRuntimeTaskPayloadFingerprint(command)
  ) {
    throw new Error('fake_runtime_task_request_invalid');
  }
  const state = await readRuntimeState();
  const taskLedger = parseFakeRuntimeTaskLedger(state.taskLedger ?? []);
  await afterStateRead?.();
  const key = [
    String(command.teamId),
    String(command.expectedSourceGeneration),
    String(command.idempotencyKey),
  ].join('\u0000');
  const prior = taskLedger.find((entry) => entry.key === key);
  if (prior) {
    if (prior.fingerprint !== fingerprint) {
      return {
        schemaVersion: 1,
        kind: 'conflict',
        reason: 'idempotency_mismatch',
        currentSourceGeneration: command.expectedSourceGeneration,
      };
    }
    await assertFakeRuntimeTaskLedgerReplay(taskLedger, prior, command);
    return {
      schemaVersion: 1,
      kind: 'idempotent_replay',
      currentSourceGeneration: command.expectedSourceGeneration,
      payloadFingerprint: fingerprint,
      receipt: { ...prior.receipt, outcome: 'idempotent_replay' },
    };
  }
  const before = await taskBoardSnapshot(String(command.expectedSourceGeneration));
  if (before.revision !== command.expectedRevision) {
    return {
      schemaVersion: 1,
      kind: 'stale_revision',
      currentSourceGeneration: command.expectedSourceGeneration,
      currentRevision: before.revision,
    };
  }
  if (
    command.kind === 'create_task' &&
    command.ownerId !== null &&
    command.ownerId !== E2E_MEMBER_ID
  ) {
    return {
      schemaVersion: 1,
      kind: 'conflict',
      reason: 'state_conflict',
      currentSourceGeneration: command.expectedSourceGeneration,
      currentRevision: before.revision,
    };
  }
  const preimage = fakeRuntimeTaskWalPreimage(before);
  const timestamp = new Date().toISOString();
  let plan: FakeRuntimeTaskMutationPlan;
  try {
    plan = planFakeRuntimeTaskMutation(command, before, timestamp);
  } catch (error) {
    const reason = error instanceof Error ? error.message : '';
    if (reason === 'fake_runtime_task_not_found') {
      return { schemaVersion: 1, kind: 'not_found' };
    }
    if (reason === 'fake_runtime_task_relationship_conflict') {
      return {
        schemaVersion: 1,
        kind: 'conflict',
        reason: 'relationship_conflict',
        currentSourceGeneration: command.expectedSourceGeneration,
        currentRevision: before.revision,
      };
    }
    if (reason === 'fake_runtime_task_conflict' || reason === 'fake_runtime_task_owner_invalid') {
      return {
        schemaVersion: 1,
        kind: 'conflict',
        reason: 'state_conflict',
        currentSourceGeneration: command.expectedSourceGeneration,
        currentRevision: before.revision,
      };
    }
    throw error;
  }
  const wal: FakeRuntimeTaskWal = {
    schemaVersion: 3,
    operation: 'task_mutate',
    key,
    fingerprint,
    commandId: command.commandId,
    teamId: command.teamId,
    sourceGeneration: command.expectedSourceGeneration,
    command: Object.freeze({ ...command }),
    timestamp,
    preimage,
    affectedTaskIds: plan.affectedTaskIds,
    writes: [...plan.writes],
  };
  await beforeCommit?.();
  if ((await optionalText(TASK_WAL_PATH)) !== null) {
    throw new Error('fake_runtime_task_wal_pending');
  }
  await durableReplaceText(TASK_WAL_PATH, `${JSON.stringify(wal, null, 2)}\n`);
  await publishFakeRuntimeTaskWrites(
    wal,
    async (publishedCount) => {
      await crashAfterConfiguredTaskRename(wal.commandId, publishedCount);
      await afterRename?.(publishedCount);
    },
    beforeTargetPublish
  );
  await assertFakeRuntimeTaskWalPostimagesCurrent(wal);
  const receipt = taskReceiptFromWal(wal);
  await writeRuntimeState({
    ...state,
    taskLedger: [...taskLedger, { key, fingerprint, receipt, wal }],
  });
  await afterLedgerWrite?.();
  await assertFakeRuntimeTaskWalPostimagesCurrent(wal);
  await durableRemoveFile(TASK_WAL_PATH);
  return {
    schemaVersion: 1,
    kind: 'committed',
    currentSourceGeneration: command.expectedSourceGeneration,
    payloadFingerprint: fingerprint,
    receipt,
    selfWriteEffects: [...plan.writes]
      .filter(([path]) => path.startsWith(`${TASKS_DIRECTORY}/`) && path.endsWith('.json'))
      .map(([path, text]) => ({
        fileKey: path.slice(`${TASKS_DIRECTORY}/`.length, -'.json'.length),
        expectedChecksum: sha256(text),
      })),
  };
}

export interface FakeRuntimeStateMutationQueue {
  run<T>(operation: () => Promise<T>): Promise<T>;
}

export function createFakeRuntimeStateMutationQueue(): FakeRuntimeStateMutationQueue {
  let tail: Promise<void> = Promise.resolve();
  return Object.freeze({
    run<T>(operation: () => Promise<T>): Promise<T> {
      const result = tail.then(operation);
      tail = result.then(
        () => undefined,
        () => undefined
      );
      return result;
    },
  });
}

async function proveFakeRuntimeStateMutationOverlap(): Promise<Record<string, unknown>> {
  const queue = createFakeRuntimeStateMutationQueue();
  const sourceGeneration = `generation_${'6'.repeat(64)}`;
  const before = await taskBoardSnapshot(sourceGeneration);
  const command = {
    schemaVersion: 1,
    kind: 'update_owner',
    commandId: 'command_concurrent_lifecycle_task',
    teamId: TEAM_ID,
    idempotencyKey: 'idempotency_concurrent_lifecycle_task',
    expectedSourceGeneration: sourceGeneration,
    expectedRevision: before.revision,
    taskId: taskIdFor('1'),
    ownerId: E2E_MEMBER_ID,
  };
  const fingerprint = fakeRuntimeTaskPayloadFingerprint(command);
  let notifyStateRead: (() => void) | undefined;
  let releaseTaskCommit: (() => void) | undefined;
  const stateRead = new Promise<void>((resolve) => {
    notifyStateRead = resolve;
  });
  const taskCommitReleased = new Promise<void>((resolve) => {
    releaseTaskCommit = resolve;
  });
  const taskCommit = queue.run(() =>
    admitFakeRuntimeTaskMutation({ command, payloadFingerprint: fingerprint }, async () => {
      notifyStateRead?.();
      await taskCommitReleased;
    })
  );
  await stateRead;
  const lifecycleCommit = queue.run(() =>
    recordRuntimeExecution(
      {
        action: 'stop',
        commandId: 'lifecycle-command_concurrent_task',
        teamId: TEAM_ID,
        workspaceId: `workspace_${'b'.repeat(32)}`,
        expectedRevision: `revision_${'7'.repeat(64)}`,
      },
      'run_concurrent_lifecycle_task'
    )
  );
  releaseTaskCommit?.();
  const [committed] = await Promise.all([taskCommit, lifecycleCommit]);
  const replay = await queue.run(() =>
    admitFakeRuntimeTaskMutation({ command, payloadFingerprint: fingerprint })
  );
  const mismatchCommand = { ...command, ownerId: null };
  const mismatch = await queue.run(() =>
    admitFakeRuntimeTaskMutation({
      command: mismatchCommand,
      payloadFingerprint: fakeRuntimeTaskPayloadFingerprint(mismatchCommand),
    })
  );
  const state = await readRuntimeState();
  const invalidCreateBefore = await taskBoardSnapshot(sourceGeneration);
  const invalidCreateStateBefore = await optionalText(runtimeStatePath);
  const invalidCreateCommand = {
    schemaVersion: 1,
    kind: 'create_task',
    commandId: 'command_invalid_create_owner',
    teamId: TEAM_ID,
    idempotencyKey: 'idempotency_invalid_create_owner',
    expectedSourceGeneration: sourceGeneration,
    expectedRevision: invalidCreateBefore.revision,
    subject: 'Invalid owner must not create a task',
    description: null,
    status: 'pending',
    ownerId: 'member_00000000000000000000000000000000',
    column: 'todo',
    order: 0,
  };
  const invalidCreate = await queue.run(() =>
    admitFakeRuntimeTaskMutation({
      command: invalidCreateCommand,
      payloadFingerprint: fakeRuntimeTaskPayloadFingerprint(invalidCreateCommand),
    })
  );
  const invalidCreateAfter = await taskBoardSnapshot(sourceGeneration);
  const invalidCreateStateAfter = await optionalText(runtimeStatePath);
  const invalidCreateWasByteStable =
    invalidCreateBefore.revision === invalidCreateAfter.revision &&
    invalidCreateStateBefore === invalidCreateStateAfter;
  const taskOwner = invalidCreateAfter.files.get('1.json')?.record.owner ?? null;
  return {
    committed,
    replay,
    mismatch,
    commands: state.commands,
    invalidCreate,
    invalidCreateWasByteStable,
    taskLedger: state.taskLedger,
    taskOwner,
  };
}

async function proveFakeRuntimeTaskIdempotencyContract(): Promise<Record<string, unknown>> {
  const sourceGeneration = `generation_${'5'.repeat(64)}`;
  const before = await taskBoardSnapshot(sourceGeneration);
  const idempotencyKey = 'mutation_01234567-89ab-4def-8123-456789abcdef';
  const command = {
    schemaVersion: 1,
    kind: 'update_owner',
    commandId: 'command_01234567-89ab-4def-8123-456789abcdef',
    teamId: TEAM_ID,
    idempotencyKey,
    expectedSourceGeneration: sourceGeneration,
    expectedRevision: before.revision,
    taskId: taskIdFor('1'),
    ownerId: E2E_MEMBER_ID,
  };
  const fingerprint = fakeRuntimeTaskPayloadFingerprint(command);
  const committed = await admitFakeRuntimeTaskMutation({
    command,
    payloadFingerprint: fingerprint,
  });
  const stateAfterCommitText = await optionalText(runtimeStatePath);
  const stateAfterCommit = await readRuntimeState();
  const ledgerEntry = stateAfterCommit.taskLedger?.[0];
  if (stateAfterCommitText === null || stateAfterCommit.taskLedger?.length !== 1 || !ledgerEntry) {
    throw new Error('fake_runtime_task_idempotency_fixture_ledger_missing');
  }

  const replay = await admitFakeRuntimeTaskMutation({
    command,
    payloadFingerprint: fingerprint,
  });
  const stateAfterReplayText = await optionalText(runtimeStatePath);
  const invalidStateBefore = stateAfterReplayText;
  const invalidBoardBefore = await taskBoardSnapshot(sourceGeneration);
  const invalidKeys = Object.freeze([
    '',
    '_leading-punctuation',
    'mutation/01234567-89ab-4def-8123-456789abcdef',
    'a'.repeat(129),
  ]);
  const invalidRequestErrors: string[] = [];
  for (const invalidKey of invalidKeys) {
    const invalidCommand = { ...command, idempotencyKey: invalidKey };
    try {
      await admitFakeRuntimeTaskMutation({
        command: invalidCommand,
        payloadFingerprint: fakeRuntimeTaskPayloadFingerprint(invalidCommand),
      });
      invalidRequestErrors.push('accepted');
    } catch (error) {
      invalidRequestErrors.push(error instanceof Error ? error.message : 'unknown');
    }
  }
  const invalidLedgerKey = [TEAM_ID, sourceGeneration, invalidKeys[2]].join('\u0000');
  let invalidLedgerError = 'accepted';
  try {
    parseFakeRuntimeTaskLedger([{ ...ledgerEntry, key: invalidLedgerKey }]);
  } catch (error) {
    invalidLedgerError = error instanceof Error ? error.message : 'unknown';
  }
  const invalidBoardAfter = await taskBoardSnapshot(sourceGeneration);

  return {
    command,
    fingerprint,
    committed,
    replay,
    durableLedger: {
      key: ledgerEntry.key,
      fingerprint: ledgerEntry.fingerprint,
      receipt: ledgerEntry.receipt,
      wal: {
        key: ledgerEntry.wal.key,
        fingerprint: ledgerEntry.wal.fingerprint,
        commandId: ledgerEntry.wal.commandId,
        command: ledgerEntry.wal.command,
      },
    },
    replayStateByteStable: stateAfterCommitText === stateAfterReplayText,
    invalid: {
      keys: invalidKeys,
      requestErrors: invalidRequestErrors,
      ledgerError: invalidLedgerError,
      runtimeStateByteStable:
        invalidStateBefore !== null &&
        invalidStateBefore === (await optionalText(runtimeStatePath)),
      boardRevisionStable: invalidBoardBefore.revision === invalidBoardAfter.revision,
      walAbsent: (await optionalText(TASK_WAL_PATH)) === null,
    },
  };
}

async function proveFakeRuntimeTaskGenerationReuse(): Promise<Record<string, unknown>> {
  const idempotencyKey = 'idempotency_generation_reuse';
  const execute = async (sourceGeneration: string, ownerId: string | null) => {
    const before = await taskBoardSnapshot(sourceGeneration);
    const command = {
      schemaVersion: 1,
      kind: 'update_owner',
      commandId: `command_generation_reuse_${sourceGeneration.slice(-8)}`,
      teamId: TEAM_ID,
      idempotencyKey,
      expectedSourceGeneration: sourceGeneration,
      expectedRevision: before.revision,
      taskId: taskIdFor('1'),
      ownerId,
    };
    return admitFakeRuntimeTaskMutation({
      command,
      payloadFingerprint: fakeRuntimeTaskPayloadFingerprint(command),
    });
  };
  const firstGeneration = `generation_${'a'.repeat(64)}`;
  const secondGeneration = `generation_${'b'.repeat(64)}`;
  const first = await execute(firstGeneration, E2E_MEMBER_ID);
  const second = await execute(secondGeneration, null);
  const state = await readRuntimeState();
  return {
    first,
    second,
    ledgerKeys: (state.taskLedger ?? []).map((entry) => entry.key),
    finalOwner:
      (await taskBoardSnapshot(secondGeneration)).files.get('1.json')?.record.owner ?? null,
  };
}

async function proveFakeRuntimeTaskNewerWriterFence(): Promise<Record<string, unknown>> {
  const sourceGeneration = `generation_${'8'.repeat(64)}`;
  const before = await taskBoardSnapshot(sourceGeneration);
  const taskPath = `${TASKS_DIRECTORY}/1.json`;
  const originalTaskText = await readFile(taskPath, 'utf8');
  const originalTask = JSON.parse(originalTaskText) as Record<string, unknown>;
  const newerTaskText = serializeRecord({
    ...originalTask,
    externalWriterRevision: 'newer-writer-must-survive',
  });
  const command = {
    schemaVersion: 1,
    kind: 'update_owner',
    commandId: 'command_task-newer-writer-fence',
    teamId: TEAM_ID,
    idempotencyKey: 'idempotency_task-newer-writer-fence',
    expectedSourceGeneration: sourceGeneration,
    expectedRevision: before.revision,
    taskId: taskIdFor('1'),
    ownerId: E2E_MEMBER_ID,
  };
  let mutationError: string | null = null;
  let publishFenceExercised = false;
  try {
    await admitFakeRuntimeTaskMutation(
      { command, payloadFingerprint: fakeRuntimeTaskPayloadFingerprint(command) },
      undefined,
      undefined,
      undefined,
      undefined,
      async (path) => {
        if (path !== taskPath) return;
        publishFenceExercised = true;
        await writeFile(taskPath, newerTaskText);
      }
    );
  } catch (error) {
    mutationError = error instanceof Error ? error.message : 'unknown';
  }
  const pendingWal = await optionalText(TASK_WAL_PATH);
  const secondCommand = {
    ...command,
    commandId: 'command_task-newer-writer-second',
    idempotencyKey: 'idempotency_task-newer-writer-second',
    ownerId: null,
  };
  let secondMutationError: string | null = null;
  try {
    await admitFakeRuntimeTaskMutation({
      command: secondCommand,
      payloadFingerprint: fakeRuntimeTaskPayloadFingerprint(secondCommand),
    });
  } catch (error) {
    secondMutationError = error instanceof Error ? error.message : 'unknown';
  }
  let recoveryError: string | null = null;
  try {
    await recoverFakeRuntimeTaskMutationWal();
  } catch (error) {
    recoveryError = error instanceof Error ? error.message : 'unknown';
  }
  const state = await readRuntimeState();
  const publicationArtifacts = (await readdir(TASKS_DIRECTORY)).filter(
    (name) => name.includes('.wal-stage-') || name.includes('.wal-pin-')
  );
  return Object.freeze({
    mutationError,
    secondMutationError,
    recoveryError,
    publishFenceExercised,
    newerWriterPreserved: (await readFile(taskPath, 'utf8')) === newerTaskText,
    publicationArtifactsRetained: publicationArtifacts.length > 0,
    walRetained: (await optionalText(TASK_WAL_PATH)) !== null,
    walByteStable: pendingWal !== null && (await optionalText(TASK_WAL_PATH)) === pendingWal,
    taskLedgerCount: (state.taskLedger ?? []).length,
  });
}

async function proveFakeRuntimeTaskLedgerPostimageFence(): Promise<Record<string, unknown>> {
  const sourceGeneration = `generation_${'c'.repeat(64)}`;
  const before = await taskBoardSnapshot(sourceGeneration);
  const taskPath = `${TASKS_DIRECTORY}/1.json`;
  const command = {
    schemaVersion: 1,
    kind: 'update_owner',
    commandId: 'command_task-ledger-postimage-fence',
    teamId: TEAM_ID,
    idempotencyKey: 'idempotency_task-ledger-postimage-fence',
    expectedSourceGeneration: sourceGeneration,
    expectedRevision: before.revision,
    taskId: taskIdFor('1'),
    ownerId: E2E_MEMBER_ID,
  };
  const substitutedText = serializeRecord({
    ...(before.files.get('1.json')?.record ?? {}),
    externalWriterRevision: 'substituted-after-ledger-fsync',
  });
  let mutationError: string | null = null;
  try {
    await admitFakeRuntimeTaskMutation(
      { command, payloadFingerprint: fakeRuntimeTaskPayloadFingerprint(command) },
      undefined,
      undefined,
      undefined,
      () => durableReplaceText(taskPath, substitutedText)
    );
  } catch (error) {
    mutationError = error instanceof Error ? error.message : 'unknown';
  }
  const walBeforeRetry = await optionalText(TASK_WAL_PATH);
  let retryError: string | null = null;
  try {
    await admitFakeRuntimeTaskMutation({
      command,
      payloadFingerprint: fakeRuntimeTaskPayloadFingerprint(command),
    });
  } catch (error) {
    retryError = error instanceof Error ? error.message : 'unknown';
  }
  const state = await readRuntimeState();
  return Object.freeze({
    mutationError,
    retryError,
    substitutedWriterPreserved: (await optionalText(taskPath)) === substitutedText,
    walRetained: (await optionalText(TASK_WAL_PATH)) !== null,
    walByteStable:
      walBeforeRetry !== null && (await optionalText(TASK_WAL_PATH)) === walBeforeRetry,
    taskLedgerCount: (state.taskLedger ?? []).length,
  });
}

async function proveFakeRuntimeTaskLedgerValidation(): Promise<Record<string, unknown>> {
  const sourceGeneration = `generation_${'d'.repeat(64)}`;
  const before = await taskBoardSnapshot(sourceGeneration);
  const command = {
    schemaVersion: 1,
    kind: 'update_owner',
    commandId: 'command_task-ledger-validation',
    teamId: TEAM_ID,
    idempotencyKey: 'idempotency_task-ledger-validation',
    expectedSourceGeneration: sourceGeneration,
    expectedRevision: before.revision,
    taskId: taskIdFor('1'),
    ownerId: E2E_MEMBER_ID,
  };
  await admitFakeRuntimeTaskMutation({
    command,
    payloadFingerprint: fakeRuntimeTaskPayloadFingerprint(command),
  });
  const settledState = await readRuntimeState();
  const taskBytes = await optionalText(`${TASKS_DIRECTORY}/1.json`);
  const entry = settledState.taskLedger?.[0];
  if (entry === undefined) throw new Error('fake_runtime_task_ledger_validation_fixture_missing');
  await writeRuntimeState({ ...settledState, taskLedger: [entry, entry] });
  let duplicateError: string | null = null;
  try {
    await admitFakeRuntimeTaskMutation({
      command,
      payloadFingerprint: fakeRuntimeTaskPayloadFingerprint(command),
    });
  } catch (error) {
    duplicateError = error instanceof Error ? error.message : 'unknown';
  }
  await writeRuntimeState({
    ...settledState,
    taskLedger: [
      {
        ...entry,
        receipt: { ...entry.receipt, revision: `revision_${'e'.repeat(64)}` },
      },
    ],
  });
  let substitutedError: string | null = null;
  try {
    await admitFakeRuntimeTaskMutation({
      command,
      payloadFingerprint: fakeRuntimeTaskPayloadFingerprint(command),
    });
  } catch (error) {
    substitutedError = error instanceof Error ? error.message : 'unknown';
  }
  // A later mutation must not make an earlier receipt self-authenticating. Its exact validated
  // WAL remains in the durable row, so historical receipt substitution is still rejected.
  await writeRuntimeState(settledState);
  const afterFirst = await taskBoardSnapshot(sourceGeneration);
  const laterCommand = {
    schemaVersion: 1,
    kind: 'update_status',
    commandId: 'command_task-ledger-validation-later',
    teamId: TEAM_ID,
    idempotencyKey: 'idempotency_task-ledger-validation-later',
    expectedSourceGeneration: sourceGeneration,
    expectedRevision: afterFirst.revision,
    taskId: taskIdFor('1'),
    status: 'in_progress',
  };
  await admitFakeRuntimeTaskMutation({
    command: laterCommand,
    payloadFingerprint: fakeRuntimeTaskPayloadFingerprint(laterCommand),
  });
  const afterLater = await readRuntimeState();
  const historicalTaskBytes = await optionalText(`${TASKS_DIRECTORY}/1.json`);
  const [historicalEntry, laterEntry] = afterLater.taskLedger ?? [];
  if (historicalEntry === undefined || laterEntry === undefined) {
    throw new Error('fake_runtime_task_ledger_validation_history_fixture_missing');
  }
  await writeRuntimeState({
    ...afterLater,
    taskLedger: [
      {
        ...historicalEntry,
        receipt: { ...historicalEntry.receipt, revision: `revision_${'f'.repeat(64)}` },
      },
      laterEntry,
    ],
  });
  let historicalSubstitutedError: string | null = null;
  try {
    await admitFakeRuntimeTaskMutation({
      command,
      payloadFingerprint: fakeRuntimeTaskPayloadFingerprint(command),
    });
  } catch (error) {
    historicalSubstitutedError = error instanceof Error ? error.message : 'unknown';
  }
  return Object.freeze({
    duplicateError,
    substitutedError,
    historicalSubstitutedError,
    taskBytesStable:
      taskBytes !== null &&
      historicalTaskBytes !== null &&
      (await optionalText(`${TASKS_DIRECTORY}/1.json`)) === historicalTaskBytes,
    walAbsent: (await optionalText(TASK_WAL_PATH)) === null,
  });
}

async function proveFakeRuntimeUpdateRelationship(): Promise<Record<string, unknown>> {
  const sourceGeneration = `generation_${'7'.repeat(64)}`;
  await writeFile(
    `${TASKS_DIRECTORY}/2.json`,
    serializeRecord({
      id: '2',
      subject: 'Relationship peer',
      status: 'pending',
      owner: null,
      blockedBy: [],
      blocks: [],
      related: [],
    })
  );
  const execute = async (
    relationship: 'blocks' | 'related',
    action: 'add' | 'remove',
    suffix: string,
    expectedRevision: string,
    afterRename?: (publishedCount: number) => void | Promise<void>
  ) => {
    const command = {
      schemaVersion: 1,
      kind: 'update_relationship',
      commandId: `command_relationship-${suffix}`,
      teamId: TEAM_ID,
      idempotencyKey: `idempotency_relationship-${suffix}`,
      expectedSourceGeneration: sourceGeneration,
      expectedRevision,
      action,
      taskId: taskIdFor('1'),
      otherTaskId: taskIdFor('2'),
      relationship,
    };
    return {
      command,
      result: await admitFakeRuntimeTaskMutation(
        { command, payloadFingerprint: fakeRuntimeTaskPayloadFingerprint(command) },
        undefined,
        undefined,
        afterRename
      ),
    };
  };
  const before = await taskBoardSnapshot(sourceGeneration);
  const added = await execute('blocks', 'add', 'blocks-add', before.revision);
  const replay = await admitFakeRuntimeTaskMutation({
    command: added.command,
    payloadFingerprint: fakeRuntimeTaskPayloadFingerprint(added.command),
  });
  const afterAdd = await taskBoardSnapshot(sourceGeneration);
  const duplicate = await execute('blocks', 'add', 'blocks-duplicate', afterAdd.revision);
  const removed = await execute('blocks', 'remove', 'blocks-remove', afterAdd.revision);
  const afterRemove = await taskBoardSnapshot(sourceGeneration);
  const relatedAdded = await execute('related', 'add', 'related-add', afterRemove.revision);
  const relatedReplay = await admitFakeRuntimeTaskMutation({
    command: relatedAdded.command,
    payloadFingerprint: fakeRuntimeTaskPayloadFingerprint(relatedAdded.command),
  });
  const afterRelatedAdd = await taskBoardSnapshot(sourceGeneration);
  const relatedDuplicate = await execute(
    'related',
    'add',
    'related-duplicate',
    afterRelatedAdd.revision
  );
  const relatedRemoved = await execute(
    'related',
    'remove',
    'related-remove',
    afterRelatedAdd.revision
  );
  const afterRelatedRemove = await taskBoardSnapshot(sourceGeneration);
  let crashError: string | null = null;
  let crashedCommand: Record<string, unknown> | null = null;
  try {
    const crashed = await execute(
      'blocks',
      'add',
      'blocks-crash',
      afterRelatedRemove.revision,
      (publishedCount) => {
        if (publishedCount === 1) throw new Error('fake_runtime_relationship_first_write_crash');
      }
    );
    crashedCommand = crashed.command;
  } catch (error) {
    crashError = error instanceof Error ? error.message : 'unknown';
    const walText = await optionalText(TASK_WAL_PATH);
    if (walText !== null) crashedCommand = parseFakeRuntimeTaskWal(JSON.parse(walText)).command;
  }
  await recoverFakeRuntimeTaskMutationWal();
  if (crashedCommand === null) throw new Error('fake_runtime_relationship_crash_command_missing');
  const crashReplay = await admitFakeRuntimeTaskMutation({
    command: crashedCommand,
    payloadFingerprint: fakeRuntimeTaskPayloadFingerprint(crashedCommand),
  });
  const afterCrashRecovery = await taskBoardSnapshot(sourceGeneration);
  await execute('blocks', 'remove', 'blocks-crash-remove', afterCrashRecovery.revision);
  const clean = await taskBoardSnapshot(sourceGeneration);
  const sourceTaskPath = `${TASKS_DIRECTORY}/1.json`;
  const asymmetricSource = {
    ...(clean.files.get('1.json')?.record ?? {}),
    related: ['2'],
  };
  await durableReplaceText(sourceTaskPath, serializeRecord(asymmetricSource));
  const asymmetricBefore = await taskBoardSnapshot(sourceGeneration);
  const asymmetric = await execute(
    'related',
    'add',
    'related-asymmetric',
    asymmetricBefore.revision
  );
  const asymmetricAfter = await taskBoardSnapshot(sourceGeneration);
  return Object.freeze({
    add: added.result,
    replay,
    duplicate: duplicate.result,
    remove: removed.result,
    afterAdd: {
      sourceBlocks: afterAdd.files.get('1.json')?.record.blocks,
      targetBlockedBy: afterAdd.files.get('2.json')?.record.blockedBy,
    },
    afterRemove: {
      sourceBlocks: afterRemove.files.get('1.json')?.record.blocks,
      targetBlockedBy: afterRemove.files.get('2.json')?.record.blockedBy,
    },
    related: {
      add: relatedAdded.result,
      replay: relatedReplay,
      duplicate: relatedDuplicate.result,
      remove: relatedRemoved.result,
      afterAdd: {
        sourceRelated: afterRelatedAdd.files.get('1.json')?.record.related,
        targetRelated: afterRelatedAdd.files.get('2.json')?.record.related,
      },
      afterRemove: {
        sourceRelated: afterRelatedRemove.files.get('1.json')?.record.related,
        targetRelated: afterRelatedRemove.files.get('2.json')?.record.related,
      },
    },
    crashRecovery: {
      error: crashError,
      replay: crashReplay,
      sourceBlocks: afterCrashRecovery.files.get('1.json')?.record.blocks,
      targetBlockedBy: afterCrashRecovery.files.get('2.json')?.record.blockedBy,
    },
    asymmetric: {
      result: asymmetric.result,
      sourceRelated: asymmetricAfter.files.get('1.json')?.record.related,
      targetRelated: asymmetricAfter.files.get('2.json')?.record.related,
    },
  });
}

async function proveFakeRuntimeUpdateStatusPlacement(): Promise<Record<string, unknown>> {
  const attempt = process.argv[3] ?? 'initial';
  if (!/^[a-z-]+$/u.test(attempt)) throw new Error('fake_runtime_task_proof_attempt_invalid');
  const sourceGeneration = `generation_${'9'.repeat(64)}`;
  const before = await taskBoardSnapshot(sourceGeneration);
  const command = {
    schemaVersion: 1,
    kind: 'update_status',
    commandId: `command_update_status_placement_${attempt}`,
    teamId: TEAM_ID,
    idempotencyKey: `idempotency_update_status_placement_${attempt}`,
    expectedSourceGeneration: sourceGeneration,
    expectedRevision: before.revision,
    taskId: taskIdFor('1'),
    status: 'completed',
  };
  const result = await admitFakeRuntimeTaskMutation({
    command,
    payloadFingerprint: fakeRuntimeTaskPayloadFingerprint(command),
  });
  return {
    result,
    task: JSON.parse(await readFile(`${TASKS_DIRECTORY}/1.json`, 'utf8')),
    kanban: JSON.parse(await readFile(TASK_KANBAN_PATH, 'utf8')),
  };
}

/**
 * Process-level proof for the fake external owner's uncertainty boundary. It models an execute
 * response loss, restart recovery from `started`, ledger/result substitution, and idempotency-key
 * collision without requiring Docker or a real provider runtime.
 */
export async function proveFakeRuntimeLifecycleDurability(): Promise<Record<string, unknown>> {
  await mkdir(FAKE_RUNTIME_STATE_ROOT, { recursive: true });
  const command = parseFakeRuntimeLifecycleCommand({
    schemaVersion: 1,
    action: 'stop',
    commandId: 'lifecycle-command_durable-proof-0001',
    idempotencyKey: 'idempotency_durable-proof-0001',
    workspaceId: PUBLIC_WORKSPACE_ID,
    teamId: TEAM_ID,
    expectedRevision: `revision_${'1'.repeat(64)}`,
    runId: 'run_durable-proof-0001',
  });
  const context = Object.freeze({
    deploymentId: DEPLOYMENT_ID,
    actorId: 'actor_hosted-v1-durable-proof',
    bootId: `boot_hosted-v1-e2e-${'2'.repeat(48)}`,
  });
  const authority = Object.freeze({
    restoreGeneration: 0,
    mountGeneration: 1,
    ownerEffectFence: FAKE_RUNTIME_PROOF_OWNER_EFFECT_FENCE,
  });
  const durableCommand = fakeRuntimeLifecycleDurableCommand(command, context, authority);
  const canonicalInitialRevision = `revision_${'0'.repeat(64)}`;
  const emptyInitialState: FakeRuntimeState = {
    schemaVersion: 1,
    lifecycleInitialRevision: canonicalInitialRevision,
    activeRuns: [],
    commands: [],
    eventIds: [],
    messageLedger: [],
    taskLedger: [],
    lifecycleCommandLedger: [],
    lifecycleReleaseLedger: [],
  };
  const wrongInitialLaunch = parseFakeRuntimeLifecycleCommand({
    schemaVersion: 1,
    action: 'launch',
    commandId: 'lifecycle-command_wrong-initial-revision',
    idempotencyKey: 'idempotency_wrong-initial-revision',
    workspaceId: PUBLIC_WORKSPACE_ID,
    teamId: TEAM_ID,
    expectedRevision: `revision_${'9'.repeat(64)}`,
  });
  const stopWithoutRun = parseFakeRuntimeLifecycleCommand({
    ...command,
    commandId: 'lifecycle-command_stop-without-run',
    idempotencyKey: 'idempotency_stop-without-run',
    expectedRevision: canonicalInitialRevision,
  });
  const recoverWithoutHistory = parseFakeRuntimeLifecycleCommand({
    ...command,
    action: 'recover',
    commandId: 'lifecycle-command_recover-without-history',
    idempotencyKey: 'idempotency_recover-without-history',
    expectedRevision: canonicalInitialRevision,
    runId: 'run_recover-without-history',
  });
  const initialFences = Object.freeze({
    wrongRevision: inspectFakeRuntimeLifecycleAdmission(
      emptyInitialState,
      wrongInitialLaunch,
      fakeRuntimeLifecycleDurableCommand(wrongInitialLaunch, context, authority)
    ),
    stopWithoutRun: inspectFakeRuntimeLifecycleAdmission(
      emptyInitialState,
      stopWithoutRun,
      fakeRuntimeLifecycleDurableCommand(stopWithoutRun, context, authority)
    ),
    recoverWithoutHistory: inspectFakeRuntimeLifecycleAdmission(
      emptyInitialState,
      recoverWithoutHistory,
      fakeRuntimeLifecycleDurableCommand(recoverWithoutHistory, context, authority)
    ),
  });
  const initialState: FakeRuntimeState = {
    schemaVersion: 1,
    activeRuns: [{ teamId: TEAM_ID, runId: String(command.runId) }],
    commands: [
      {
        action: 'recover',
        commandId: 'lifecycle-command_durable-proof-seed',
        runId: String(command.runId),
        teamId: TEAM_ID,
        workspaceId: PUBLIC_WORKSPACE_ID,
        resourceRevision: String(command.expectedRevision),
      },
    ],
    eventIds: [],
    messageLedger: [],
    taskLedger: [],
    lifecycleCommandLedger: [],
  };
  await writeRuntimeState(initialState);

  const fresh = await executeFakeRuntimeLifecycleDurably(command, durableCommand);
  const replay = await executeFakeRuntimeLifecycleDurably(command, durableCommand);
  const settledState = await readRuntimeState();
  const primaryKey = fakeRuntimeLifecycleLedgerKey(durableCommand);

  // Response loss after the effect but before the settled receipt: restart sees `started`, verifies
  // the exact postimage, and settles without invoking the effect a second time.
  const responseLostState: FakeRuntimeState = {
    ...settledState,
    lifecycleCommandLedger: (settledState.lifecycleCommandLedger ?? []).map((entry) =>
      entry.key === primaryKey
        ? Object.freeze({
            key: entry.key,
            command: entry.command,
            durableCommand: entry.durableCommand,
            state: 'started' as const,
          })
        : entry
    ),
  };
  await writeRuntimeState(responseLostState);
  const recovered = await resolveFakeRuntimeLifecycleLedger(command, durableCommand);
  const recoveredState = await readRuntimeState();
  const substitutedGrantFence = await resolveFakeRuntimeLifecycleLedger(
    command,
    fakeRuntimeLifecycleDurableCommand(command, context, {
      ...authority,
      ownerEffectFence: {
        ...FAKE_RUNTIME_PROOF_OWNER_EFFECT_FENCE,
        grantRevision: sha256('agent-teams.hosted-v1-e2e.substituted-grant-revision/v1'),
      },
    })
  );
  const substitutedIdentityFence = await resolveFakeRuntimeLifecycleLedger(
    command,
    fakeRuntimeLifecycleDurableCommand(command, context, {
      ...authority,
      ownerEffectFence: {
        ...FAKE_RUNTIME_PROOF_OWNER_EFFECT_FENCE,
        identityChecksum: sha256('agent-teams.hosted-v1-e2e.substituted-identity-checksum/v1'),
      },
    })
  );
  const exactReplayAdmission = inspectFakeRuntimeLifecycleAdmission(
    recoveredState,
    command,
    durableCommand
  );
  const staleNewKeyCommand = parseFakeRuntimeLifecycleCommand({
    ...command,
    commandId: 'lifecycle-command_durable-proof-stale-key',
    idempotencyKey: 'idempotency_durable-proof-stale-key',
  });
  const staleNewKeyAdmission = inspectFakeRuntimeLifecycleAdmission(
    recoveredState,
    staleNewKeyCommand,
    fakeRuntimeLifecycleDurableCommand(staleNewKeyCommand, context, authority)
  );

  // A later legitimate effect may advance the live projection. The older exact receipt remains
  // replayable only while the complete append-only projection (including launch events) is valid.
  const laterRecoverCommand = parseFakeRuntimeLifecycleCommand({
    schemaVersion: 1,
    action: 'recover',
    commandId: 'lifecycle-command_durable-proof-later-recover',
    idempotencyKey: 'idempotency_durable-proof-later-recover',
    workspaceId: PUBLIC_WORKSPACE_ID,
    teamId: TEAM_ID,
    expectedRevision: fakeRuntimeLifecycleFinalRevision(durableCommand),
    runId: String(command.runId),
  });
  const laterRecoverDurableCommand = fakeRuntimeLifecycleDurableCommand(
    laterRecoverCommand,
    context,
    authority
  );
  await executeFakeRuntimeLifecycleDurably(laterRecoverCommand, laterRecoverDurableCommand);
  const laterState = await readRuntimeState();
  const historicalReplay = await resolveFakeRuntimeLifecycleLedger(command, durableCommand);
  const staleOldRunCommand = parseFakeRuntimeLifecycleCommand({
    schemaVersion: 1,
    action: 'stop',
    commandId: 'lifecycle-command_durable-proof-stale-run',
    idempotencyKey: 'idempotency_durable-proof-stale-run',
    workspaceId: PUBLIC_WORKSPACE_ID,
    teamId: TEAM_ID,
    expectedRevision: fakeRuntimeLifecycleFinalRevision(laterRecoverDurableCommand),
    runId: 'run_durable-proof-stale-0001',
  });
  const staleOldRunAdmission = inspectFakeRuntimeLifecycleAdmission(
    laterState,
    staleOldRunCommand,
    fakeRuntimeLifecycleDurableCommand(staleOldRunCommand, context, authority)
  );
  await writeRuntimeState(recoveredState);

  // A settled receipt is not authoritative without its exact effect postimage.
  await writeRuntimeState({ ...recoveredState, commands: [] });
  const missingPostimage = await resolveFakeRuntimeLifecycleLedger(command, durableCommand);
  const missingPostimageState = await readRuntimeState();
  await writeRuntimeState(recoveredState);

  // Duplicate matching effect rows are ambiguous and therefore cannot fabricate settlement.
  await writeRuntimeState({
    ...recoveredState,
    commands: [...recoveredState.commands, ...recoveredState.commands],
  });
  const duplicatePostimage = await resolveFakeRuntimeLifecycleLedger(command, durableCommand);
  await writeRuntimeState(recoveredState);

  // The active-run side of a stop postimage is also part of the durable resource postimage.
  await writeRuntimeState({
    ...recoveredState,
    activeRuns: [{ teamId: TEAM_ID, runId: String(command.runId) }],
  });
  const substitutedRunPostimage = await resolveFakeRuntimeLifecycleLedger(command, durableCommand);
  await writeRuntimeState(recoveredState);

  let tamperedResultRejected = false;
  await writeRuntimeState({
    ...recoveredState,
    lifecycleCommandLedger: (recoveredState.lifecycleCommandLedger ?? []).map((entry) =>
      entry.key === primaryKey
        ? {
            ...entry,
            result: {
              ...(entry.result ?? {}),
              resourceRevision: `revision_${'f'.repeat(64)}`,
            },
          }
        : entry
    ),
  });
  try {
    await resolveFakeRuntimeLifecycleLedger(command, durableCommand);
  } catch (error) {
    tamperedResultRejected =
      error instanceof Error && error.message === 'fake_runtime_lifecycle_ledger_invalid';
  }
  await writeRuntimeState(recoveredState);

  const collisionCommand = parseFakeRuntimeLifecycleCommand({
    ...command,
    commandId: 'lifecycle-command_durable-proof-collision',
    expectedRevision: `revision_${'3'.repeat(64)}`,
  });
  const collision = await resolveFakeRuntimeLifecycleLedger(
    collisionCommand,
    fakeRuntimeLifecycleDurableCommand(collisionCommand, context, authority)
  );

  const orphanCommand = parseFakeRuntimeLifecycleCommand({
    ...command,
    commandId: 'lifecycle-command_durable-proof-orphan',
    idempotencyKey: 'idempotency_durable-proof-orphan',
    expectedRevision: `revision_${'4'.repeat(64)}`,
  });
  const orphanDurableCommand = fakeRuntimeLifecycleDurableCommand(
    orphanCommand,
    context,
    authority
  );
  const orphanStarted: FakeRuntimeLifecycleCommandLedgerEntry = Object.freeze({
    key: fakeRuntimeLifecycleLedgerKey(orphanDurableCommand),
    command: orphanCommand,
    durableCommand: orphanDurableCommand,
    state: 'started',
  });
  await writeRuntimeState(
    replaceFakeRuntimeLifecycleLedgerEntry(await readRuntimeState(), orphanStarted)
  );
  const orphan = await resolveFakeRuntimeLifecycleLedger(orphanCommand, orphanDurableCommand);
  const finalState = await readRuntimeState();
  const orphanLedgerState = (finalState.lifecycleCommandLedger ?? []).find(
    (entry) => entry.key === orphanStarted.key
  )?.state;

  return Object.freeze({
    initialFences,
    fresh: {
      kind: fresh.kind,
      replayed: fresh.kind === 'settled' ? fresh.replayed : null,
    },
    replay: {
      kind: replay.kind,
      replayed: replay.kind === 'settled' ? replay.replayed : null,
    },
    recovered: {
      kind: recovered.kind,
      replayed: recovered.kind === 'settled' ? recovered.replayed : null,
      commandCount: recoveredState.commands.length,
    },
    effectFenceSubstitution: {
      grantRevision: substitutedGrantFence.kind,
      identityChecksum: substitutedIdentityFence.kind,
    },
    admission: {
      exactReplay: exactReplayAdmission,
      staleNewKey: staleNewKeyAdmission,
      staleOldRun: staleOldRunAdmission,
    },
    historicalReplay: {
      kind: historicalReplay.kind,
      replayed: historicalReplay.kind === 'settled' ? historicalReplay.replayed : null,
      commandCount: laterState.commands.length,
    },
    missingPostimage: {
      kind: missingPostimage.kind,
      ledgerState: (missingPostimageState.lifecycleCommandLedger ?? []).find(
        (entry) => entry.key === primaryKey
      )?.state,
    },
    duplicatePostimage: duplicatePostimage.kind,
    substitutedRunPostimage: substitutedRunPostimage.kind,
    tamperedResultRejected,
    collision: collision.kind,
    orphan: { kind: orphan.kind, ledgerState: orphanLedgerState },
    finalCommandCount: finalState.commands.length,
  });
}

export async function proveFakeRuntimeLifecyclePreEffectFence(): Promise<Record<string, unknown>> {
  await mkdir(FAKE_RUNTIME_STATE_ROOT, { recursive: true });
  const expectedRevision = `revision_${'5'.repeat(64)}`;
  const runId = 'run_pre-effect-fence-0001';
  const command = parseFakeRuntimeLifecycleCommand({
    schemaVersion: 1,
    action: 'stop',
    commandId: 'lifecycle-command_pre-effect-fence-0001',
    idempotencyKey: 'idempotency_pre-effect-fence-0001',
    workspaceId: PUBLIC_WORKSPACE_ID,
    teamId: TEAM_ID,
    expectedRevision,
    runId,
  });
  const context = Object.freeze({
    deploymentId: DEPLOYMENT_ID,
    actorId: 'actor_pre-effect-fence-0001',
    bootId: `boot_hosted-v1-e2e-${'6'.repeat(48)}`,
  });
  const durableCommand = fakeRuntimeLifecycleDurableCommand(command, context, {
    restoreGeneration: 0,
    mountGeneration: 1,
    ownerEffectFence: FAKE_RUNTIME_PROOF_OWNER_EFFECT_FENCE,
  });
  await writeRuntimeState({
    schemaVersion: 1,
    activeRuns: [{ teamId: TEAM_ID, runId }],
    commands: [
      {
        action: 'recover',
        commandId: 'lifecycle-command_pre-effect-fence-seed',
        runId,
        teamId: TEAM_ID,
        workspaceId: PUBLIC_WORKSPACE_ID,
        resourceRevision: expectedRevision,
      },
    ],
    eventIds: [],
    messageLedger: [],
    taskLedger: [],
    lifecycleCommandLedger: [],
    lifecycleReleaseLedger: [],
  });
  let error: string | null = null;
  try {
    await executeFakeRuntimeLifecycleDurably(command, durableCommand, () => {
      throw new Error('fake_runtime_pre_effect_fence_rejected');
    });
  } catch (caught) {
    error = caught instanceof Error ? caught.message : 'unknown';
  }
  const state = await readRuntimeState();
  const launchRevision = `revision_${'7'.repeat(64)}`;
  const launchCommand = parseFakeRuntimeLifecycleCommand({
    schemaVersion: 1,
    action: 'launch',
    commandId: 'lifecycle-command_pre-effect-launch-0001',
    idempotencyKey: 'idempotency_pre-effect-launch-0001',
    workspaceId: PUBLIC_WORKSPACE_ID,
    teamId: TEAM_ID,
    expectedRevision: launchRevision,
  });
  const launchDurableCommand = fakeRuntimeLifecycleDurableCommand(launchCommand, context, {
    restoreGeneration: 0,
    mountGeneration: 1,
    ownerEffectFence: FAKE_RUNTIME_PROOF_OWNER_EFFECT_FENCE,
  });
  await writeRuntimeState({
    schemaVersion: 1,
    lifecycleInitialRevision: launchRevision,
    activeRuns: [],
    commands: [],
    eventIds: [],
    messageLedger: [],
    taskLedger: [],
    lifecycleCommandLedger: [],
    lifecycleReleaseLedger: [],
  });
  let launchFenceChecks = 0;
  let launchError: string | null = null;
  try {
    await executeFakeRuntimeLifecycleDurably(launchCommand, launchDurableCommand, () => {
      launchFenceChecks += 1;
      if (launchFenceChecks === 3) {
        throw new Error('fake_runtime_launch_deadline_expired_after_import');
      }
    });
  } catch (caught) {
    launchError = caught instanceof Error ? caught.message : 'unknown';
  }
  const launchState = await readRuntimeState();

  // Revoke immediately after the durable runtime postimage. The old owner must not settle or
  // answer success, while a later authenticated lookup can forward-recover the exact started row
  // without repeating the external effect.
  await writeRuntimeState({
    schemaVersion: 1,
    activeRuns: [{ teamId: TEAM_ID, runId }],
    commands: [
      {
        action: 'recover',
        commandId: 'lifecycle-command_post-effect-fence-seed',
        runId,
        teamId: TEAM_ID,
        workspaceId: PUBLIC_WORKSPACE_ID,
        resourceRevision: expectedRevision,
      },
    ],
    eventIds: [],
    messageLedger: [],
    taskLedger: [],
    lifecycleCommandLedger: [],
    lifecycleReleaseLedger: [],
  });
  let postEffectFenceChecks = 0;
  let postEffectError: string | null = null;
  try {
    await executeFakeRuntimeLifecycleDurably(command, durableCommand, () => {
      postEffectFenceChecks += 1;
      if (postEffectFenceChecks === 4) {
        throw new Error('fake_runtime_post_effect_fence_rejected');
      }
    });
  } catch (caught) {
    postEffectError = caught instanceof Error ? caught.message : 'unknown';
  }
  const postEffectState = await readRuntimeState();
  const postEffectRecovery = await resolveFakeRuntimeLifecycleLedger(command, durableCommand);
  const postEffectRecoveredState = await readRuntimeState();
  return Object.freeze({
    error,
    commandCount: state.commands.length,
    activeRuns: state.activeRuns,
    ledgerState: state.lifecycleCommandLedger?.[0]?.state ?? null,
    launchAfterImport: {
      error: launchError,
      fenceChecks: launchFenceChecks,
      commandCount: launchState.commands.length,
      eventCount: launchState.eventIds.length,
      activeRuns: launchState.activeRuns,
      ledgerState: launchState.lifecycleCommandLedger?.[0]?.state ?? null,
    },
    postEffect: {
      error: postEffectError,
      fenceChecks: postEffectFenceChecks,
      commandCount: postEffectState.commands.length,
      activeRuns: postEffectState.activeRuns,
      ledgerState: postEffectState.lifecycleCommandLedger?.[0]?.state ?? null,
      recovery: {
        kind: postEffectRecovery.kind,
        replayed: postEffectRecovery.kind === 'settled' ? postEffectRecovery.replayed : null,
        commandCount: postEffectRecoveredState.commands.length,
        ledgerState: postEffectRecoveredState.lifecycleCommandLedger?.[0]?.state ?? null,
      },
    },
  });
}

async function serveFakeRuntime(): Promise<void> {
  const socketPath = process.env.HOSTED_LIFECYCLE_ORCHESTRATOR_SOCKET ?? LIFECYCLE_SOCKET_PATH;
  if (socketPath !== LIFECYCLE_SOCKET_PATH) {
    throw new Error('hosted_e2e_fake_runtime_socket_path_invalid');
  }
  if (
    process.env.HOSTED_LIFECYCLE_OWNER_ADMISSION_MANIFEST_FILE !== LIFECYCLE_OWNER_MANIFEST_PATH
  ) {
    throw new Error('hosted_e2e_fake_runtime_manifest_path_invalid');
  }
  const bootId = process.env.E2E_BOOT_ID;
  if (!bootId) throw new Error('hosted_e2e_fake_runtime_boot_id_missing');
  const bootstrap = process.env.AGENT_TEAMS_HOSTED_TEAM_LIFECYCLE_READ_BOOTSTRAP;
  if (!bootstrap) throw new Error('hosted_e2e_fake_runtime_bootstrap_missing');
  const mountGeneration = await readFakeRuntimeMountGeneration(bootId);
  const bootstrapMountGeneration = fakeRuntimeBootstrapMountGeneration(bootstrap, bootId);
  if (bootstrapMountGeneration !== mountGeneration) {
    // Emit bounded diagnostic evidence without touching the socket, WAL, runtime state, or owner
    // generation. A fresh bootstrap is required before this process may mutate any authority state.
    await writeFile(
      FAKE_RUNTIME_LIFECYCLE_TRACE_PATH,
      `${JSON.stringify([
        {
          sequence: 1,
          operation: 'readiness',
          stage: 'mount_generation_stale',
          expectedMountGeneration: mountGeneration,
          receivedMountGeneration: bootstrapMountGeneration,
        },
      ])}\n`,
      { mode: 0o600 }
    );
    assertFakeRuntimeMountGenerationCurrent({
      expectedMountGeneration: mountGeneration,
      receivedMountGeneration: bootstrapMountGeneration,
    });
  }
  const trustAnchor = await lifecycleTrustAnchor();
  const releasePin = await lifecycleOwnerReleasePin();
  const launcherPrivateKey = await lifecycleLauncherPrivateKey(releasePin);
  const { default: Database } = await import('better-sqlite3');
  await rm(socketPath, { force: true });
  await rm(LIFECYCLE_OWNER_MANIFEST_PATH, { force: true });
  await recoverFakeRuntimeTaskMutationWal();
  await writeRuntimeState(await readRuntimeState());
  // A proof belongs to one live owner epoch. Never admit commands while stale bytes from a
  // crashed predecessor remain consumable by the controller's read-only mount.
  await invalidateFakeRuntimeAuthDrainEvidence(AUTH_DRAIN_EVIDENCE_PATH);
  const lifecycleTrace: Array<Readonly<Record<string, unknown>>> = [];
  let lifecycleTraceWrite = Promise.resolve();
  const traceLifecycle = (entry: Readonly<Record<string, unknown>>): Promise<void> => {
    lifecycleTrace.push(Object.freeze({ sequence: lifecycleTrace.length + 1, ...entry }));
    lifecycleTraceWrite = lifecycleTraceWrite.then(() =>
      writeFile(FAKE_RUNTIME_LIFECYCLE_TRACE_PATH, `${JSON.stringify(lifecycleTrace)}\n`, {
        mode: 0o600,
      })
    );
    return lifecycleTraceWrite;
  };
  const ownerMutationErrorTrace = createFakeRuntimeOwnerMutationErrorTrace(
    FAKE_RUNTIME_OWNER_MUTATION_ERROR_TRACE_PATH
  );
  await traceLifecycle({ operation: 'startup', stage: 'ready', mountGeneration });
  const owner = {
    authorizationGeneration: 0,
    binding: null as Record<string, unknown> | null,
    socketIdentity: { device: '0', inode: '0', uid: 0, gid: 0, mode: 0o600 },
  };
  let admittedOwnerBinding: Readonly<Record<string, unknown>> | null = null;
  const issued = new Map<
    string,
    {
      authorization: Record<string, unknown>;
      originalAuthorization: Record<string, unknown>;
      ownerBinding: Record<string, unknown>;
      phase: 'authorized' | 'validated' | 'executing' | 'executed';
      expiresAt: number;
      drainEpoch: number;
    }
  >();
  const authDrainEpochFence = createFakeRuntimeAuthDrainEpochFence();
  const runtimeStateMutationQueue = createFakeRuntimeStateMutationQueue();
  const authorizationKey = (authorization: Record<string, unknown>): string =>
    `${String(authorization.grantId)}\u0000${String(authorization.authorizationGeneration)}`;
  const sameAuthorization = (
    left: Record<string, unknown>,
    right: Record<string, unknown>
  ): boolean => canonicalJson(left) === canonicalJson(right);
  const assertOwnerBindingCurrent = (expected: Record<string, unknown>): void => {
    if (owner.binding === null || !sameAuthorization(owner.binding, expected)) {
      throw new Error('fake_runtime_owner_binding_changed');
    }
  };
  const assertOwnerEffectFenceCurrent = (authority: Record<string, unknown>): void => {
    if (authDrainCoordinator.isDrained()) throw new Error('fake_runtime_auth_drain_active');
    const fence = requireFakeRuntimeOwnerEffectFence(authority.ownerEffectFence);
    const identityDatabase = new Database(`${APP_DATA_ROOT}/storage/app.db`, {
      readonly: true,
      fileMustExist: true,
    });
    const authDatabase = new Database(`${AUTH_DATA_ROOT}/storage/app.db`, {
      readonly: true,
      fileMustExist: true,
    });
    try {
      const identity = identityDatabase
        .prepare(
          `SELECT identity_checksum AS identityChecksum,
                  workspace_id AS runtimeWorkspaceId
           FROM team_identity_records
           WHERE team_id = ? AND state = 'active'`
        )
        .get(String(authority.teamId)) as
        | {
            readonly identityChecksum?: unknown;
            readonly runtimeWorkspaceId?: unknown;
          }
        | undefined;
      const grants = authDatabase
        .prepare(
          `SELECT grants.grant_revision AS grantRevision,
                  workspaces.runtime_workspace_id AS runtimeWorkspaceId
           FROM hosted_workspace_grants AS grants
           JOIN hosted_workspaces AS workspaces
             ON workspaces.runtime_workspace_id = grants.runtime_workspace_id
           WHERE (workspaces.runtime_workspace_id = ? OR workspaces.public_workspace_id = ?)
             AND grants.grant_revision = ?`
        )
        .all(
          String(authority.workspaceId),
          String(authority.workspaceId),
          fence.grantRevision
        ) as readonly {
        readonly grantRevision?: unknown;
        readonly runtimeWorkspaceId?: unknown;
      }[];
      if (
        identity?.identityChecksum !== fence.identityChecksum ||
        grants.length !== 1 ||
        grants[0]?.grantRevision !== fence.grantRevision ||
        identity.runtimeWorkspaceId !== grants[0].runtimeWorkspaceId
      ) {
        throw new Error('fake_runtime_owner_effect_fence_changed');
      }
    } finally {
      authDatabase.close();
      identityDatabase.close();
    }
  };
  const assertLifecycleEffectFence = (
    expectedOwnerBinding: Record<string, unknown>,
    context: Record<string, unknown>,
    authority: Record<string, unknown>
  ): void => {
    assertOwnerBindingCurrent(expectedOwnerBinding);
    assertOwnerEffectFenceCurrent(authority);
    if (!Number.isSafeInteger(context.deadlineAtMs) || Date.now() >= Number(context.deadlineAtMs)) {
      throw new Error('fake_runtime_deadline_expired');
    }
  };
  const authorizationKeys = [
    'grantId',
    'authorizationGeneration',
    'deploymentId',
    'bootId',
    'resourceRevision',
    'actorId',
    'workspaceId',
    'teamId',
    'restoreGeneration',
    'mountGeneration',
    'ownerEffectFence',
  ] as const;
  const sameAuthorizationFence = (
    left: Record<string, unknown>,
    right: Record<string, unknown>
  ): boolean =>
    hasExactKeys(left, authorizationKeys) &&
    hasExactKeys(right, authorizationKeys) &&
    authorizationKeys.every(
      (key) =>
        key === 'resourceRevision' ||
        (key === 'ownerEffectFence'
          ? canonicalJson(left[key]) === canonicalJson(right[key])
          : left[key] === right[key])
    );
  const connectedSockets = new Set<Socket>();
  let failNextAuthDrainPublication =
    process.env.E2E_AUTH_DRAIN_INDETERMINATE_ONCE === '1';
  let failNextAuthDrainInvalidation = failNextAuthDrainPublication;
  const authDrainCoordinator = createFakeRuntimeAuthDrainCoordinator({
    publish: async (resetGeneration) => {
      await publishFakeRuntimeAuthDrainEvidence({
        state: await readRuntimeState(),
        resetGeneration,
        observedAt: Date.now(),
        path: AUTH_DRAIN_EVIDENCE_PATH,
      });
      if (failNextAuthDrainPublication) {
        failNextAuthDrainPublication = false;
        throw new Error('hosted_e2e_auth_drain_publication_indeterminate');
      }
    },
    invalidate: () => {
      if (failNextAuthDrainInvalidation) {
        failNextAuthDrainInvalidation = false;
        return Promise.reject(new Error('hosted_e2e_auth_drain_invalidation_indeterminate'));
      }
      return invalidateFakeRuntimeAuthDrainEvidence(AUTH_DRAIN_EVIDENCE_PATH);
    },
    advanceEpoch: () => {
      authDrainEpochFence.drain();
    },
    revokeIssued: () => issued.clear(),
  });
  const authDrainServer = await startFakeRuntimeAuthDrainServer({
    socketPath: AUTH_DRAIN_SOCKET_PATH,
    queue: runtimeStateMutationQueue,
    coordinator: authDrainCoordinator,
  });
  const server = createNetServer({ allowHalfOpen: true }, (socket) => {
    connectedSockets.add(socket);
    const readinessLeasePublication = createFakeRuntimeReadinessLeasePublication(owner);
    registerFakeRuntimeReadinessLeaseCleanup(socket, () => {
      connectedSockets.delete(socket);
      readinessLeasePublication.close();
    });
    let body = '';
    let handled = false;
    let inputEnded = false;
    socket.setEncoding('utf8');
    const handleFrame = async (): Promise<void> => {
      if (handled) {
        return;
      }
      const newline = body.indexOf('\n');
      if (newline < 0) {
        if (inputEnded) socket.destroy(new Error('fake_runtime_frame_incomplete'));
        return;
      }
      let lifecycleOperation: string | null = null;
      let ownerMutationOperation: 'task_mutate' | null = null;
      try {
        if (newline !== body.length - 1) throw new Error('fake_runtime_extra_frame');
        const requestValue: unknown = JSON.parse(body.slice(0, newline));
        if (!isRecord(requestValue)) throw new Error();
        const request = requestValue;
        // Readiness owns a long-lived lease socket. Every one-shot command/mutation is withheld
        // until its authenticated frame is followed by write-side EOF.
        if (request.operation !== 'readiness' && !inputEnded) return;
        handled = true;
        if (request.operation === 'task_mutate') ownerMutationOperation = request.operation;
        if (
          authDrainCoordinator.isDrained() &&
          request.operation !== 'readiness' &&
          request.operation !== 'control_state' &&
          request.operation !== 'get_provisioning_status' &&
          request.operation !== 'release'
        ) {
          throw new Error('fake_runtime_auth_drain_active');
        }
        if (
          typeof request.operation === 'string' &&
          [
            'control_state',
            'authorize',
            'revalidate',
            'replay_lookup',
            'execute',
            'release',
          ].includes(request.operation)
        ) {
          lifecycleOperation = request.operation;
          await traceLifecycle({ operation: lifecycleOperation, stage: 'received' });
        }
        if (request.operation === 'readiness') {
          const authenticated = parseAuthenticatedFakeRuntimeReadinessFrame(body, trustAnchor);
          if (
            authenticated.value !== requestValue &&
            canonicalJson(authenticated.value) !== canonicalJson(request)
          ) {
            throw new Error();
          }
          if (
            !hasExactKeys(request, [
              'schemaVersion',
              'operation',
              'capability',
              'socketIdentity',
              'challenge',
              'bootstrapBinding',
              'expectedOwnerBinding',
              'controllerProof',
            ]) ||
            request.schemaVersion !== 2 ||
            request.capability !== 'hosted-lifecycle-command' ||
            typeof request.challenge !== 'string' ||
            !/^[0-9a-f]{64}$/.test(request.challenge) ||
            !isRecord(request.bootstrapBinding) ||
            !hasExactKeys(request.bootstrapBinding, [
              'deploymentId',
              'bootId',
              'workspaceId',
              'mountGeneration',
              'bootstrapDigest',
              'ownerArtifactDigest',
              'proofKeyId',
            ]) ||
            request.bootstrapBinding.deploymentId !== DEPLOYMENT_ID ||
            request.bootstrapBinding.bootId !== bootId ||
            request.bootstrapBinding.workspaceId !== RUNTIME_WORKSPACE_ID ||
            !Number.isSafeInteger(request.bootstrapBinding.mountGeneration) ||
            (request.bootstrapBinding.mountGeneration as number) < 1 ||
            typeof request.bootstrapBinding.bootstrapDigest !== 'string' ||
            !/^[0-9a-f]{64}$/.test(request.bootstrapBinding.bootstrapDigest) ||
            typeof request.bootstrapBinding.ownerArtifactDigest !== 'string' ||
            !/^sha256:[0-9a-f]{64}$/.test(request.bootstrapBinding.ownerArtifactDigest) ||
            request.bootstrapBinding.proofKeyId !==
              createHash('sha256').update(Buffer.from(trustAnchor, 'hex')).digest('hex') ||
            canonicalJson(request.socketIdentity) !== canonicalJson(owner.socketIdentity)
          ) {
            throw new Error();
          }
          // The mount-generation file is deployment-owned state and can advance while this owner
          // process remains alive. Re-read it for every readiness lease so a stopped/restarted
          // controller cannot be admitted against a stale bootstrap merely because the owner
          // cached its startup generation.
          const readinessMountGeneration = await readFakeRuntimeMountGeneration(bootId);
          if (request.bootstrapBinding.mountGeneration !== readinessMountGeneration) {
            await traceLifecycle({
              operation: 'readiness',
              stage: 'mount_generation_stale',
              expectedMountGeneration: readinessMountGeneration,
              receivedMountGeneration: request.bootstrapBinding.mountGeneration,
            });
          }
          assertFakeRuntimeMountGenerationCurrent({
            expectedMountGeneration: readinessMountGeneration,
            receivedMountGeneration: request.bootstrapBinding.mountGeneration as number,
          });
          const sessionBinding = await runtimeStateMutationQueue.run(async () => {
            if (admittedOwnerBinding === null) {
              throw new Error('fake_runtime_authenticated_owner_handoff_mismatch');
            }
            const binding = fakeRuntimeReadinessSessionBinding(
              admittedOwnerBinding,
              request.expectedOwnerBinding
            );
            if (canonicalJson(binding.socketIdentity) !== canonicalJson(owner.socketIdentity)) {
              throw new Error('fake_runtime_authenticated_owner_handoff_mismatch');
            }
            readinessLeasePublication.publish(binding);
            return binding;
          });
          await traceLifecycle({
            operation: 'readiness',
            stage: 'ready',
            mountGeneration: readinessMountGeneration,
            ownerGeneration: sessionBinding.ownerGeneration,
          });
          const readinessEnvelope = {
            schemaVersion: 2,
            kind: 'ready',
            capability: 'hosted-lifecycle-command',
            challenge: request.challenge,
            bootstrapDigest: request.bootstrapBinding.bootstrapDigest,
            ownerBinding: sessionBinding,
          };
          socket.write(
            `${JSON.stringify({
              ...readinessEnvelope,
              ownerProof: fakeRuntimeLifecycleProof(trustAnchor, 'readiness', readinessEnvelope),
            })}\n`
          );
          return;
        }
        if (
          request.operation === 'message_persist' ||
          request.operation === 'message_deliver' ||
          request.operation === 'task_mutate'
        ) {
          const ownerOperation = request.operation as
            | 'message_persist'
            | 'message_deliver'
            | 'task_mutate';
          await runtimeStateMutationQueue.run(async () => {
            if (
              !hasExactKeys(request, [
                'schemaVersion',
                'exchangeId',
                'operation',
                'ownerBinding',
                'authority',
                'payload',
                'ownerProof',
              ]) ||
              request.schemaVersion !== 2 ||
              typeof request.exchangeId !== 'string' ||
              !/^(?:message|task)-request_[0-9a-f]{32}$/.test(request.exchangeId) ||
              !isRecord(request.ownerBinding) ||
              owner.binding === null ||
              canonicalJson(request.ownerBinding) !== canonicalJson(owner.binding) ||
              !isRecord(request.authority) ||
              !hasExactKeys(request.authority, [
                'actorId',
                'deploymentId',
                'bootId',
                'restoreGeneration',
                'workspaceId',
                'mountBinding',
                'teamId',
                'ownerEffectFence',
              ]) ||
              request.authority.deploymentId !== DEPLOYMENT_ID ||
              request.authority.bootId !== bootId ||
              request.authority.restoreGeneration !== 0 ||
              request.authority.workspaceId !== RUNTIME_WORKSPACE_ID ||
              !isRecord(request.authority.mountBinding) ||
              !hasExactKeys(request.authority.mountBinding, [
                'mountGeneration',
                'declaredRootHash',
              ]) ||
              request.authority.mountBinding.mountGeneration !== mountGeneration ||
              request.authority.mountBinding.declaredRootHash !== sha256('/workspaces/sandbox') ||
              request.authority.teamId !== TEAM_ID ||
              typeof request.authority.actorId !== 'string' ||
              !isRecord(request.payload)
            ) {
              throw new Error('fake_runtime_message_authority_invalid');
            }
            const unsignedRequest = {
              schemaVersion: request.schemaVersion,
              exchangeId: request.exchangeId,
              operation: request.operation,
              ownerBinding: request.ownerBinding,
              authority: request.authority,
              payload: request.payload,
            };
            const expectedProof = messageProof(
              trustAnchor,
              ownerOperation,
              'request',
              unsignedRequest
            );
            if (
              typeof request.ownerProof !== 'string' ||
              !/^[0-9a-f]{64}$/.test(request.ownerProof) ||
              !timingSafeEqual(
                Buffer.from(expectedProof, 'hex'),
                Buffer.from(request.ownerProof, 'hex')
              )
            ) {
              throw new Error('fake_runtime_message_proof_invalid');
            }
            const respondMessage = (payload: Record<string, unknown>): void => {
              const envelope = {
                schemaVersion: 2,
                exchangeId: request.exchangeId,
                operation: request.operation,
                ownerBinding: request.ownerBinding,
                authority: request.authority,
                payload,
              };
              writeLine(socket, {
                ...envelope,
                ownerProof: messageProof(trustAnchor, ownerOperation, 'response', envelope),
              });
            };
            const messagePayload = request.payload;
            const revalidateMessageOwner = (): void => {
              assertOwnerBindingCurrent(request.ownerBinding as Record<string, unknown>);
              assertOwnerEffectFenceCurrent(request.authority as Record<string, unknown>);
            };
            revalidateMessageOwner();
            if (request.operation === 'task_mutate') {
              const taskMutation = await admitFakeRuntimeTaskMutation(
                messagePayload,
                undefined,
                revalidateMessageOwner
              );
              revalidateMessageOwner();
              respondMessage(taskMutation);
              return;
            }
            if (request.operation === 'message_persist') {
              if (
                !hasExactKeys(messagePayload, [
                  'schemaVersion',
                  'teamId',
                  'clientMessageId',
                  'text',
                ]) ||
                messagePayload.schemaVersion !== 1 ||
                messagePayload.teamId !== TEAM_ID ||
                typeof messagePayload.clientMessageId !== 'string' ||
                !CLIENT_MESSAGE_ID_PATTERN.test(messagePayload.clientMessageId) ||
                typeof messagePayload.text !== 'string'
              ) {
                throw new Error('fake_runtime_message_persist_invalid');
              }
              const persistence = await persistFakeRuntimeInboxMessage({
                runtimeStatePath,
                inboxPath: `/data/.claude/teams/${TEAM_NAME}/inboxes/team-lead.json`,
                actorId: String(request.authority.actorId),
                workspaceId: String(request.authority.workspaceId),
                teamId: String(request.authority.teamId),
                clientMessageId: messagePayload.clientMessageId,
                text: messagePayload.text,
                ownerProvenance: {
                  trustAnchor,
                  deploymentId: String(request.authority.deploymentId),
                  bootId: String(request.authority.bootId),
                  mountGeneration: Number(
                    (request.authority.mountBinding as Record<string, unknown>).mountGeneration
                  ),
                  ownerBinding: request.ownerBinding,
                },
                beforeCommit: revalidateMessageOwner,
              });
              revalidateMessageOwner();
              if (persistence.kind === 'conflict') {
                respondMessage({
                  schemaVersion: 2,
                  kind: 'conflict',
                  reason: 'idempotency_mismatch',
                });
                return;
              }
              const entry = persistence.entry;
              respondMessage({
                schemaVersion: 2,
                kind: persistence.kind,
                receipt: {
                  schemaVersion: 1,
                  teamId: entry.teamId,
                  messageId: fakeRuntimeProjectedMessageId({
                    teamId: entry.teamId,
                    rawMessageId: entry.messageId,
                    from: 'user',
                    to: 'team-lead',
                  }),
                  clientMessageId: entry.clientMessageId,
                  persistence: 'durable',
                },
              });
              return;
            }
            if (
              !hasExactKeys(messagePayload, ['teamId', 'messageId', 'clientMessageId', 'text']) ||
              messagePayload.teamId !== TEAM_ID ||
              typeof messagePayload.messageId !== 'string' ||
              typeof messagePayload.clientMessageId !== 'string' ||
              !CLIENT_MESSAGE_ID_PATTERN.test(messagePayload.clientMessageId) ||
              typeof messagePayload.text !== 'string'
            ) {
              throw new Error('fake_runtime_message_delivery_invalid');
            }
            const delivery = await deliverFakeRuntimeInboxMessage({
              runtimeStatePath,
              inboxPath: `/data/.claude/teams/${TEAM_NAME}/inboxes/team-lead.json`,
              actorId: String(request.authority.actorId),
              workspaceId: String(request.authority.workspaceId),
              teamId: String(messagePayload.teamId),
              messageId: messagePayload.messageId,
              clientMessageId: messagePayload.clientMessageId,
              text: messagePayload.text,
              beforeCommit: revalidateMessageOwner,
            });
            revalidateMessageOwner();
            respondMessage({ schemaVersion: 2, kind: delivery });
          });
          return;
        }
        if (
          !hasExactKeys(request, [
            'schemaVersion',
            'exchangeId',
            'operation',
            'provenance',
            'ownerBinding',
            'ownerEffectFence',
            'payload',
            'ownerProof',
          ]) ||
          request.schemaVersion !== 2 ||
          typeof request.exchangeId !== 'string' ||
          !/^lifecycle-request_[0-9a-f]{32}$/.test(request.exchangeId) ||
          ![
            'control_state',
            'prepare_provisioning',
            'get_provisioning_status',
            'authorize',
            'revalidate',
            'replay_lookup',
            'execute',
            'release',
          ].includes(String(request.operation)) ||
          !isRecord(request.ownerBinding) ||
          owner.binding === null ||
          !sameAuthorization(request.ownerBinding, owner.binding) ||
          !isRecord(request.provenance) ||
          !isRecord(request.ownerEffectFence) ||
          !isRecord(request.payload)
        ) {
          throw new Error('fake_runtime_owner_binding_invalid');
        }
        await traceLifecycle({ operation: request.operation, stage: 'envelope_valid' });
        const signedRequest = verifyFakeRuntimeLifecycleRequestFrame(body, trustAnchor);
        if (canonicalJson(signedRequest.value) !== canonicalJson(request)) {
          throw new Error('fake_runtime_owner_proof_invalid');
        }
        await traceLifecycle({ operation: request.operation, stage: 'proof_valid' });
        const operationOwnerBinding = owner.binding;
        const payload = request.payload;
        const payloadKeys =
          request.operation === 'control_state' ||
          request.operation === 'prepare_provisioning' ||
          request.operation === 'get_provisioning_status'
            ? ['request', 'context', 'authority']
            : request.operation === 'authorize'
              ? ['command', 'context', 'authority']
              : request.operation === 'execute' || request.operation === 'replay_lookup'
                ? ['command', 'authorization', 'durableCommand', 'context', 'authority']
                : ['command', 'authorization', 'context', 'authority'];
        if (!hasExactKeys(payload, payloadKeys)) throw new Error('fake_runtime_payload_invalid');
        const command = payload.command as Record<string, unknown> | undefined;
        const context = payload.context as Record<string, unknown> | undefined;
        const authority = payload.authority as Record<string, unknown> | undefined;
        if (!isRecord(context) || !isRecord(authority)) {
          throw new Error('fake_runtime_authority_missing');
        }
        if (
          !hasExactKeys(context, [
            'actorId',
            'sessionId',
            'deploymentId',
            'bootId',
            'requestId',
            'authorizedScope',
            'deadlineAtMs',
          ]) ||
          !hasExactKeys(authority, [
            'actorId',
            'workspaceId',
            'teamId',
            'deploymentId',
            'restoreGeneration',
            'bootId',
            'resourceRevision',
            'mountGeneration',
            'ownerEffectFence',
          ]) ||
          authority.actorId !== context.actorId ||
          authority.deploymentId !== context.deploymentId ||
          authority.bootId !== context.bootId ||
          context.deploymentId !== DEPLOYMENT_ID ||
          context.bootId !== bootId ||
          typeof context.actorId !== 'string' ||
          typeof context.sessionId !== 'string' ||
          typeof context.requestId !== 'string' ||
          typeof context.authorizedScope !== 'string' ||
          !Number.isSafeInteger(context.deadlineAtMs) ||
          Date.now() >= Number(context.deadlineAtMs) ||
          authority.deploymentId !== DEPLOYMENT_ID ||
          authority.workspaceId !== PUBLIC_WORKSPACE_ID ||
          authority.teamId !== TEAM_ID ||
          authority.restoreGeneration !== 0 ||
          authority.mountGeneration !== mountGeneration ||
          canonicalJson(request.ownerEffectFence) !== canonicalJson(authority.ownerEffectFence)
        ) {
          throw new Error('fake_runtime_authority_invalid');
        }
        const provenance = request.provenance;
        if (
          !hasExactKeys(provenance, ['from', 'to', 'target']) ||
          !isRecord(provenance.from) ||
          !hasExactKeys(provenance.from, [
            'kind',
            'deploymentId',
            'bootId',
            'actorId',
            'sessionId',
          ]) ||
          provenance.from.kind !== 'controller' ||
          provenance.from.deploymentId !== context.deploymentId ||
          provenance.from.bootId !== context.bootId ||
          provenance.from.actorId !== context.actorId ||
          provenance.from.sessionId !== context.sessionId ||
          !isRecord(provenance.to) ||
          !hasExactKeys(provenance.to, [
            'kind',
            'ownerAuthority',
            'ownerGeneration',
            'ownerSessionId',
          ]) ||
          provenance.to.kind !== 'owner' ||
          provenance.to.ownerAuthority !== operationOwnerBinding.ownerAuthority ||
          provenance.to.ownerGeneration !== operationOwnerBinding.ownerGeneration ||
          provenance.to.ownerSessionId !== operationOwnerBinding.ownerSessionId ||
          !isRecord(provenance.target) ||
          !hasExactKeys(provenance.target, [
            'capability',
            'exchangeId',
            'operation',
            'workspaceId',
            'teamId',
          ]) ||
          provenance.target.capability !== 'hosted-lifecycle-command' ||
          provenance.target.exchangeId !== request.exchangeId ||
          provenance.target.operation !== request.operation ||
          provenance.target.workspaceId !== authority.workspaceId ||
          provenance.target.teamId !== authority.teamId
        ) {
          throw new Error('fake_runtime_provenance_invalid');
        }
        assertOwnerEffectFenceCurrent(authority);
        await traceLifecycle({ operation: request.operation, stage: 'authority_valid' });
        const respond = (responsePayload: unknown, resourceRevision: unknown): void => {
          // Every owner result, including one emitted after an asynchronous trace write, must be
          // fenced at the final synchronous response boundary.
          assertLifecycleEffectFence(operationOwnerBinding, context, authority);
          if (socket.destroyed || body.slice(newline + 1).trim().length !== 0) {
            throw new Error('fake_runtime_extra_frame');
          }
          const envelope = {
            schemaVersion: 2,
            exchangeId: request.exchangeId,
            operation: request.operation,
            provenance: {
              from: provenance.to,
              to: provenance.from,
              target: provenance.target,
            },
            ownerBinding: operationOwnerBinding,
            ownerEffectFence: request.ownerEffectFence,
            authority: { ...authority, resourceRevision },
            payload: responsePayload,
          };
          writeFakeRuntimeLifecycleSignedFrame(socket, trustAnchor, 'response', envelope);
        };
        if (
          request.operation === 'control_state' ||
          request.operation === 'prepare_provisioning' ||
          request.operation === 'get_provisioning_status'
        ) {
          const controlRequest = payload.request;
          if (
            !isRecord(controlRequest) ||
            !hasExactKeys(controlRequest, ['schemaVersion', 'workspaceId', 'teamId']) ||
            controlRequest.schemaVersion !== 1 ||
            controlRequest.workspaceId !== authority.workspaceId ||
            controlRequest.teamId !== authority.teamId ||
            authority.resourceRevision !== null
          ) {
            throw new Error('fake_runtime_lifecycle_projection_invalid');
          }
          const runtimeState = await readRuntimeState();
          const resourceRevision = fakeRuntimeLifecycleCanonicalRevision(
            runtimeState,
            controlRequest.workspaceId,
            controlRequest.teamId
          );
          if (resourceRevision === null) {
            respond({ schemaVersion: 1, kind: 'not_found' }, null);
            return;
          }
          const activeRun = runtimeState.activeRuns.find(
            (entry) => entry.teamId === controlRequest.teamId
          );
          const projection = {
            schemaVersion: 1,
            workspaceId: controlRequest.workspaceId,
            teamId: controlRequest.teamId,
            deploymentId: context.deploymentId,
            bootId: context.bootId,
            runId: activeRun?.runId ?? null,
            resourceRevision,
            availableActions: activeRun === undefined ? ['launch'] : ['stop', 'recover'],
          };
          if (request.operation === 'prepare_provisioning') {
            respond(
              {
                ...projection,
                kind: 'prepared',
                lanes: [
                  { laneKey: 'lane_fake-runtime', backend: 'provisioning_cli', status: 'ready' },
                ],
              },
              resourceRevision
            );
            return;
          }
          if (request.operation === 'get_provisioning_status') {
            const recentCommands = parseFakeRuntimeLifecycleLedger(
              runtimeState.lifecycleCommandLedger
            )
              .filter(
                (entry) =>
                  entry.command.workspaceId === controlRequest.workspaceId &&
                  entry.command.teamId === controlRequest.teamId
              )
              .slice(-16)
              .reverse()
              .map((entry) => ({
                action: entry.command.action,
                commandId: entry.command.commandId,
                result:
                  entry.state === 'settled'
                    ? entry.result
                    : {
                        schemaVersion: 1,
                        kind: entry.state,
                        action: entry.command.action,
                        commandId: entry.command.commandId,
                        workspaceId: entry.command.workspaceId,
                        teamId: entry.command.teamId,
                      },
              }));
            respond(
              { ...projection, kind: 'provisioning_status', recentCommands },
              resourceRevision
            );
            return;
          }
          respond(
            {
              ...projection,
              kind: 'control_state',
            },
            resourceRevision
          );
          return;
        }
        const parsedCommand = parseFakeRuntimeLifecycleCommand(command);
        if (authority.resourceRevision !== parsedCommand.expectedRevision) {
          if (request.operation === 'authorize') {
            throw new Error('fake_runtime_authority_revision_invalid');
          }
        }
        if (request.operation === 'authorize') {
          const proposedDurableCommand = fakeRuntimeLifecycleDurableCommand(
            parsedCommand,
            context,
            authority
          );
          const authorizationResult = await runtimeStateMutationQueue.run(async () => {
            assertLifecycleEffectFence(operationOwnerBinding, context, authority);
            const admission = inspectFakeRuntimeLifecycleAdmission(
              await readRuntimeState(),
              parsedCommand,
              proposedDurableCommand
            );
            if (admission.kind !== 'admit') return { admission } as const;
            assertLifecycleEffectFence(operationOwnerBinding, context, authority);
            owner.authorizationGeneration += 1;
            const authorizationIdentity = fakeRuntimeAuthorizationIdentity(
              operationOwnerBinding,
              owner.authorizationGeneration
            );
            const authorization = Object.freeze({
              ...authorizationIdentity,
              deploymentId: context.deploymentId,
              bootId,
              resourceRevision: parsedCommand.expectedRevision,
              actorId: context.actorId,
              workspaceId: parsedCommand.workspaceId,
              teamId: parsedCommand.teamId,
              restoreGeneration: authority.restoreGeneration,
              mountGeneration: authority.mountGeneration,
              ownerEffectFence: authority.ownerEffectFence,
            });
            issued.set(authorizationKey(authorization), {
              authorization,
              originalAuthorization: authorization,
              ownerBinding: Object.freeze({ ...operationOwnerBinding }),
              phase: 'authorized',
              expiresAt: Math.min(Date.now() + 60_000, Number(context.deadlineAtMs)),
              drainEpoch: authDrainEpochFence.issue(),
            });
            return { admission, authorization } as const;
          });
          const { admission } = authorizationResult;
          if (admission.kind === 'stale_revision') {
            await traceLifecycle({ operation: request.operation, stage: 'stale_revision' });
            respond(
              {
                schemaVersion: 2,
                kind: 'conflict',
                reason: 'stale_revision',
                currentRevision: admission.currentRevision,
              },
              admission.currentRevision
            );
            return;
          }
          if (admission.kind === 'stale_run') {
            await traceLifecycle({ operation: request.operation, stage: 'stale_run' });
            respond(
              {
                schemaVersion: 2,
                kind: 'conflict',
                reason: 'stale_run',
                currentRevision: admission.currentRevision,
              },
              admission.currentRevision
            );
            return;
          }
          if (admission.kind === 'idempotency_mismatch') {
            await traceLifecycle({
              operation: request.operation,
              stage: 'idempotency_mismatch',
            });
            respond(
              {
                schemaVersion: 2,
                kind: 'conflict',
                reason: 'idempotency_mismatch',
                currentRevision: null,
              },
              null
            );
            return;
          }
          if (admission.kind === 'not_found') {
            await traceLifecycle({ operation: request.operation, stage: 'not_found' });
            respond({ schemaVersion: 2, kind: 'not_found' }, null);
            return;
          }
          if (admission.kind === 'operator_required') {
            await traceLifecycle({ operation: request.operation, stage: 'operator_required' });
            respond({ schemaVersion: 2, kind: 'operator_required' }, null);
            return;
          }
          const { authorization } = authorizationResult;
          await traceLifecycle({ operation: request.operation, stage: 'authorized' });
          respond(
            { schemaVersion: 2, kind: 'authorized', authorization },
            parsedCommand.expectedRevision
          );
          return;
        }
        if (request.operation === 'execute' || request.operation === 'replay_lookup') {
          const lifecycleExecutionOperation = request.operation;
          const supplied = payload.authorization;
          if (!isRecord(supplied)) throw new Error('fake_runtime_authorization_invalid');
          const durableCommand = requireFakeRuntimeLifecycleDurableCommand(
            payload.durableCommand,
            parsedCommand,
            context,
            authority
          );
          const { resolution, outcome } = await runtimeStateMutationQueue.run(async () => {
            assertLifecycleEffectFence(operationOwnerBinding, context, authority);
            const active = issued.get(authorizationKey(supplied));
            const ownerBound =
              active !== undefined &&
              authDrainEpochFence.isCurrent(active.drainEpoch) &&
              sameAuthorization(active.ownerBinding, operationOwnerBinding);
            const unexpired = active !== undefined && active.expiresAt > Date.now();
            const exactValidatedAuthorization =
              active?.phase === 'validated' && sameAuthorization(active.authorization, supplied);
            const replayableSettledAuthorization =
              lifecycleExecutionOperation === 'replay_lookup' &&
              ((active?.phase === 'executing' &&
                sameAuthorization(active.authorization, supplied)) ||
                (active?.phase === 'executed' &&
                  sameAuthorizationFence(active.authorization, supplied) &&
                  (supplied.resourceRevision === active.authorization.resourceRevision ||
                    supplied.resourceRevision === parsedCommand.expectedRevision)));
            if (
              active === undefined ||
              !authDrainEpochFence.isCurrent(active.drainEpoch) ||
              !ownerBound ||
              !unexpired ||
              (lifecycleExecutionOperation === 'execute'
                ? !exactValidatedAuthorization
                : !exactValidatedAuthorization && !replayableSettledAuthorization) ||
              authority.resourceRevision !== supplied.resourceRevision
            ) {
              throw new Error('fake_runtime_authorization_invalid');
            }
            assertLifecycleEffectFence(operationOwnerBinding, context, authority);
            if (lifecycleExecutionOperation === 'execute') active.phase = 'executing';
            const resolution =
              lifecycleExecutionOperation === 'execute'
                ? await executeFakeRuntimeLifecycleDurably(parsedCommand, durableCommand, () =>
                    assertLifecycleEffectFence(operationOwnerBinding, context, authority)
                  )
                : await resolveFakeRuntimeLifecycleLedger(parsedCommand, durableCommand);
            const outcome = fakeRuntimeLifecycleDurableOutcome(
              resolution,
              durableCommand,
              supplied,
              lifecycleExecutionOperation
            );
            if (resolution.kind === 'settled') {
              active.authorization = outcome.authorization as Record<string, unknown>;
              active.phase = 'executed';
            }
            assertLifecycleEffectFence(operationOwnerBinding, context, authority);
            return { resolution, outcome };
          });
          const responseRevision =
            resolution.kind === 'settled'
              ? fakeRuntimeLifecycleFinalRevision(durableCommand)
              : supplied.resourceRevision;
          await traceLifecycle({
            operation: request.operation,
            stage: resolution.kind,
          });
          assertLifecycleEffectFence(operationOwnerBinding, context, authority);
          respond(outcome, responseRevision);
          return;
        }
        if (request.operation === 'revalidate') {
          const supplied = payload.authorization;
          if (!isRecord(supplied) || authority.resourceRevision !== supplied.resourceRevision) {
            throw new Error('fake_runtime_authorization_invalid');
          }
          const revalidation = await runtimeStateMutationQueue.run(async () => {
            assertLifecycleEffectFence(operationOwnerBinding, context, authority);
            const active = issued.get(authorizationKey(supplied));
            if (
              active === undefined ||
              !authDrainEpochFence.isCurrent(active.drainEpoch) ||
              active.expiresAt <= Date.now() ||
              !sameAuthorization(active.ownerBinding, operationOwnerBinding) ||
              !sameAuthorization(active.authorization, supplied)
            ) {
              return Object.freeze({ kind: 'authorization_changed' as const });
            }
            assertLifecycleEffectFence(operationOwnerBinding, context, authority);
            const admission = inspectFakeRuntimeLifecycleAdmission(
              await readRuntimeState(),
              parsedCommand,
              fakeRuntimeLifecycleDurableCommand(parsedCommand, context, authority)
            );
            if (admission.kind === 'operator_required') {
              return Object.freeze({ kind: 'operator_required' as const });
            }
            if (active.phase !== 'executed') active.phase = 'validated';
            return Object.freeze({
              kind: 'valid' as const,
              authorization: active.authorization,
            });
          });
          if (revalidation.kind === 'authorization_changed') {
            await traceLifecycle({ operation: request.operation, stage: 'authorization_changed' });
            respond(
              {
                schemaVersion: 2,
                kind: 'conflict',
                reason: 'authorization_changed',
                currentRevision: null,
              },
              null
            );
            return;
          }
          if (revalidation.kind === 'operator_required') {
            await traceLifecycle({ operation: request.operation, stage: 'operator_required' });
            respond({ schemaVersion: 2, kind: 'operator_required' }, null);
            return;
          }
          await traceLifecycle({ operation: request.operation, stage: 'valid' });
          respond(
            {
              schemaVersion: 2,
              kind: 'valid',
              authorization: revalidation.authorization,
            },
            revalidation.authorization.resourceRevision
          );
          return;
        }
        if (request.operation === 'release') {
          const supplied = payload.authorization;
          if (!isRecord(supplied) || authority.resourceRevision !== supplied.resourceRevision) {
            throw new Error('fake_runtime_authorization_invalid');
          }
          const release = await runtimeStateMutationQueue.run(async () => {
            assertLifecycleEffectFence(operationOwnerBinding, context, authority);
            const key = authorizationKey(supplied);
            const state = await readRuntimeState();
            const prior = parseFakeRuntimeLifecycleReleaseLedger(state.lifecycleReleaseLedger).find(
              (entry) => entry.key === key
            );
            if (prior !== undefined) {
              return Object.freeze({
                kind:
                  sameAuthorization(prior.authorization, supplied) &&
                  sameAuthorization(prior.ownerBinding, operationOwnerBinding) &&
                  authDrainEpochFence.isCurrent(prior.drainEpoch)
                    ? ('already_released' as const)
                    : ('operator_required' as const),
                authorization: supplied,
              });
            }
            const active = issued.get(key);
            if (
              active === undefined ||
              !authDrainEpochFence.isCurrent(active.drainEpoch) ||
              !sameAuthorization(active.ownerBinding, operationOwnerBinding) ||
              !sameAuthorization(active.authorization, supplied) ||
              !sameAuthorizationFence(active.originalAuthorization, supplied)
            ) {
              return Object.freeze({
                kind: 'operator_required' as const,
                authorization: supplied,
              });
            }
            assertLifecycleEffectFence(operationOwnerBinding, context, authority);
            await writeRuntimeState(
              withFakeRuntimeLifecycleRelease(state, {
                key,
                authorization: Object.freeze({ ...supplied }),
                ownerBinding: Object.freeze({ ...operationOwnerBinding }),
                drainEpoch: active.drainEpoch,
              })
            );
            issued.delete(key);
            return Object.freeze({
              kind: 'released' as const,
              authorization: supplied,
            });
          });
          await traceLifecycle({ operation: request.operation, stage: release.kind });
          respond(
            {
              schemaVersion: 2,
              kind: release.kind,
              authorization: release.authorization,
            },
            supplied.resourceRevision
          );
          return;
        }
        respond({ schemaVersion: 2, kind: 'unavailable', retryAfterMs: null }, null);
      } catch (error) {
        if (lifecycleOperation !== null) {
          await traceLifecycle({
            operation: lifecycleOperation,
            stage: 'error',
            reason: error instanceof Error ? error.message : 'unknown',
          }).catch(() => undefined);
        }
        if (ownerMutationOperation !== null) {
          await ownerMutationErrorTrace.record(error).catch(() => undefined);
        }
        socket.destroy();
      }
    };
    socket.on('data', (chunk) => {
      if (handled) {
        socket.destroy(new Error('fake_runtime_extra_frame'));
        return;
      }
      body += chunk;
      if (Buffer.byteLength(body) > MAX_FAKE_RUNTIME_FRAME_BYTES) {
        socket.destroy(new Error('fake_runtime_frame_oversize'));
        return;
      }
      void handleFrame();
    });
    socket.once('end', () => {
      inputEnded = true;
      void handleFrame();
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, resolve);
  });
  await chmod(socketPath, 0o600);
  const socketStat = await lstat(socketPath, { bigint: true });
  owner.socketIdentity = {
    device: socketStat.dev.toString(),
    inode: socketStat.ino.toString(),
    uid: Number(socketStat.uid),
    gid: Number(socketStat.gid),
    mode: Number(socketStat.mode & 0o777n),
  };
  // Reserve and fsync the single successor generation before signing its manifest. Readiness
  // retries consume this captured binding and never burn another generation.
  const ownerGeneration = await reserveFakeRuntimeOwnerGeneration(bootId);
  const admission = fakeRuntimeLifecycleOwnerAdmissionManifest({
    artifact: releasePin.artifact,
    bootstrap,
    launcherKeyId: releasePin.launcherKeyId,
    launcherPrivateKey,
    launcherPublicKey: releasePin.launcherPublicKey,
    mountGeneration,
    ownerGeneration,
    socketIdentity: owner.socketIdentity,
    trustAnchor,
  });
  admittedOwnerBinding = admission.ownerBinding;
  const manifestHandle = await open(LIFECYCLE_OWNER_MANIFEST_PATH, 'wx', 0o400);
  try {
    await manifestHandle.writeFile(admission.serializedManifest, 'utf8');
    await manifestHandle.sync();
  } finally {
    await manifestHandle.close();
  }
  const lifecycleRunDirectory = await open(LIFECYCLE_RUN_ROOT, 'r');
  try {
    await lifecycleRunDirectory.sync();
  } finally {
    await lifecycleRunDirectory.close();
  }
  const stop = (): void => {
    for (const socket of connectedSockets) socket.destroy();
    void authDrainServer.close();
    server.close(() => process.exit(0));
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}

if (process.argv[1]?.endsWith('/seedContainer.ts')) {
  if (process.argv[2] === 'oidc-provider') await serveSyntheticOidcProvider();
  else if (process.argv[2] === 'fake-runtime') await serveFakeRuntime();
  else if (process.argv[2] === 'recover-task-wal') await recoverFakeRuntimeTaskMutationWal();
  else if (process.argv[2] === 'prove-state-mutation-overlap') {
    process.stdout.write(`${JSON.stringify(await proveFakeRuntimeStateMutationOverlap())}\n`);
  } else if (process.argv[2] === 'prove-task-idempotency-contract') {
    process.stdout.write(`${JSON.stringify(await proveFakeRuntimeTaskIdempotencyContract())}\n`);
  } else if (process.argv[2] === 'prove-update-status-placement') {
    process.stdout.write(`${JSON.stringify(await proveFakeRuntimeUpdateStatusPlacement())}\n`);
  } else if (process.argv[2] === 'prove-task-generation-reuse') {
    process.stdout.write(`${JSON.stringify(await proveFakeRuntimeTaskGenerationReuse())}\n`);
  } else if (process.argv[2] === 'prove-task-newer-writer-fence') {
    process.stdout.write(`${JSON.stringify(await proveFakeRuntimeTaskNewerWriterFence())}\n`);
  } else if (process.argv[2] === 'prove-task-ledger-postimage-fence') {
    process.stdout.write(`${JSON.stringify(await proveFakeRuntimeTaskLedgerPostimageFence())}\n`);
  } else if (process.argv[2] === 'prove-task-ledger-validation') {
    process.stdout.write(`${JSON.stringify(await proveFakeRuntimeTaskLedgerValidation())}\n`);
  } else if (process.argv[2] === 'prove-update-relationship') {
    process.stdout.write(`${JSON.stringify(await proveFakeRuntimeUpdateRelationship())}\n`);
  } else if (process.argv[2] === 'prove-lifecycle-durable-ledger') {
    process.stdout.write(`${JSON.stringify(await proveFakeRuntimeLifecycleDurability())}\n`);
  } else if (process.argv[2] === 'prove-lifecycle-pre-effect-fence') {
    process.stdout.write(`${JSON.stringify(await proveFakeRuntimeLifecyclePreEffectFence())}\n`);
  } else if (process.argv[2] === 'reserve-owner-generation') {
    const bootId = process.env.E2E_BOOT_ID;
    if (!bootId) throw new Error('hosted_e2e_fake_runtime_boot_id_missing');
    process.stdout.write(`${JSON.stringify(await reserveFakeRuntimeOwnerGeneration(bootId))}\n`);
  } else await seedSandbox();
}
