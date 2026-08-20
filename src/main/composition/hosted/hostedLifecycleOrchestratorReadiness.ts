import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { isAbsolute, normalize, resolve } from 'node:path';

// eslint-disable-next-line no-restricted-imports -- Bounded server-only hosted lifecycle wire parser.
import { parseStrictOrchestratorSignedJsonFrame } from '@features/team-lifecycle/main/hosted';

import {
  advanceHostedLifecycleOwnerHighWater,
  HostedLifecycleOwnerBindingConsumedError,
  type HostedLifecycleOwnerHighWaterTestHooks,
} from './hostedLifecycleOwnerHighWater';
import { HOSTED_LIFECYCLE_OWNER_GENERATION_LIMIT } from './hostedLifecycleOwnerHighWaterBinding';

const HANDSHAKE_SCHEMA_VERSION = 2;
const HANDSHAKE_CAPABILITY = 'hosted-lifecycle-command';
const MAXIMUM_HANDSHAKE_BYTES = 4_096;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_BACKOFF_MS = Object.freeze([100, 250, 500, 1_000, 2_000, 5_000]);
const CHALLENGE_PATTERN = /^[0-9a-f]{64}$/;
const OWNER_AUTHORITY_PATTERN = /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const OWNER_SESSION_PATTERN = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const OWNER_PROOF_KEY_PATTERN = /^[0-9a-f]{64}$/;
const OWNER_PROOF_DOMAIN = 'agent-teams.hosted-lifecycle.owner-proof/v1';

/**
 * A consumed or replayed classification means this exact authenticated binding
 * can never complete an admission again (its markers are durably committed),
 * so retrying it only livelocks; the launcher must issue a fresh binding.
 */
function isSpentOwnerBindingError(error: unknown): boolean {
  return (
    error instanceof HostedLifecycleOwnerBindingConsumedError ||
    (error instanceof Error && error.message === 'hosted-lifecycle-orchestrator-session-replayed')
  );
}

export type OrchestratorLifecycleOwnerProofKey = string & {
  readonly __brand: 'OrchestratorLifecycleOwnerProofKey';
};

export interface OrchestratorSocketIdentity {
  readonly device: string;
  readonly inode: string;
  readonly uid: number;
  readonly gid: number;
  readonly mode: number;
}

export interface OrchestratorLifecycleOwnerBinding {
  readonly ownerAuthority: string;
  readonly ownerGeneration: number;
  readonly ownerSessionId: string;
  readonly socketIdentity: OrchestratorSocketIdentity;
}

export interface OrchestratorLifecycleBootstrapBinding {
  readonly deploymentId: string;
  readonly bootId: string;
  readonly workspaceId: string;
  readonly mountGeneration: number;
  readonly bootstrapDigest: string;
  readonly ownerArtifactDigest: string;
  readonly proofKeyId: string;
}

function isRecord(value: unknown): value is Record<PropertyKey, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<PropertyKey, unknown>, keys: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === keys.length &&
    actual.every((key) => typeof key === 'string' && keys.includes(key)) &&
    keys.every((key) => Object.hasOwn(value, key))
  );
}

function parseSocketIdentity(value: unknown): OrchestratorSocketIdentity {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, ['device', 'inode', 'uid', 'gid', 'mode']) ||
    typeof value.device !== 'string' ||
    !/^\d{1,32}$/.test(value.device) ||
    typeof value.inode !== 'string' ||
    !/^\d{1,32}$/.test(value.inode) ||
    !Number.isSafeInteger(value.uid) ||
    (value.uid as number) < 0 ||
    !Number.isSafeInteger(value.gid) ||
    (value.gid as number) < 0 ||
    !Number.isSafeInteger(value.mode) ||
    (value.mode as number) < 0 ||
    (value.mode as number) > 0o777
  ) {
    throw new TypeError('orchestrator-lifecycle-socket-identity-invalid');
  }
  return Object.freeze({
    device: value.device,
    inode: value.inode,
    uid: value.uid as number,
    gid: value.gid as number,
    mode: value.mode as number,
  });
}

