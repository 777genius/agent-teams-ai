import { createHash, randomBytes } from 'node:crypto';
import { createConnection } from 'node:net';

import {
  inspectOrchestratorLifecycleSocketIdentity,
  type OrchestratorLifecycleOwnerProofKey,
  sameOrchestratorSocketIdentity,
} from '@main/composition/hosted/hostedLifecycleOrchestratorReadiness';

import {
  appendHostedApprovalActivationProofLast as appendProofLast,
  createHostedApprovalActivationProof as createProof,
  HOSTED_APPROVAL_ACTIVATION_PROOF_DOMAIN,
  parseHostedApprovalActivationProofLastFrame as parseProofLastFrame,
  requireHostedApprovalActivationProof as requireProof,
} from './HostedApprovalRuntimeActivationProof';
import {
  validateActivationAdmission,
  validateActivationBinding,
  validateTimeout,
} from './HostedApprovalRuntimeActivationValidation';
import {
  type HostedApprovalRuntimeActivationPublicVerifier,
  type HostedApprovalRuntimeActivationSigningIdentity,
  serializeHostedApprovalRuntimeActivationAuthorshipPublication,
  verifyHostedApprovalRuntimeActivationAuthorshipPublication,
} from './HostedApprovalRuntimeProductionComposition';

import type {
  HostedActualOwnerCandidateOpenCodeSha256,
  HostedApprovalRuntimeActivationBinding,
  HostedApprovalRuntimeActivationLease,
  HostedApprovalRuntimeActivationOptions,
  HostedApprovalRuntimeConnectedTransport,
} from './HostedApprovalRuntimeActivationTypes';

export type {
  HostedActualOwnerCandidateOpenCodeSha256,
  HostedApprovalRuntimeActivationBinding,
  HostedApprovalRuntimeActivationLease,
  HostedApprovalRuntimeActivationOptions,
  HostedApprovalRuntimeConnectedTransport,
} from './HostedApprovalRuntimeActivationTypes';
export { sameHostedApprovalActivationOwner } from './HostedApprovalRuntimeActivationTypes';
export {
  HOSTED_APPROVAL_ACTIVATION_ADMISSION_FILE_ENV,
  HOSTED_APPROVAL_ACTIVATION_AUTHORSHIP_ALGORITHM,
  HOSTED_APPROVAL_ACTIVATION_CONTRACT_DIGEST_ENV,
  HOSTED_APPROVAL_ACTIVATION_PUBLIC_KEY_DIGEST_ENV,
  HOSTED_APPROVAL_ACTIVATION_SIGNING_KEY_FILE_ENV,
  type HostedApprovalRuntimeActivationAuthorship,
  type HostedApprovalRuntimeActivationPublicationContract,
  type HostedApprovalRuntimeActivationPublicVerifier,
  type HostedApprovalRuntimeActivationSigningIdentity,
  readHostedApprovalRuntimeActivationPublicationContract,
  readHostedApprovalRuntimeActivationSigningIdentity,
} from './HostedApprovalRuntimeProductionComposition';

export const HOSTED_APPROVAL_ACTIVATION_PURPOSE =
  'agent-teams.hosted-approval-activation/v2' as const;
export const HOSTED_APPROVAL_ACTIVATION_CAPABILITY =
  'agent-teams.hosted-approval-activation-v2' as const;
export { HOSTED_APPROVAL_ACTIVATION_PROOF_DOMAIN };
export const HOSTED_APPROVAL_ACTIVATION_MANIFEST_FORMAT =
  'agent-teams.hosted-lifecycle-owner-admission/v4' as const;
export const HOSTED_ACTUAL_OWNER_CANDIDATE_OPENCODE_SHA256 =
  'cffecbe3ff685de84d7fa028e552c42d15a7c720a8f8d5d1cddd265110e5eb88' as const satisfies HostedActualOwnerCandidateOpenCodeSha256;

const MAXIMUM_RESPONSE_BYTES = 64 * 1024;
const MAXIMUM_PREPARE_BYTES = 64 * 1024;
const DEFAULT_TIMEOUT_MS = 2_000;
const HEX_32 = /^[0-9a-f]{64}$/u;

