import { createHmac, timingSafeEqual } from 'node:crypto';

import { HOSTED_LIFECYCLE_OWNER_GENERATION_LIMIT } from './hostedLifecycleOwnerHighWaterBinding';

const OWNER_AUTHORITY_PATTERN = /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const OWNER_SESSION_PATTERN = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const OWNER_PROOF_KEY_PATTERN = /^[0-9a-f]{64}$/;
const OWNER_PROOF_DOMAIN = 'agent-teams.hosted-lifecycle.owner-proof/v1';

export type ReadinessDiagnosticStage =
  | 'socket_inspection'
  | 'signed_handshake'
  | 'high_water_admission'
  | 'owner_acquisition'
  | 'owner_loss';

export type HostedLifecycleReadinessFailure =
  | 'socket_not_found'
  | 'socket_access_denied'
  | 'connection_refused'
  | 'handshake_timeout'
  | 'acquisition_rejected'
  | 'high_water_rejected'
  | 'owner_connection_lost';

export type HostedLifecycleReadinessDiagnostic = Readonly<{
  stage: ReadinessDiagnosticStage;
  outcome: 'started' | 'succeeded' | 'failed';
  failure?: HostedLifecycleReadinessFailure;
}>;

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
    !hasExactKeys(value, ['ownerAuthority', 'ownerGeneration', 'ownerSessionId', 'socketIdentity']) ||
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

export function createOrchestratorLifecycleReadinessProof(
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

export function ownerProofMatches(expected: string, actual: unknown): boolean {
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
    sameOrchestratorSocketIdentity(left.socketIdentity, right.socketIdentity)
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