export function parseOrchestratorLifecycleOwnerBinding(
  value: unknown
): OrchestratorLifecycleOwnerBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'ownerAuthority',
      'ownerGeneration',
      'ownerSessionId',
      'socketIdentity',
    ]) ||
    typeof value.ownerAuthority !== 'string' ||
    !OWNER_AUTHORITY_PATTERN.test(value.ownerAuthority) ||
    !Number.isSafeInteger(value.ownerGeneration) ||
    (value.ownerGeneration as number) < 1 ||
    (value.ownerGeneration as number) >= HOSTED_LIFECYCLE_OWNER_GENERATION_LIMIT ||
    typeof value.ownerSessionId !== 'string' ||
    !OWNER_SESSION_PATTERN.test(value.ownerSessionId)
  ) {
    throw new TypeError('orchestrator-lifecycle-owner-binding-invalid');
  }
  return Object.freeze({
    ownerAuthority: value.ownerAuthority,
    ownerGeneration: value.ownerGeneration as number,
    ownerSessionId: value.ownerSessionId,
    socketIdentity: parseSocketIdentity(value.socketIdentity),
  });
}

export function parseOrchestratorLifecycleOwnerProofKey(
  value: unknown
): OrchestratorLifecycleOwnerProofKey {
  if (typeof value !== 'string' || !OWNER_PROOF_KEY_PATTERN.test(value)) {
    throw new TypeError('orchestrator-lifecycle-owner-proof-key-invalid');
  }
  return value as OrchestratorLifecycleOwnerProofKey;
}

export async function inspectOrchestratorLifecycleSocketIdentity(
  path: string
): Promise<OrchestratorSocketIdentity> {
  const stat = await lstat(path, { bigint: true });
  if (!stat.isSocket() || stat.isSymbolicLink()) {
    throw new Error('orchestrator-lifecycle-socket-identity-invalid');
  }
  return Object.freeze({
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: Number(stat.mode & 0o777n),
  });
}

function createOrchestratorLifecycleReadinessProof(
  key: OrchestratorLifecycleOwnerProofKey,
  envelope: Readonly<Record<string, unknown>> | string
): string {
  const serializedEnvelope = typeof envelope === 'string' ? envelope : JSON.stringify(envelope);
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(`${OWNER_PROOF_DOMAIN}\u0000readiness\u0000${serializedEnvelope}`)
    .digest('hex');
}

export function createOrchestratorLifecycleReadinessRequestProof(
  key: OrchestratorLifecycleOwnerProofKey,
  envelope: Readonly<Record<string, unknown>> | string
): string {
  const serializedEnvelope = typeof envelope === 'string' ? envelope : JSON.stringify(envelope);
  return createHmac('sha256', Buffer.from(key, 'hex'))
    .update(`${OWNER_PROOF_DOMAIN}\u0000readiness-request\u0000${serializedEnvelope}`)
    .digest('hex');
}

function ownerProofMatches(expected: string, actual: unknown): boolean {
  return (
    typeof actual === 'string' &&
    /^[0-9a-f]{64}$/.test(actual) &&
    timingSafeEqual(Buffer.from(expected, 'hex'), Buffer.from(actual, 'hex'))
  );
}

export function sameOrchestratorLifecycleOwnerBinding(
  left: OrchestratorLifecycleOwnerBinding,
  right: OrchestratorLifecycleOwnerBinding
): boolean {
  return (
    left.ownerAuthority === right.ownerAuthority &&
    left.ownerGeneration === right.ownerGeneration &&
    left.ownerSessionId === right.ownerSessionId &&
    left.socketIdentity.device === right.socketIdentity.device &&
    left.socketIdentity.inode === right.socketIdentity.inode &&
    left.socketIdentity.uid === right.socketIdentity.uid &&
    left.socketIdentity.gid === right.socketIdentity.gid &&
    left.socketIdentity.mode === right.socketIdentity.mode
  );
}

export function sameOrchestratorSocketIdentity(
  left: OrchestratorSocketIdentity,
  right: OrchestratorSocketIdentity
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.uid === right.uid &&
    left.gid === right.gid &&
    left.mode === right.mode
  );
}

