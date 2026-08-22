import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { createConnection, type Socket } from 'node:net';

import { parseRuntimePermissionApprovalIngressAuthority } from '@features/team-runtime-control/contracts';
import {
  inspectOrchestratorLifecycleSocketIdentity,
  type OrchestratorLifecycleOwnerBinding,
  type OrchestratorLifecycleOwnerProofKey,
  type OrchestratorSocketIdentity,
  sameOrchestratorLifecycleOwnerBinding,
  sameOrchestratorSocketIdentity,
} from '@main/composition/hosted/hostedLifecycleOrchestratorReadiness';

export const HOSTED_APPROVAL_ACTIVATION_PURPOSE =
  'agent-teams.hosted-approval-activation/v1' as const;
export const HOSTED_APPROVAL_ACTIVATION_CAPABILITY =
  'agent-teams.hosted-approval-activation-v1' as const;
export const HOSTED_APPROVAL_ACTIVATION_PROOF_DOMAIN =
  'agent-teams.hosted-approval-activation-proof/v1' as const;
export const HOSTED_APPROVAL_ACTIVATION_MANIFEST_FORMAT =
  'agent-teams.hosted-lifecycle-owner-admission/v4' as const;

const MAXIMUM_RESPONSE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 2_000;
const HEX_32 = /^[0-9a-f]{64}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const TEAM_ID = /^team_[0-9a-f]{32}$/u;
const OWNER_AUTHORITY = /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const OWNER_SESSION = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;

export interface HostedApprovalRuntimeActivationBinding {
  readonly deploymentId: string;
  readonly bootId: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly restoreGeneration: number;
  readonly mountBinding: Readonly<{
    mountGeneration: number;
    declaredRootHash: string;
  }>;
  readonly ownerBinding: OrchestratorLifecycleOwnerBinding;
  readonly socketPath: string;
  readonly approvalGeneration: number;
  readonly approvalDigest: `sha256:${string}`;
  readonly artifactDigest: `sha256:${string}`;
  readonly activationCapability: typeof HOSTED_APPROVAL_ACTIVATION_CAPABILITY;
  readonly wireCapabilityDigest: `sha256:${string}`;
  readonly signedManifest: Readonly<{
    format: typeof HOSTED_APPROVAL_ACTIVATION_MANIFEST_FORMAT;
    manifestDigest: `sha256:${string}`;
    releasePinDigest: `sha256:${string}`;
    launcherKeyId: string;
  }>;
}

export interface HostedApprovalRuntimeActivationLease {
  isReady(): boolean;
  currentBinding(): OrchestratorLifecycleOwnerBinding | null;
  invalidate(): void;
}

export interface HostedApprovalRuntimeActivationOptions {
  readonly binding: HostedApprovalRuntimeActivationBinding;
  readonly admission: unknown;
  readonly proofKey: OrchestratorLifecycleOwnerProofKey;
  readonly timeoutMs?: number;
  readonly onOwnerLoss: () => void;
  /** Unit-test seam. Production inspects the signed route's Unix socket. */
  readonly inspectSocketIdentity?: (path: string) => Promise<OrchestratorSocketIdentity>;
  /** Unit-test seam. Production uses one persistent lifecycle-control connection. */
  readonly connect?: (options: { readonly path: string }) => Socket;
  readonly generateChallenge?: () => string;
}

/**
 * Canonical proof-last activation-v1 publication. The shared HMAC proves that
 * bytes were not changed between the two pinned processes; because both peers
 * hold the key it is an integrity/authentication boundary, not proof of
 * exclusive product authorship.
 */
export function serializeHostedApprovalRuntimeActivationEnvelope(
  proofKey: OrchestratorLifecycleOwnerProofKey | Uint8Array,
  binding: HostedApprovalRuntimeActivationBinding,
  admission: unknown
): string {
  const normalizedBinding = validateActivationBinding(binding);
  const normalizedAdmission = validateActivationAdmission(admission, normalizedBinding);
  const unsigned = JSON.stringify({
    schemaVersion: 1,
    purpose: HOSTED_APPROVAL_ACTIVATION_PURPOSE,
    binding: normalizedBinding,
    admission: normalizedAdmission,
  });
  const controllerProof = createProof(proofKey, 'admission', unsigned);
  return appendProofLast(unsigned, controllerProof);
}

