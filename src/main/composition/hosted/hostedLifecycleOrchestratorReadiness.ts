import { createHash, randomBytes } from 'node:crypto';
import { lstat } from 'node:fs/promises';
import { createConnection, type Socket } from 'node:net';
import { isAbsolute, normalize, resolve } from 'node:path';

// eslint-disable-next-line no-restricted-imports -- Bounded server-only hosted lifecycle wire parser.
import { parseStrictOrchestratorSignedJsonFrame } from '@features/team-lifecycle/main/hosted';
import { createLogger } from '@shared/utils/logger';

import {
  createOrchestratorLifecycleReadinessProof,
  createOrchestratorLifecycleReadinessRequestProof,
  hasExactKeys,
  isRecord,
  ownerProofMatches,
  parseOrchestratorLifecycleOwnerBinding,
  sameOrchestratorLifecycleOwnerBinding,
  sameOrchestratorSocketIdentity,
  type HostedLifecycleReadinessDiagnostic,
  type HostedLifecycleReadinessFailure,
  type OrchestratorLifecycleBootstrapBinding,
  type OrchestratorLifecycleOwnerBinding,
  type OrchestratorLifecycleOwnerProofKey,
  type OrchestratorSocketIdentity,
} from './hostedLifecycleOrchestratorReadinessTypes';
import {
  advanceHostedLifecycleOwnerHighWater,
  HostedLifecycleOwnerBindingConsumedError,
  type HostedLifecycleOwnerHighWaterTestHooks,
} from './hostedLifecycleOwnerHighWater';
export {
  createOrchestratorLifecycleReadinessRequestProof,
  parseOrchestratorLifecycleOwnerBinding,
  parseOrchestratorLifecycleOwnerProofKey,
  sameOrchestratorLifecycleOwnerBinding,
  sameOrchestratorSocketIdentity,
  type HostedLifecycleReadinessDiagnostic,
  type HostedLifecycleReadinessFailure,
  type OrchestratorLifecycleBootstrapBinding,
  type OrchestratorLifecycleOwnerBinding,
  type OrchestratorLifecycleOwnerProofKey,
  type OrchestratorSocketIdentity,
} from './hostedLifecycleOrchestratorReadinessTypes';
const HANDSHAKE_SCHEMA_VERSION = 2;
const HANDSHAKE_CAPABILITY = 'hosted-lifecycle-command';
const MAXIMUM_HANDSHAKE_BYTES = 4_096;
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 2_000;
const DEFAULT_RETRY_BACKOFF_MS = Object.freeze([100, 250, 500, 1_000, 2_000, 5_000]);
const CHALLENGE_PATTERN = /^[0-9a-f]{64}$/;
const readinessLogger = createLogger('HostedLifecycleReadiness');
function createDiagnosticObserver(observer?: (value: HostedLifecycleReadinessDiagnostic) => void) {
  const seen = new Set<string>();
  return (value: HostedLifecycleReadinessDiagnostic): void => {
    if (observer === undefined && process.env.VITEST) return;
    const key = `${value.stage}:${value.outcome}:${value.failure ?? 'none'}`;
    if (seen.has(key)) return;
    seen.add(key);
    try {
      (
        observer ??
        ((entry) =>
          readinessLogger.error(
            `Hosted readiness diagnostic stage=${entry.stage} outcome=${entry.outcome} code=${entry.failure ?? 'none'}`
          ))
      )(value);
    } catch {
      return;
    }
  };
}
function classifyAcquisitionFailure(error: unknown): HostedLifecycleReadinessFailure {
  const code = isRecord(error) ? error.code : undefined;
  if (code === 'ENOENT') return 'socket_not_found';
  if (code === 'EACCES' || code === 'EPERM') return 'socket_access_denied';
  if (code === 'ECONNREFUSED') return 'connection_refused';
  const message = error instanceof Error ? error.message : '';
  return message.endsWith('handshake-timeout') ? 'handshake_timeout' : 'acquisition_rejected';
}
function isSpentOwnerBindingError(error: unknown): boolean {
  return (
    error instanceof HostedLifecycleOwnerBindingConsumedError ||
    (error instanceof Error && error.message === 'hosted-lifecycle-orchestrator-session-replayed')
  );
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
  readonly inspectSocketIdentity?: (path: string) => Promise<OrchestratorSocketIdentity>;
  readonly connect?: (options: { readonly path: string }) => Socket;
  readonly generateChallenge?: () => string;
  readonly diagnosticObserver?: (diagnostic: HostedLifecycleReadinessDiagnostic) => void;
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
  readonly diagnosticObserver: (diagnostic: HostedLifecycleReadinessDiagnostic) => void;
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
    diagnosticObserver: createDiagnosticObserver(options.diagnosticObserver),
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
  options.diagnosticObserver({ stage: 'socket_inspection', outcome: 'started' });
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
  options.diagnosticObserver({ stage: 'signed_handshake', outcome: 'started' });
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
      const onError = (error: Error): void => {
        if (!handshakeAccepted) {
          finish(error);
          return;
        }
        invalidateTransport('hosted-lifecycle-orchestrator-handshake-unavailable');
      };
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
    options.diagnosticObserver({ stage: 'signed_handshake', outcome: 'succeeded' });
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
    let acquired: Awaited<ReturnType<typeof connectOnce>>;
    try {
      acquired = await connectOnce(this.options);
    } catch (error) {
      this.options.diagnosticObserver({
        stage: 'owner_acquisition',
        outcome: 'failed',
        failure: classifyAcquisitionFailure(error),
      });
      throw error;
    }
    if (this.closed) {
      acquired.dispose();
      acquired.socket.destroy();
      return;
    }
    try {
      this.options.diagnosticObserver({ stage: 'high_water_admission', outcome: 'started' });
      await this.options.advanceOwnerHighWater(acquired.binding);
      this.options.diagnosticObserver({ stage: 'high_water_admission', outcome: 'succeeded' });
    } catch (error) {
      this.options.diagnosticObserver({
        stage: 'high_water_admission',
        outcome: 'failed',
        failure: 'high_water_rejected',
      });
      acquired.dispose();
      acquired.socket.destroy();
      throw error;
    }
    // Recheck after the durable write because close() cannot see this unpublished transport.
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
    this.options.diagnosticObserver({ stage: 'owner_acquisition', outcome: 'succeeded' });
    this.options.onOwnerAcquired?.(acquired.binding);
  }
  private loseOwner(): void {
    if (this.closed || this.binding === null) return;
    this.closed = true;
    this.binding = null;
    this.socket?.destroy();
    this.socket = null;
    this.options.diagnosticObserver({
      stage: 'owner_loss',
      outcome: 'failed',
      failure: 'owner_connection_lost',
    });
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