export interface HostedLifecycleOrchestratorReadinessOptions {
  readonly socketPath: string;
  readonly expectedUid: number;
  readonly expectedGid: number;
  readonly expectedMode: number;
  readonly handshakeTimeoutMs?: number;
  readonly retryBackoffMs?: readonly number[];
  /** Durable, non-backup state outside the hosted restore root. */
  readonly ownerHighWaterPath: string;
  /** Test seam only; production uses the fsync-backed high-water store. */
  readonly advanceOwnerHighWater?: (binding: OrchestratorLifecycleOwnerBinding) => Promise<void>;
  /** Deterministic adversarial test seam for the production descriptor-backed store. */
  readonly ownerHighWaterTestHooks?: HostedLifecycleOwnerHighWaterTestHooks;
  readonly onOwnerLoss: () => void;
  /** Preconfigured out-of-band; the readiness peer never chooses or transmits this anchor. */
  readonly trustAnchor: OrchestratorLifecycleOwnerProofKey;
  /** Exact authenticated launcher handoff. The peer may not allocate or substitute this binding. */
  readonly expectedOwnerBinding: OrchestratorLifecycleOwnerBinding;
  readonly bootstrapBinding: OrchestratorLifecycleBootstrapBinding;
  readonly onOwnerAcquired?: (binding: OrchestratorLifecycleOwnerBinding) => void;
  /** Test seam only; production verifies uid/gid/mode and descriptor identity with lstat. */
  readonly inspectSocketIdentity?: (path: string) => Promise<OrchestratorSocketIdentity>;
  /** Test seam only; production connects to the configured Unix socket. */
  readonly connect?: (options: { readonly path: string }) => Socket;
  readonly generateChallenge?: () => string;
}

interface ValidatedReadinessOptions {
  readonly socketPath: string;
  readonly expectedUid: number;
  readonly expectedGid: number;
  readonly expectedMode: number;
  readonly handshakeTimeoutMs: number;
  readonly retryBackoffMs: readonly number[];
  readonly ownerHighWaterPath: string;
  readonly ownerHighWaterTestHooks?: HostedLifecycleOrchestratorReadinessOptions['ownerHighWaterTestHooks'];
  readonly advanceOwnerHighWater: (binding: OrchestratorLifecycleOwnerBinding) => Promise<void>;
  readonly onOwnerLoss: () => void;
  readonly trustAnchor: OrchestratorLifecycleOwnerProofKey;
  readonly expectedOwnerBinding: OrchestratorLifecycleOwnerBinding;
  readonly bootstrapBinding: OrchestratorLifecycleBootstrapBinding;
  readonly onOwnerAcquired?: (binding: OrchestratorLifecycleOwnerBinding) => void;
  readonly inspectSocketIdentity: (path: string) => Promise<OrchestratorSocketIdentity>;
  readonly connect: (options: { readonly path: string }) => Socket;
  readonly generateChallenge: () => string;
}

function validateIdentityPart(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new TypeError(`hosted-lifecycle-orchestrator-${name}-invalid`);
  }
  return value;
}

function validateMode(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > 0o777) {
    throw new TypeError('hosted-lifecycle-orchestrator-mode-invalid');
  }
  return value;
}

function validateSocketPath(value: string): string {
  if (
    value.length === 0 ||
    value.includes('\0') ||
    !isAbsolute(value) ||
    normalize(value) !== value ||
    Buffer.byteLength(value) > 103
  ) {
    throw new TypeError('hosted-lifecycle-orchestrator-socket-path-invalid');
  }
  return value;
}

function validateBound(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new TypeError(`hosted-lifecycle-orchestrator-${name}-invalid`);
  }
  return value;
}