/** Strict verifier used by contract tests and product-side self-checks. */
export function verifyHostedApprovalRuntimeActivationEnvelope(
  source: string,
  proofKey: OrchestratorLifecycleOwnerProofKey | Uint8Array,
  expectedBinding: HostedApprovalRuntimeActivationBinding
): unknown {
  const parsed = parseProofLastFrame(source, [
    'schemaVersion',
    'purpose',
    'binding',
    'admission',
    'controllerProof',
  ]);
  if (
    parsed.value.schemaVersion !== 1 ||
    parsed.value.purpose !== HOSTED_APPROVAL_ACTIVATION_PURPOSE ||
    JSON.stringify(parsed.value.binding) !==
      JSON.stringify(validateActivationBinding(expectedBinding))
  ) {
    throw new TypeError('hosted-approval-activation-binding-mismatch');
  }
  requireProof(proofKey, 'admission', parsed.serializedUnsignedEnvelope, parsed.proof);
  const admission = validateActivationAdmission(parsed.value.admission, expectedBinding);
  if (JSON.stringify(admission) !== JSON.stringify(parsed.value.admission)) {
    throw new TypeError('hosted-approval-activation-admission-noncanonical');
  }
  return admission;
}

/**
 * Performs the authenticated owner_ready -> activation -> ready exchange over
 * the signed route's lifecycle-control socket. The returned lease stays live
 * on that same connection so owner loss revokes authority synchronously.
 */
export async function activateHostedApprovalRuntime(
  options: HostedApprovalRuntimeActivationOptions
): Promise<HostedApprovalRuntimeActivationLease> {
  const binding = validateActivationBinding(options.binding);
  const timeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const challenge = options.generateChallenge?.() ?? randomBytes(32).toString('hex');
  if (!HEX_32.test(challenge)) throw new TypeError('hosted-approval-activation-challenge-invalid');
  const inspect = options.inspectSocketIdentity ?? inspectOrchestratorLifecycleSocketIdentity;
  const socketIdentity = await inspect(binding.socketPath);
  if (!sameOrchestratorSocketIdentity(socketIdentity, binding.ownerBinding.socketIdentity)) {
    throw new Error('hosted-approval-activation-socket-binding-mismatch');
  }

  const envelope = serializeHostedApprovalRuntimeActivationEnvelope(
    options.proofKey,
    binding,
    options.admission
  );
  const activationDigest = createHash('sha256').update(envelope).digest('hex');
  const socket = (options.connect ?? createConnection)({ path: binding.socketPath });
  let active = false;
  let intentionallyClosed = false;
  let settled = false;
  let response = '';
  let responseBytes = 0;
  const responseDecoder = new TextDecoder('utf-8', { fatal: true });
  let phase: 'connecting' | 'owner_ready' | 'ready' | 'verifying' = 'connecting';
  let deadline: ReturnType<typeof setTimeout> | null = null;
  let rejectHandshake: ((error: Error) => void) | null = null;

  const loseOwner = (): void => {
    const wasActive = active;
    active = false;
    if (!socket.destroyed) socket.destroy();
    if (wasActive && !intentionallyClosed) options.onOwnerLoss();
  };
  const fail = (error: Error): void => {
    if (settled) {
      loseOwner();
      return;
    }
    settled = true;
    if (deadline !== null) clearTimeout(deadline);
    rejectHandshake?.(error);
    socket.destroy();
  };

  const lease = await new Promise<HostedApprovalRuntimeActivationLease>((resolve, reject) => {
    rejectHandshake = reject;
    deadline = setTimeout(() => fail(new Error('hosted-approval-activation-timeout')), timeoutMs);
    const writePrepare = (): void => {
      const unsigned = JSON.stringify({
        schemaVersion: 1,
        operation: 'approval_activation_prepare',
        capability: HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
        challenge,
        binding,
      });
      socket.write(
        `${appendProofLast(unsigned, createProof(options.proofKey, 'owner-ready-request', unsigned))}\n`
      );
      phase = 'owner_ready';
    };
    const acceptFrame = (frame: string): void => {
      if (phase === 'owner_ready') {
        parseOwnerReady(frame, options.proofKey, binding, challenge);
        socket.write(`${envelope}\n`);
        phase = 'ready';
        return;
      }
      if (phase !== 'ready') throw new TypeError('hosted-approval-activation-frame-unexpected');
      parseFinalReady(frame, options.proofKey, binding, challenge, activationDigest);
      phase = 'verifying';
      const currentIdentityPromise = inspect(binding.socketPath);
      void currentIdentityPromise.then(
        (currentIdentity) => {
          if (
            !sameOrchestratorSocketIdentity(currentIdentity, binding.ownerBinding.socketIdentity)
          ) {
            fail(new Error('hosted-approval-activation-socket-changed'));
            return;
          }
          if (settled || socket.destroyed || response.length !== 0) {
            fail(new Error('hosted-approval-activation-owner-lost'));
            return;
          }
          settled = true;
          active = true;
          if (deadline !== null) clearTimeout(deadline);
          resolve(
            Object.freeze({
              isReady: () => active && !socket.destroyed,
              currentBinding: () => (active && !socket.destroyed ? binding.ownerBinding : null),
              invalidate(): void {
                if (intentionallyClosed) return;
                intentionallyClosed = true;
                active = false;
                socket.destroy();
              },
            })
          );
        },
        () => fail(new Error('hosted-approval-activation-socket-changed'))
      );
    };
    socket.once('connect', writePrepare);
    socket.on('data', (chunk: Buffer) => {
      if (active) {
        loseOwner();
        return;
      }
      responseBytes += chunk.byteLength;
      if (responseBytes > MAXIMUM_RESPONSE_BYTES) {
        fail(new Error('hosted-approval-activation-response-invalid'));
        return;
      }
      try {
        response += responseDecoder.decode(chunk, { stream: true });
        while (!settled) {
          const newline = response.indexOf('\n');
          if (newline < 0) break;
          const frame = response.slice(0, newline);
          response = response.slice(newline + 1);
          responseBytes = Buffer.byteLength(response);
          acceptFrame(frame);
          if (phase === 'ready' && response.length > 0 && !response.includes('\n')) break;
        }
      } catch {
        fail(new Error('hosted-approval-activation-response-invalid'));
      }
    });
    socket.on('error', () => fail(new Error('hosted-approval-activation-owner-lost')));
    socket.on('end', () => fail(new Error('hosted-approval-activation-owner-lost')));
    socket.on('close', () => {
      if (!intentionallyClosed) fail(new Error('hosted-approval-activation-owner-lost'));
    });
  });
  if (!lease.isReady()) {
    lease.invalidate();
    throw new Error('hosted-approval-activation-owner-lost');
  }
  return lease;
}