/**
 * Canonical proof-last activation-v2 envelope. The shared HMAC is deliberately
 * only peer-integrity evidence. Product authorship is established separately
 * by the detached Ed25519 statement in the fixed publication wrapper.
 */
export function serializeHostedApprovalRuntimeActivationEnvelope(
  proofKey: OrchestratorLifecycleOwnerProofKey | Uint8Array,
  binding: HostedApprovalRuntimeActivationBinding,
  admissionDocument: string
): string {
  const normalizedBinding = validateActivationBinding(binding);
  const normalizedAdmission = validateActivationAdmission(admissionDocument, normalizedBinding);
  const unsigned = JSON.stringify({
    schemaVersion: 2,
    purpose: HOSTED_APPROVAL_ACTIVATION_PURPOSE,
    binding: normalizedBinding,
    admission: normalizedAdmission,
  });
  const controllerProof = createProof(proofKey, 'admission', unsigned);
  return appendProofLast(unsigned, controllerProof);
}

/** Canonical publication containing the exact signed envelope and detached authorship. */
export function serializeHostedApprovalRuntimeActivationPublication(
  proofKey: OrchestratorLifecycleOwnerProofKey | Uint8Array,
  signingIdentity: HostedApprovalRuntimeActivationSigningIdentity,
  binding: HostedApprovalRuntimeActivationBinding,
  admissionDocument: string
): string {
  const envelope = serializeHostedApprovalRuntimeActivationEnvelope(
    proofKey,
    binding,
    admissionDocument
  );
  const publication = serializeHostedApprovalRuntimeActivationAuthorshipPublication(
    envelope,
    signingIdentity
  );
  verifyHostedApprovalRuntimeActivationPublication(publication, proofKey, signingIdentity, binding);
  return publication;
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
    parsed.value.schemaVersion !== 2 ||
    parsed.value.purpose !== HOSTED_APPROVAL_ACTIVATION_PURPOSE ||
    JSON.stringify(parsed.value.binding) !==
      JSON.stringify(validateActivationBinding(expectedBinding))
  ) {
    throw new TypeError('hosted-approval-activation-binding-mismatch');
  }
  requireProof(proofKey, 'admission', parsed.serializedUnsignedEnvelope, parsed.proof);
  const serializedAdmission = `${JSON.stringify(parsed.value.admission)}\n`;
  const admission = validateActivationAdmission(serializedAdmission, expectedBinding);
  if (JSON.stringify(admission) !== JSON.stringify(parsed.value.admission)) {
    throw new TypeError('hosted-approval-activation-admission-noncanonical');
  }
  return admission;
}

/** Strict product/orchestrator contract verifier with no HMAC-only fallback. */
export function verifyHostedApprovalRuntimeActivationPublication(
  source: string,
  proofKey: OrchestratorLifecycleOwnerProofKey | Uint8Array,
  verifier: HostedApprovalRuntimeActivationPublicVerifier,
  expectedBinding: HostedApprovalRuntimeActivationBinding
): unknown {
  const serializedEnvelope = verifyHostedApprovalRuntimeActivationAuthorshipPublication(
    source,
    verifier
  );
  return verifyHostedApprovalRuntimeActivationEnvelope(
    serializedEnvelope,
    proofKey,
    expectedBinding
  );
}

/**
 * Performs the authenticated owner_ready -> activation -> ready exchange over
 * the signed route's lifecycle-control socket. The returned lease stays live
 * on that same connection so owner loss revokes authority synchronously.
 */