function validateOptions(
  options: HostedLifecycleOrchestratorReadinessOptions
): ValidatedReadinessOptions {
  const retryBackoffMs = options.retryBackoffMs ?? DEFAULT_RETRY_BACKOFF_MS;
  if (retryBackoffMs.length < 1 || retryBackoffMs.length > 16) {
    throw new TypeError('hosted-lifecycle-orchestrator-retry-backoff-invalid');
  }
  const expectedOwnerBinding = parseOrchestratorLifecycleOwnerBinding(options.expectedOwnerBinding);
  const bootstrapBinding = parseBootstrapBinding(options.bootstrapBinding, options.trustAnchor);
  const expectedUid = validateIdentityPart(options.expectedUid, 'uid');
  const expectedGid = validateIdentityPart(options.expectedGid, 'gid');
  const expectedMode = validateMode(options.expectedMode);
  if (
    expectedOwnerBinding.socketIdentity.device.length === 0 ||
    expectedOwnerBinding.socketIdentity.inode.length === 0 ||
    expectedOwnerBinding.socketIdentity.uid !== expectedUid ||
    expectedOwnerBinding.socketIdentity.gid !== expectedGid ||
    expectedOwnerBinding.socketIdentity.mode !== expectedMode
  ) {
    throw new TypeError('hosted-lifecycle-orchestrator-bootstrap-owner-invalid');
  }
  const validated = {
    socketPath: validateSocketPath(options.socketPath),
    expectedUid,
    expectedGid,
    expectedMode,
    handshakeTimeoutMs: validateBound(
      options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
      'handshake-timeout'
    ),
    retryBackoffMs: Object.freeze(
      retryBackoffMs.map((delay) => validateBound(delay, 'retry-backoff'))
    ),
    ownerHighWaterPath: validateHighWaterPath(options.ownerHighWaterPath),
    ...(options.ownerHighWaterTestHooks === undefined
      ? {}
      : { ownerHighWaterTestHooks: options.ownerHighWaterTestHooks }),
    onOwnerLoss: options.onOwnerLoss,
    trustAnchor: options.trustAnchor,
    expectedOwnerBinding,
    bootstrapBinding,
    inspectSocketIdentity:
      options.inspectSocketIdentity ??
      ((socketPath: string) => inspectTrustedSocket(socketPath, options)),
    connect: options.connect ?? createConnection,
    generateChallenge: options.generateChallenge ?? (() => randomBytes(32).toString('hex')),
    ...(options.onOwnerAcquired === undefined ? {} : { onOwnerAcquired: options.onOwnerAcquired }),
  } satisfies Omit<ValidatedReadinessOptions, 'advanceOwnerHighWater'>;
  return Object.freeze({
    ...validated,
    advanceOwnerHighWater:
      options.advanceOwnerHighWater ??
      ((binding: OrchestratorLifecycleOwnerBinding) =>
        advanceHostedLifecycleOwnerHighWater(
          {
            rootPath: validated.ownerHighWaterPath,
            expectedUid: validated.expectedUid,
            expectedGid: validated.expectedGid,
            ...(validated.ownerHighWaterTestHooks === undefined
              ? {}
              : { testHooks: validated.ownerHighWaterTestHooks }),
          },
          binding
        )),
  });
}

function parseBootstrapBinding(
  value: OrchestratorLifecycleBootstrapBinding,
  trustAnchor: OrchestratorLifecycleOwnerProofKey
): OrchestratorLifecycleBootstrapBinding {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'deploymentId',
      'bootId',
      'workspaceId',
      'mountGeneration',
      'bootstrapDigest',
      'ownerArtifactDigest',
      'proofKeyId',
    ]) ||
    typeof value.deploymentId !== 'string' ||
    typeof value.bootId !== 'string' ||
    typeof value.workspaceId !== 'string' ||
    !Number.isSafeInteger(value.mountGeneration) ||
    value.mountGeneration < 1 ||
    typeof value.bootstrapDigest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(value.bootstrapDigest) ||
    typeof value.ownerArtifactDigest !== 'string' ||
    !/^sha256:[0-9a-f]{64}$/u.test(value.ownerArtifactDigest) ||
    value.proofKeyId !== createHash('sha256').update(Buffer.from(trustAnchor, 'hex')).digest('hex')
  ) {
    throw new TypeError('hosted-lifecycle-orchestrator-bootstrap-binding-invalid');
  }
  return Object.freeze({ ...value }) as OrchestratorLifecycleBootstrapBinding;
}