function parseOwnerReady(
  source: string,
  proofKey: OrchestratorLifecycleOwnerProofKey,
  binding: HostedApprovalRuntimeActivationBinding,
  challenge: string
): void {
  const parsed = parseProofLastFrame(source, [
    'schemaVersion',
    'kind',
    'capability',
    'challenge',
    'binding',
    'controllerProof',
  ]);
  if (
    parsed.value.schemaVersion !== 1 ||
    parsed.value.kind !== 'owner_ready' ||
    parsed.value.capability !== HOSTED_APPROVAL_ACTIVATION_CAPABILITY ||
    parsed.value.challenge !== challenge ||
    JSON.stringify(parsed.value.binding) !== JSON.stringify(binding)
  ) {
    throw new TypeError();
  }
  requireProof(proofKey, 'owner-ready', parsed.serializedUnsignedEnvelope, parsed.proof);
}

function parseFinalReady(
  source: string,
  proofKey: OrchestratorLifecycleOwnerProofKey,
  binding: HostedApprovalRuntimeActivationBinding,
  challenge: string,
  activationDigest: string
): void {
  const parsed = parseProofLastFrame(source, [
    'schemaVersion',
    'kind',
    'capability',
    'challenge',
    'activationDigest',
    'binding',
    'controllerProof',
  ]);
  if (
    parsed.value.schemaVersion !== 1 ||
    parsed.value.kind !== 'ready' ||
    parsed.value.capability !== HOSTED_APPROVAL_ACTIVATION_CAPABILITY ||
    parsed.value.challenge !== challenge ||
    parsed.value.activationDigest !== activationDigest ||
    JSON.stringify(parsed.value.binding) !== JSON.stringify(binding)
  ) {
    throw new TypeError();
  }
  requireProof(proofKey, 'ready', parsed.serializedUnsignedEnvelope, parsed.proof);
}