export async function activateHostedApprovalRuntime(
  options: HostedApprovalRuntimeActivationOptions
): Promise<HostedApprovalRuntimeActivationLease> {
  const prepared = prepareHostedApprovalRuntimeActivation(options);
  const binding = prepared.binding;
  const inspect = prepared.inspectSocketIdentity;
  const socketIdentity = await inspect(binding.socketPath);
  if (!sameOrchestratorSocketIdentity(socketIdentity, binding.ownerBinding.socketIdentity)) {
    throw new Error('hosted-approval-activation-socket-binding-mismatch');
  }

  const transport = {
    socket: prepared.connect({ path: binding.socketPath }),
  };
  try {
    return await activateHostedApprovalRuntimeOnConnectedTransport(transport, prepared, {
      start: 'connect',
      revalidate: async () => {
        const currentIdentity = await inspect(binding.socketPath);
        return sameOrchestratorSocketIdentity(currentIdentity, binding.ownerBinding.socketIdentity);
      },
    });
  } catch (error) {
    closeHostedApprovalRuntimeConnectedTransport(transport);
    throw error;
  }
}

/** Runs ActivationV2 on the exact retained inherited connection without path discovery/reconnect. */
export async function activateHostedApprovalRuntimeOverConnectedTransport(
  options: HostedApprovalRuntimeActivationOptions,
  transport: HostedApprovalRuntimeConnectedTransport,
  expectedOpenCodeExecutableSha256: HostedActualOwnerCandidateOpenCodeSha256
): Promise<HostedApprovalRuntimeActivationLease> {
  const capturedTransport = Object.freeze({ socket: transport.socket });
  try {
    const prepared = prepareHostedApprovalRuntimeActivation(
      options,
      expectedOpenCodeExecutableSha256
    );
    return await activateHostedApprovalRuntimeOnConnectedTransport(capturedTransport, prepared, {
      start: 'connected',
      revalidate: async () => !capturedTransport.socket.destroyed,
    });
  } catch (error) {
    closeHostedApprovalRuntimeConnectedTransport(capturedTransport);
    throw error;
  }
}

const ignoreRejectedTransportError = (): void => undefined;
const rejectedTransportSockets = new WeakSet<HostedApprovalRuntimeConnectedTransport['socket']>();

/** Closes a rejected handed-off transport and drains errors that were already queued by Node. */
export function closeHostedApprovalRuntimeConnectedTransport(
  transport: HostedApprovalRuntimeConnectedTransport
): void {
  const socket = transport.socket;
  if (rejectedTransportSockets.has(socket)) return;
  rejectedTransportSockets.add(socket);
  socket.on('error', ignoreRejectedTransportError);
  if (!socket.destroyed) socket.destroy();
}

interface PreparedHostedApprovalRuntimeActivation {
  readonly binding: HostedApprovalRuntimeActivationBinding;
  readonly timeoutMs: number;
  readonly challenge: string;
  readonly publication: string;
  readonly activationDigest: string;
  readonly proofKey: OrchestratorLifecycleOwnerProofKey;
  readonly onOwnerLoss: () => void;
  readonly inspectSocketIdentity: NonNullable<
    HostedApprovalRuntimeActivationOptions['inspectSocketIdentity']
  >;
  readonly connect: NonNullable<HostedApprovalRuntimeActivationOptions['connect']>;
}

/** Validates deterministic composition inputs before any route is allowed to connect. */
export function assertHostedApprovalRuntimeActivationPreflight(
  options: HostedApprovalRuntimeActivationOptions,
  expectedOpenCodeExecutableSha256?: HostedActualOwnerCandidateOpenCodeSha256
): void {
  prepareHostedApprovalRuntimeActivation(
    { ...options, generateChallenge: () => '0'.repeat(64) },
    expectedOpenCodeExecutableSha256
  );
}