function validateHighWaterPath(value: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\0') ||
    !isAbsolute(value) ||
    normalize(value) !== value
  ) {
    throw new TypeError('hosted-lifecycle-orchestrator-high-water-path-invalid');
  }
  return resolve(value);
}

async function inspectTrustedSocket(
  socketPath: string,
  options: Pick<ValidatedReadinessOptions, 'expectedUid' | 'expectedGid' | 'expectedMode'>
): Promise<OrchestratorSocketIdentity> {
  const stat = await lstat(socketPath, { bigint: true });
  if (
    !stat.isSocket() ||
    stat.isSymbolicLink() ||
    stat.uid !== BigInt(options.expectedUid) ||
    stat.gid !== BigInt(options.expectedGid) ||
    Number(stat.mode & 0o777n) !== options.expectedMode
  ) {
    throw new Error('hosted-lifecycle-orchestrator-socket-identity-invalid');
  }
  return Object.freeze({
    device: stat.dev.toString(),
    inode: stat.ino.toString(),
    uid: Number(stat.uid),
    gid: Number(stat.gid),
    mode: Number(stat.mode & 0o777n),
  });
}

function parseReadyResponse(
  value: unknown,
  serializedUnsignedEnvelope: string,
  socketIdentity: OrchestratorSocketIdentity,
  challenge: string,
  trustAnchor: OrchestratorLifecycleOwnerProofKey,
  bootstrapDigest: string
): OrchestratorLifecycleOwnerBinding {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError();
  }
  const response = value as Record<PropertyKey, unknown>;
  const keys = Reflect.ownKeys(response);
  if (
    keys.length !== 7 ||
    ![
      'schemaVersion',
      'kind',
      'capability',
      'challenge',
      'bootstrapDigest',
      'ownerBinding',
      'ownerProof',
    ].every((key) => Object.hasOwn(response, key)) ||
    response.schemaVersion !== HANDSHAKE_SCHEMA_VERSION ||
    response.kind !== 'ready' ||
    response.capability !== HANDSHAKE_CAPABILITY ||
    response.challenge !== challenge ||
    response.bootstrapDigest !== bootstrapDigest
  ) {
    throw new TypeError();
  }
  const binding = parseOrchestratorLifecycleOwnerBinding(response.ownerBinding);
  if (!sameOrchestratorSocketIdentity(binding.socketIdentity, socketIdentity)) {
    throw new TypeError();
  }
  if (
    !ownerProofMatches(
      createOrchestratorLifecycleReadinessProof(trustAnchor, serializedUnsignedEnvelope),
      response.ownerProof
    )
  ) {
    throw new TypeError();
  }
  return binding;
}

async function connectOnce(options: ValidatedReadinessOptions): Promise<
  Readonly<{
    socket: Socket;
    binding: OrchestratorLifecycleOwnerBinding;
    activate: (onLoss: () => void) => boolean;
    dispose: () => void;
  }>