function validateActivationBinding(
  value: HostedApprovalRuntimeActivationBinding
): HostedApprovalRuntimeActivationBinding {
  if (
    !exactKeys(value, [
      'deploymentId',
      'bootId',
      'workspaceId',
      'teamId',
      'restoreGeneration',
      'mountBinding',
      'ownerBinding',
      'socketPath',
      'approvalGeneration',
      'approvalDigest',
      'artifactDigest',
      'activationCapability',
      'wireCapabilityDigest',
      'signedManifest',
    ]) ||
    !IDENTIFIER.test(value.deploymentId) ||
    !IDENTIFIER.test(value.bootId) ||
    !IDENTIFIER.test(value.workspaceId) ||
    !TEAM_ID.test(value.teamId) ||
    !nonNegative(value.restoreGeneration) ||
    !exactKeys(value.mountBinding, ['mountGeneration', 'declaredRootHash']) ||
    !positive(value.mountBinding.mountGeneration) ||
    !HEX_32.test(value.mountBinding.declaredRootHash) ||
    !exactKeys(value.ownerBinding, [
      'ownerAuthority',
      'ownerGeneration',
      'ownerSessionId',
      'socketIdentity',
    ]) ||
    !OWNER_AUTHORITY.test(value.ownerBinding.ownerAuthority) ||
    !positive(value.ownerBinding.ownerGeneration) ||
    !OWNER_SESSION.test(value.ownerBinding.ownerSessionId) ||
    !exactKeys(value.ownerBinding.socketIdentity, ['device', 'inode', 'uid', 'gid', 'mode']) ||
    !/^\d{1,32}$/u.test(value.ownerBinding.socketIdentity.device) ||
    !/^\d{1,32}$/u.test(value.ownerBinding.socketIdentity.inode) ||
    !nonNegative(value.ownerBinding.socketIdentity.uid) ||
    !nonNegative(value.ownerBinding.socketIdentity.gid) ||
    !nonNegative(value.ownerBinding.socketIdentity.mode) ||
    value.ownerBinding.socketIdentity.mode > 0o777 ||
    value.socketPath.length === 0 ||
    !value.socketPath.startsWith('/') ||
    value.socketPath.includes('\0') ||
    !positive(value.approvalGeneration) ||
    !SHA256.test(value.approvalDigest) ||
    !SHA256.test(value.artifactDigest) ||
    value.activationCapability !== HOSTED_APPROVAL_ACTIVATION_CAPABILITY ||
    !SHA256.test(value.wireCapabilityDigest) ||
    !exactKeys(value.signedManifest, [
      'format',
      'manifestDigest',
      'releasePinDigest',
      'launcherKeyId',
    ]) ||
    value.signedManifest.format !== HOSTED_APPROVAL_ACTIVATION_MANIFEST_FORMAT ||
    !SHA256.test(value.signedManifest.manifestDigest) ||
    !SHA256.test(value.signedManifest.releasePinDigest) ||
    !HEX_32.test(value.signedManifest.launcherKeyId)
  ) {
    throw new TypeError('hosted-approval-activation-binding-invalid');
  }
  return Object.freeze({
    deploymentId: value.deploymentId,
    bootId: value.bootId,
    workspaceId: value.workspaceId,
    teamId: value.teamId,
    restoreGeneration: value.restoreGeneration,
    mountBinding: Object.freeze({ ...value.mountBinding }),
    ownerBinding: Object.freeze({
      ...value.ownerBinding,
      socketIdentity: Object.freeze({ ...value.ownerBinding.socketIdentity }),
    }),
    socketPath: value.socketPath,
    approvalGeneration: value.approvalGeneration,
    approvalDigest: value.approvalDigest,
    artifactDigest: value.artifactDigest,
    activationCapability: value.activationCapability,
    wireCapabilityDigest: value.wireCapabilityDigest,
    signedManifest: Object.freeze({ ...value.signedManifest }),
  });
}

