import { createHash, randomBytes } from 'node:crypto';
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

import {
  appendHostedApprovalActivationProofLast as appendProofLast,
  createHostedApprovalActivationProof as createProof,
  HOSTED_APPROVAL_ACTIVATION_PROOF_DOMAIN,
  parseHostedApprovalActivationProofLastFrame as parseProofLastFrame,
  requireHostedApprovalActivationProof as requireProof,
} from './HostedApprovalRuntimeActivationProof';
import {
  type HostedApprovalRuntimeActivationPublicVerifier,
  type HostedApprovalRuntimeActivationSigningIdentity,
  serializeHostedApprovalRuntimeActivationAuthorshipPublication,
  verifyHostedApprovalRuntimeActivationAuthorshipPublication,
} from './HostedApprovalRuntimeProductionComposition';

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

const MAXIMUM_RESPONSE_BYTES = 64 * 1024;
const MAXIMUM_PREPARE_BYTES = 64 * 1024;
const MAXIMUM_ADMISSION_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 2_000;
const HEX_32 = /^[0-9a-f]{64}$/u;
const SHA256 = /^sha256:[0-9a-f]{64}$/u;
const TEAM_ID = /^team_[0-9a-f]{32}$/u;
const OWNER_AUTHORITY = /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const OWNER_SESSION = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/u;
const ACTOR_ID = /^actor_[A-Za-z0-9][A-Za-z0-9._-]{0,121}$/u;
const MEMBER_ID = /^member_[0-9a-f]{32}$/u;
const GENERATION = /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/u;
const ADMISSION_GENERATION = /^approval-admission-generation_([1-9][0-9]*)_owner_([1-9][0-9]*)$/u;

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
  readonly admissionOwnerGeneration: number;
  readonly approvalDigest: `sha256:${string}`;
  readonly admissionDocumentDigest: `sha256:${string}`;
  /** Canonical activation-v2 owner-image binding. */
  readonly ownerArtifactDigest?: `sha256:${string}`;
  /** Internal manifest-v4 mapping compatibility; never serialized on the wire. */
  readonly artifactDigest?: `sha256:${string}`;
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
  readonly admissionDocument: string;
  readonly proofKey: OrchestratorLifecycleOwnerProofKey;
  readonly signingIdentity: HostedApprovalRuntimeActivationSigningIdentity;
  readonly timeoutMs?: number;
  readonly onOwnerLoss: () => void;
  /** Unit-test seam. Production inspects the signed route's Unix socket. */
  readonly inspectSocketIdentity?: (path: string) => Promise<OrchestratorSocketIdentity>;
  /** Unit-test seam. Production uses one persistent lifecycle-control connection. */
  readonly connect?: (options: { readonly path: string }) => Socket;
  readonly generateChallenge?: () => string;
}

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
  const binding = validateActivationBinding(options.binding);
  const timeoutMs = validateTimeout(options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  const challenge = options.generateChallenge?.() ?? randomBytes(32).toString('hex');
  if (!HEX_32.test(challenge)) throw new TypeError('hosted-approval-activation-challenge-invalid');
  const inspect = options.inspectSocketIdentity ?? inspectOrchestratorLifecycleSocketIdentity;
  const socketIdentity = await inspect(binding.socketPath);
  if (!sameOrchestratorSocketIdentity(socketIdentity, binding.ownerBinding.socketIdentity)) {
    throw new Error('hosted-approval-activation-socket-binding-mismatch');
  }

  const publication = serializeHostedApprovalRuntimeActivationPublication(
    options.proofKey,
    options.signingIdentity,
    binding,
    options.admissionDocument
  );
  const activationDigest = createHash('sha256').update(publication).digest('hex');
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
        schemaVersion: 2,
        operation: 'approval_activation_prepare',
        capability: HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
        challenge,
        binding,
      });
      const prepare = appendProofLast(
        unsigned,
        createProof(options.proofKey, 'owner-ready-request', unsigned)
      );
      if (Buffer.byteLength(prepare) + 1 > MAXIMUM_PREPARE_BYTES) {
        fail(new Error('hosted-approval-activation-prepare-too-large'));
        return;
      }
      socket.write(`${prepare}\n`);
      phase = 'owner_ready';
    };
    const acceptFrame = (frame: string): void => {
      if (phase === 'owner_ready') {
        parseOwnerReady(frame, options.proofKey, binding, challenge);
        socket.write(`${publication}\n`);
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

function validateActivationBinding(
  value: HostedApprovalRuntimeActivationBinding
): HostedApprovalRuntimeActivationBinding {
  const canonicalKeys = [
    'deploymentId',
    'bootId',
    'workspaceId',
    'teamId',
    'restoreGeneration',
    'mountBinding',
    'ownerBinding',
    'socketPath',
    'approvalGeneration',
    'admissionOwnerGeneration',
    'approvalDigest',
    'admissionDocumentDigest',
    'ownerArtifactDigest',
    'activationCapability',
    'wireCapabilityDigest',
    'signedManifest',
  ] as const;
  const legacyManifestMappingKeys = canonicalKeys.map((key) =>
    key === 'ownerArtifactDigest' ? 'artifactDigest' : key
  );
  const ownerArtifactDigest = value.ownerArtifactDigest ?? value.artifactDigest;
  if (
    (!exactKeys(value, canonicalKeys) && !exactKeys(value, legacyManifestMappingKeys)) ||
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
    !positive(value.admissionOwnerGeneration) ||
    !SHA256.test(value.approvalDigest) ||
    !SHA256.test(value.admissionDocumentDigest) ||
    typeof ownerArtifactDigest !== 'string' ||
    !SHA256.test(ownerArtifactDigest) ||
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
    admissionOwnerGeneration: value.admissionOwnerGeneration,
    approvalDigest: value.approvalDigest,
    admissionDocumentDigest: value.admissionDocumentDigest,
    ownerArtifactDigest: ownerArtifactDigest as `sha256:${string}`,
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
    typeof value !== 'string' ||
    Buffer.byteLength(value) > MAXIMUM_ADMISSION_BYTES ||
    !value.endsWith('\n') ||
    value.includes('\r')
  ) {
    throw new TypeError('hosted-approval-activation-admission-invalid');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new TypeError('hosted-approval-activation-admission-invalid');
  }
  const record = orderedRecord(parsed, [
    'schemaVersion',
    'admissionGeneration',
    'outerAuthority',
    'routes',
    'actorMembers',
  ]);
  if (
    record.schemaVersion !== 1 ||
    `${JSON.stringify(record)}\n` !== value ||
    typeof record.admissionGeneration !== 'string' ||
    !Array.isArray(record.routes) ||
    record.routes.length === 0 ||
    record.routes.length > 256
  ) {
    throw new TypeError('hosted-approval-activation-admission-invalid');
  }
  const generation = ADMISSION_GENERATION.exec(record.admissionGeneration);
  if (
    !generation ||
    Number(generation[1]) !== binding.approvalGeneration ||
    Number(generation[2]) !== binding.admissionOwnerGeneration
  ) {
    throw new TypeError('hosted-approval-activation-admission-generation-mismatch');
  }
  const outer = orderedRecord(record.outerAuthority, [
    'deploymentId',
    'bootId',
    'workspaceId',
    'teamId',
    'restoreGeneration',
    'mountBinding',
  ]);
  const mount = orderedRecord(outer.mountBinding, ['mountGeneration', 'declaredRootHash']);
  if (
    outer.deploymentId !== binding.deploymentId ||
    outer.bootId !== binding.bootId ||
    outer.workspaceId !== binding.workspaceId ||
    typeof outer.teamId !== 'string' ||
    !TEAM_ID.test(outer.teamId) ||
    outer.restoreGeneration !== binding.restoreGeneration ||
    mount.mountGeneration !== binding.mountBinding.mountGeneration ||
    mount.declaredRootHash !== binding.mountBinding.declaredRootHash
  ) {
    throw new TypeError('hosted-approval-activation-admission-binding-mismatch');
  }
  const actorMembers = orderedRecordMap(record.actorMembers);
  const actorEntries = Object.entries(actorMembers);
  if (
    actorEntries.length === 0 ||
    actorEntries.some(
      ([actorId, memberId]) => !ACTOR_ID.test(actorId) || !MEMBER_ID.test(memberId)
    ) ||
    actorEntries.length > 256
  ) {
    throw new TypeError('hosted-approval-activation-actor-mapping-invalid');
  }
  const routeIds = new Set<string>();
  const routeIdentities = new Set<string>();
  const admittedTeamIds = new Set<string>();
  const authorities = record.routes.map((candidate) => {
    const route = orderedRecord(candidate, [
      'routeId',
      'authority',
      'scope',
      'memberName',
      'openCodeBinding',
    ]);
    const authorityRecord = orderedRecord(route.authority, [
      'deploymentId',
      'teamId',
      'runId',
      'planGeneration',
      'laneId',
      'providerId',
      'credentialGeneration',
      'credentialId',
      'sessionId',
      'runtimeInstanceId',
      'deliveryOwnerId',
    ]);
    const authority = parseRuntimePermissionApprovalIngressAuthority(authorityRecord);
    const scope = orderedRecord(route.scope, [
      'principalId',
      'workspaceId',
      'teamId',
      'authorityGeneration',
      'restoreGeneration',
    ]);
    const openCode = orderedRecord(route.openCodeBinding, [
      'toolApprovalMode',
      'planGeneration',
      'credentialGeneration',
      'credentialId',
      'runtimeInstanceId',
      'deliveryOwnerId',
      'openCodeArtifactDigest',
      'sessionRecordFingerprint',
      'liveEffectFingerprint',
    ]);
    if (
      typeof route.routeId !== 'string' ||
      !IDENTIFIER.test(route.routeId) ||
      routeIds.has(route.routeId) ||
      typeof route.memberName !== 'string' ||
      !IDENTIFIER.test(route.memberName) ||
      authority.deploymentId !== binding.deploymentId ||
      authority.providerId !== 'opencode' ||
      routeIdentities.has(
        `${authority.teamId}\0${authority.runId}\0${authority.laneId}\0${authority.sessionId}`
      ) ||
      scope.workspaceId !== binding.workspaceId ||
      scope.teamId !== authority.teamId ||
      scope.restoreGeneration !== binding.restoreGeneration ||
      typeof scope.principalId !== 'string' ||
      !ACTOR_ID.test(scope.principalId) ||
      typeof scope.authorityGeneration !== 'string' ||
      !GENERATION.test(scope.authorityGeneration) ||
      actorMembers[scope.principalId] !== authority.deliveryOwnerId ||
      openCode.toolApprovalMode !== 'manual' ||
      openCode.planGeneration !== authority.planGeneration ||
      openCode.credentialGeneration !== authority.credentialGeneration ||
      openCode.credentialId !== authority.credentialId ||
      openCode.runtimeInstanceId !== authority.runtimeInstanceId ||
      openCode.deliveryOwnerId !== authority.deliveryOwnerId ||
      typeof openCode.openCodeArtifactDigest !== 'string' ||
      !SHA256.test(openCode.openCodeArtifactDigest) ||
      typeof openCode.sessionRecordFingerprint !== 'string' ||
      !HEX_32.test(openCode.sessionRecordFingerprint) ||
      typeof openCode.liveEffectFingerprint !== 'string' ||
      !HEX_32.test(openCode.liveEffectFingerprint)
    ) {
      throw new TypeError('hosted-approval-activation-route-invalid');
    }
    routeIds.add(route.routeId);
    routeIdentities.add(
      `${authority.teamId}\0${authority.runId}\0${authority.laneId}\0${authority.sessionId}`
    );
    admittedTeamIds.add(authority.teamId);
    return authority;
  });
  const routeOrder = [...routeIds];
  if (routeOrder.some((routeId, index) => index > 0 && routeOrder[index - 1] > routeId)) {
    throw new TypeError('hosted-approval-activation-route-order-invalid');
  }
  if (
    !admittedTeamIds.has(binding.teamId) ||
    [...admittedTeamIds].some((teamId) => !TEAM_ID.test(teamId)) ||
    authorities.some(
      (authority) =>
        !actorEntries.some(([, actorMemberId]) => actorMemberId === authority.deliveryOwnerId)
    )
  ) {
    throw new TypeError('hosted-approval-activation-actor-mapping-invalid');
  }
  const approvalSnapshot = {
    schemaVersion: 1,
    approvalGeneration: binding.approvalGeneration,
    authorities,
  };
  const approvalDigest = `sha256:${createHash('sha256')
    .update(JSON.stringify(approvalSnapshot))
    .digest('hex')}`;
  const documentDigest = `sha256:${createHash('sha256').update(value).digest('hex')}`;
  if (
    approvalDigest !== binding.approvalDigest ||
    documentDigest !== binding.admissionDocumentDigest
  ) {
    throw new TypeError('hosted-approval-activation-admission-digest-mismatch');
  }
  return record;
}

function orderedRecord(value: unknown, keys: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('hosted-approval-activation-object-invalid');
  }
  const record = value as Record<string, unknown>;
  if (!exactOrderedKeys(record, keys)) {
    throw new TypeError('hosted-approval-activation-order-invalid');
  }
  return record;
}

function orderedRecordMap(value: unknown): Record<string, string> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('hosted-approval-activation-object-invalid');
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record);
  if (
    keys.some((key, index) => index > 0 && keys[index - 1] > key) ||
    Object.values(record).some((memberId) => typeof memberId !== 'string')
  ) {
    throw new TypeError('hosted-approval-activation-order-invalid');
  }
  return record as Record<string, string>;
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