> {
  const socketIdentity = await options.inspectSocketIdentity(options.socketPath);
  if (
    !sameOrchestratorSocketIdentity(socketIdentity, options.expectedOwnerBinding.socketIdentity)
  ) {
    throw new Error('hosted-lifecycle-orchestrator-bootstrap-socket-changed');
  }
  const challenge = options.generateChallenge();
  if (!CHALLENGE_PATTERN.test(challenge)) {
    throw new Error('hosted-lifecycle-orchestrator-challenge-invalid');
  }
  const socket = options.connect({ path: options.socketPath });
  let invalidated = false;
  let handshakeAccepted = false;
  let onLeaseLoss: (() => void) | null = null;
  let removeTransportListeners = (): void => undefined;
  try {
    const lease = await new Promise<ReturnType<typeof parseReadyResponse>>((resolve, reject) => {
      let response = '';
      let responseBytes = 0;
      let settled = false;
      const deadline = setTimeout(
        () => finish(new Error('hosted-lifecycle-orchestrator-handshake-timeout')),
        options.handshakeTimeoutMs
      );
      const finish = (error?: Error, value?: ReturnType<typeof parseReadyResponse>): void => {
        if (settled) return;
        settled = true;
        clearTimeout(deadline);
        if (error === undefined) {
          handshakeAccepted = true;
          resolve(value!);
        } else {
          removeTransportListeners();
          reject(error);
        }
      };
      const invalidateTransport = (handshakeError: string): void => {
        if (!handshakeAccepted) {
          finish(new Error(handshakeError));
          return;
        }
        if (invalidated) return;
        invalidated = true;
        const notify = onLeaseLoss;
        removeTransportListeners();
        socket.destroy();
        notify?.();
      };
      const onError = (): void =>
        invalidateTransport('hosted-lifecycle-orchestrator-handshake-unavailable');
      const onClose = (): void =>
        invalidateTransport('hosted-lifecycle-orchestrator-handshake-incomplete');
      const onEnd = (): void =>
        invalidateTransport('hosted-lifecycle-orchestrator-handshake-incomplete');
      const onData = (chunk: Buffer): void => {
        if (handshakeAccepted) {
          invalidateTransport('hosted-lifecycle-orchestrator-handshake-invalid');
          return;
        }
        responseBytes += chunk.byteLength;
        if (responseBytes > MAXIMUM_HANDSHAKE_BYTES) {
          finish(new Error('hosted-lifecycle-orchestrator-handshake-invalid'));
          return;
        }
        response += chunk.toString('utf8');
        const newline = response.indexOf('\n');
        if (newline < 0) return;
        try {
          if (newline !== response.length - 1) throw new TypeError();
          const signedFrame = parseStrictOrchestratorSignedJsonFrame(response);
          finish(
            undefined,
            parseReadyResponse(
              signedFrame.value,
              signedFrame.serializedUnsignedEnvelope,
              socketIdentity,
              challenge,
              options.trustAnchor,
              options.bootstrapBinding.bootstrapDigest
            )
          );
        } catch {
          finish(new Error('hosted-lifecycle-orchestrator-handshake-invalid'));
        }
      };
      socket.once('error', onError);
      socket.once('close', onClose);
      socket.once('end', onEnd);
      socket.on('data', onData);
      removeTransportListeners = () => {
        socket.removeListener('error', onError);
        socket.removeListener('close', onClose);
        socket.removeListener('end', onEnd);
        socket.removeListener('data', onData);
      };
      socket.once('connect', () => {
        const requestEnvelope = Object.freeze({
          schemaVersion: HANDSHAKE_SCHEMA_VERSION,
          operation: 'readiness',
          capability: HANDSHAKE_CAPABILITY,
          socketIdentity,
          challenge,
          bootstrapBinding: options.bootstrapBinding,
          expectedOwnerBinding: options.expectedOwnerBinding,
        });
        socket.write(
          `${JSON.stringify({
            ...requestEnvelope,
            controllerProof: createOrchestratorLifecycleReadinessRequestProof(
              options.trustAnchor,
              requestEnvelope
            ),
          })}\n`
        );
      });
    });
    const currentIdentity = await options.inspectSocketIdentity(options.socketPath);
    if (!sameOrchestratorSocketIdentity(currentIdentity, lease.socketIdentity)) {
      throw new Error('hosted-lifecycle-orchestrator-socket-identity-changed');
    }
    if (!sameOrchestratorLifecycleOwnerBinding(lease, options.expectedOwnerBinding)) {
      throw new Error('hosted-lifecycle-orchestrator-bootstrap-owner-changed');
    }
    if (invalidated || socket.destroyed) {
      throw new Error('hosted-lifecycle-orchestrator-handshake-unavailable');
    }
    return Object.freeze({
      socket,
      binding: lease,
      activate(onLoss: () => void): boolean {
        if (invalidated || socket.destroyed) return false;
        onLeaseLoss = onLoss;
        if (invalidated || socket.destroyed) {
          onLeaseLoss = null;
          return false;
        }
        return true;
      },
      dispose(): void {
        onLeaseLoss = null;
        removeTransportListeners();
      },
    });
  } catch (error) {
    invalidated = true;
    removeTransportListeners();
    socket.destroy();
    throw error;
  }
}