function validateActivationAdmission(
  value: unknown,
  binding: HostedApprovalRuntimeActivationBinding
): unknown {
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !exactKeys(value, ['schemaVersion', 'approvalGeneration', 'authorities'])
  ) {
    throw new TypeError('hosted-approval-activation-admission-invalid');
  }
  const record = value as Record<string, unknown>;
  if (
    record.schemaVersion !== 1 ||
    record.approvalGeneration !== binding.approvalGeneration ||
    !Array.isArray(record.authorities) ||
    record.authorities.length === 0 ||
    record.authorities.length > 256
  ) {
    throw new TypeError('hosted-approval-activation-admission-invalid');
  }
  const authorities = record.authorities.map(parseRuntimePermissionApprovalIngressAuthority);
  const identities = authorities.map(
    (authority) =>
      `${authority.teamId}\0${authority.runId}\0${authority.laneId}\0${authority.sessionId}`
  );
  if (
    new Set(identities).size !== identities.length ||
    !authorities.some(
      (authority) =>
        authority.teamId === binding.teamId && authority.deploymentId === binding.deploymentId
    ) ||
    authorities.some((authority) => authority.deploymentId !== binding.deploymentId)
  ) {
    throw new TypeError('hosted-approval-activation-admission-binding-mismatch');
  }
  const normalized = Object.freeze({
    schemaVersion: 1 as const,
    approvalGeneration: binding.approvalGeneration,
    authorities: Object.freeze(authorities),
  });
  const digest = `sha256:${createHash('sha256').update(JSON.stringify(normalized)).digest('hex')}`;
  if (digest !== binding.approvalDigest) {
    throw new TypeError('hosted-approval-activation-admission-digest-mismatch');
  }
  return normalized;
}

function createProof(
  key: OrchestratorLifecycleOwnerProofKey | Uint8Array,
  direction: string,
  serializedUnsignedEnvelope: string
): string {
  return createHmac('sha256', keyBytes(key))
    .update(
      `${HOSTED_APPROVAL_ACTIVATION_PROOF_DOMAIN}\u0000${direction}\u0000${serializedUnsignedEnvelope}`
    )
    .digest('hex');
}

function requireProof(
  key: OrchestratorLifecycleOwnerProofKey | Uint8Array,
  direction: string,
  unsigned: string,
  supplied: string
): void {
  const expected = createProof(key, direction, unsigned);
  const suppliedBytes = HEX_32.test(supplied) ? Buffer.from(supplied, 'hex') : Buffer.alloc(0);
  const expectedBytes = Buffer.from(expected, 'hex');
  if (
    suppliedBytes.byteLength !== expectedBytes.byteLength ||
    !timingSafeEqual(suppliedBytes, expectedBytes)
  ) {
    throw new TypeError('hosted-approval-activation-proof-invalid');
  }
}

function parseProofLastFrame(
  source: string,
  expectedKeys: readonly string[]
): Readonly<{
  value: Record<string, unknown>;
  proof: string;
  serializedUnsignedEnvelope: string;
}> {
  if (source.length < 2 || source.includes('\n') || source.includes('\r')) throw new TypeError();
  const value = JSON.parse(source) as unknown;
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError();
  const record = value as Record<string, unknown>;
  if (!exactOrderedKeys(record, expectedKeys) || JSON.stringify(record) !== source) {
    throw new TypeError('hosted-approval-activation-frame-noncanonical');
  }
  const proof = record.controllerProof;
  if (typeof proof !== 'string' || !HEX_32.test(proof)) throw new TypeError();
  const suffix = `,"controllerProof":"${proof}"}`;
  if (!source.endsWith(suffix)) throw new TypeError('hosted-approval-activation-proof-not-last');
  return Object.freeze({
    value: record,
    proof,
    serializedUnsignedEnvelope: `${source.slice(0, -suffix.length)}}`,
  });
}

function appendProofLast(unsigned: string, proof: string): string {
  return `${unsigned.slice(0, -1)},"controllerProof":"${proof}"}`;
}

function keyBytes(key: OrchestratorLifecycleOwnerProofKey | Uint8Array): Uint8Array {
  if (typeof key === 'string') {
    if (!HEX_32.test(key)) throw new TypeError('hosted-approval-activation-proof-key-invalid');
    return Buffer.from(key, 'hex');
  }
  if (key.byteLength !== 32) throw new TypeError('hosted-approval-activation-proof-key-invalid');
  return key;
}

function exactKeys(value: object, expected: readonly string[]): boolean {
  const actual = Reflect.ownKeys(value);
  return (
    actual.length === expected.length &&
    actual.every((key) => typeof key === 'string' && expected.includes(key))
  );
}

function exactOrderedKeys(value: object, expected: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function validateTimeout(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > 60_000) {
    throw new TypeError('hosted-approval-activation-timeout-invalid');
  }
  return value;
}

function positive(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function nonNegative(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function sameHostedApprovalActivationOwner(
  lease: HostedApprovalRuntimeActivationLease,
  expected: OrchestratorLifecycleOwnerBinding
): boolean {
  const current = lease.currentBinding();
  return current !== null && sameOrchestratorLifecycleOwnerBinding(current, expected);
}