function prepareHostedApprovalRuntimeActivation(
  options: HostedApprovalRuntimeActivationOptions,
  expectedOpenCodeExecutableSha256?: HostedActualOwnerCandidateOpenCodeSha256
): PreparedHostedApprovalRuntimeActivation {
  const binding = validateActivationBinding(options.binding);
  const timeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const challenge = options.generateChallenge?.() ?? randomBytes(32).toString('hex');
  const proofKey = options.proofKey;
  const onOwnerLoss = options.onOwnerLoss;
  const inspectSocketIdentity =
    options.inspectSocketIdentity ?? inspectOrchestratorLifecycleSocketIdentity;
  const connect = options.connect ?? createConnection;
  if (!HEX_32.test(challenge)) throw new TypeError('hosted-approval-activation-challenge-invalid');
  if (expectedOpenCodeExecutableSha256 !== undefined) {
    assertCandidateOpenCodeDigest(
      options.admissionDocument,
      binding,
      expectedOpenCodeExecutableSha256
    );
  }
  const publication = serializeHostedApprovalRuntimeActivationPublication(
    proofKey,
    options.signingIdentity,
    binding,
    options.admissionDocument
  );
  return Object.freeze({
    binding,
    timeoutMs,
    challenge,
    publication,
    activationDigest: createHash('sha256').update(publication).digest('hex'),
    proofKey,
    onOwnerLoss,
    inspectSocketIdentity,
    connect,
  });
}

async function activateHostedApprovalRuntimeOnConnectedTransport(
  transport: HostedApprovalRuntimeConnectedTransport,
  prepared: PreparedHostedApprovalRuntimeActivation,
  connection: Readonly<{
    start: 'connect' | 'connected';
    revalidate: () => Promise<boolean>;
  }>
): Promise<HostedApprovalRuntimeActivationLease> {
  const { binding, timeoutMs, challenge, publication, activationDigest, proofKey, onOwnerLoss } =
    prepared;
  const socket = transport.socket;
  if (socket.destroyed) throw new Error('hosted-approval-activation-owner-lost');
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
    if (wasActive && !intentionallyClosed) onOwnerLoss();
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
        schemaVersion: 2,
        operation: 'approval_activation_prepare',
        capability: HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
        challenge,
        binding,
      });
      const prepare = appendProofLast(
        unsigned,
        createProof(proofKey, 'owner-ready-request', unsigned)
      );
      if (Buffer.byteLength(prepare) + 1 > MAXIMUM_PREPARE_BYTES) {
        fail(new Error('hosted-approval-activation-prepare-too-large'));
        return;
      }
      phase = 'owner_ready';
      socket.write(`${prepare}\n`);
    };
    const acceptFrame = (frame: string): void => {
      if (phase === 'owner_ready') {
        parseOwnerReady(frame, proofKey, binding, challenge);
        phase = 'ready';
        socket.write(`${publication}\n`);
        return;
      }
      if (phase !== 'ready') throw new TypeError('hosted-approval-activation-frame-unexpected');
      parseFinalReady(frame, proofKey, binding, challenge, activationDigest);
      phase = 'verifying';
      void connection.revalidate().then(
        (current) => {
          if (!current) {
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
    const begin = (): void => {
      try {
        writePrepare();
      } catch {
        fail(new Error('hosted-approval-activation-owner-lost'));
      }
    };
    if (connection.start === 'connect') socket.once('connect', begin);
    else queueMicrotask(begin);
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

function assertCandidateOpenCodeDigest(
  admissionDocument: string,
  binding: HostedApprovalRuntimeActivationBinding,
  expected: string
): void {
  if (expected !== HOSTED_ACTUAL_OWNER_CANDIDATE_OPENCODE_SHA256) {
    throw new TypeError('hosted-approval-activation-candidate-pin-invalid');
  }
  const admission = validateActivationAdmission(admissionDocument, binding) as {
    routes: readonly { openCodeBinding: { openCodeArtifactDigest: string } }[];
  };
  if (
    admission.routes.some(
      (route) => route.openCodeBinding.openCodeArtifactDigest.slice('sha256:'.length) !== expected
    )
  ) {
    throw new TypeError('hosted-approval-activation-candidate-digest-mismatch');
  }
}

export function assertHostedApprovalRuntimeCandidateAdmission(
  admissionDocument: string,
  binding: HostedApprovalRuntimeActivationBinding,
  expectedOpenCodeExecutableSha256: string
): void {
  assertCandidateOpenCodeDigest(
    admissionDocument,
    validateActivationBinding(binding),
    expectedOpenCodeExecutableSha256
  );
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
    parsed.value.schemaVersion !== 2 ||
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
    parsed.value.schemaVersion !== 2 ||
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