/** Admission lease for the single external owner; it never serves or supervises a process. */
export class HostedLifecycleOrchestratorReadiness {
  private socket: Socket | null = null;
  private binding: OrchestratorLifecycleOwnerBinding | null = null;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private retryAttempt = 0;
  private closed = false;
  private admissionConsumed = false;

  private constructor(private readonly options: ValidatedReadinessOptions) {}

  static async connect(
    options: HostedLifecycleOrchestratorReadinessOptions,
    onCreated?: (readiness: HostedLifecycleOrchestratorReadiness) => void
  ): Promise<HostedLifecycleOrchestratorReadiness> {
    const readiness = new HostedLifecycleOrchestratorReadiness(validateOptions(options));
    try {
      onCreated?.(readiness);
    } catch (error) {
      readiness.close();
      throw error;
    }
    try {
      await readiness.acquire();
    } catch (error) {
      if (readiness.admissionConsumed || isSpentOwnerBindingError(error)) {
        readiness.close();
        throw error;
      }
      readiness.scheduleRetry();
    }
    return readiness;
  }

  isReady(): boolean {
    return !this.closed && this.binding !== null && this.socket?.destroyed === false;
  }

  currentBinding(): OrchestratorLifecycleOwnerBinding | null {
    return this.isReady() ? this.binding : null;
  }

  invalidate(): void {
    this.loseOwner();
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.binding = null;
    if (this.retryTimer !== null) clearTimeout(this.retryTimer);
    this.retryTimer = null;
    this.socket?.destroy();
    this.socket = null;
  }

  private async acquire(): Promise<void> {
    if (this.admissionConsumed) {
      throw new Error('hosted-lifecycle-orchestrator-fresh-bootstrap-required');
    }
    const acquired = await connectOnce(this.options);
    if (this.closed) {
      acquired.dispose();
      acquired.socket.destroy();
      return;
    }
    try {
      await this.options.advanceOwnerHighWater(acquired.binding);
    } catch (error) {
      acquired.dispose();
      acquired.socket.destroy();
      throw error;
    }
    // Cleanup can run while the durable high-water write is awaiting fsync. The transport is not
    // published on `this` until that write completes, so close() cannot see it; recheck here and
    // dispose the locally held lease before any binding can escape a closed readiness instance.
    if (this.closed) {
      acquired.dispose();
      acquired.socket.destroy();
      return;
    }
    this.socket = acquired.socket;
    this.binding = acquired.binding;
    this.admissionConsumed = true;
    this.retryAttempt = 0;
    if (!acquired.activate(() => this.loseOwner())) {
      acquired.dispose();
      this.loseOwner();
      throw new Error('hosted-lifecycle-orchestrator-handshake-unavailable');
    }
    this.options.onOwnerAcquired?.(acquired.binding);
  }

  private loseOwner(): void {
    if (this.closed || this.binding === null) return;
    this.closed = true;
    this.binding = null;
    this.socket?.destroy();
    this.socket = null;
    this.options.onOwnerLoss();
    // A live owner loss consumes the process-local authenticated handoff. Reacquisition requires a
    // complete controller restart with a fresh launcher transaction and durable successor binding.
  }

  private scheduleRetry(): void {
    if (this.closed || this.admissionConsumed || this.retryTimer !== null) return;
    const index = Math.min(this.retryAttempt, this.options.retryBackoffMs.length - 1);
    const delay = this.options.retryBackoffMs[index];
    this.retryAttempt += 1;
    this.retryTimer = setTimeout(() => {
      this.retryTimer = null;
      void this.acquire().catch((error: unknown) => {
        if (isSpentOwnerBindingError(error)) {
          this.failStop();
          return;
        }
        this.scheduleRetry();
      });
    }, delay);
    this.retryTimer.unref?.();
  }

  private failStop(): void {
    if (this.closed) return;
    this.close();
    this.options.onOwnerLoss();
  }
}
