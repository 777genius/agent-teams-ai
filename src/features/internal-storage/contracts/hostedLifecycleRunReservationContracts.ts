import {
  type ActorId,
  type BootId,
  type DeploymentId,
  parseActorId,
  parseBootId,
  parseDeploymentId,
  parseRevision,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
  type Revision,
  type RunId,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

import { promotionOperationId } from './hostedPromotionStorageContracts';
import { exactPublicationRecord } from './teamDraftPublicationContracts';

export interface HostedLifecycleRunReservationInput {
  readonly schemaVersion: 1;
  readonly workspaceId: WorkspaceId;
  readonly runtimeWorkspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly actorId: ActorId;
  readonly deploymentId: DeploymentId;
  readonly bootId: BootId;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly expectedRevision: Revision;
  readonly expectedPlanGeneration: string;
  readonly ownerAuthority: string;
  readonly ownerGeneration: number;
  readonly ownerSessionId: string;
  readonly restoreGeneration: number;
  readonly mountGeneration: number;
  readonly ownerEffectFence: Readonly<{
    grantRevision: string;
    identityChecksum: string;
  }>;
  readonly authorityEvidence: Readonly<{
    userId: string;
    sessionId: string;
    grantGeneration: number;
  }>;
  readonly deadlineAtMs: number;
}

/** Immutable Product proof that a canonical run was reserved for one accepted launch intent. */
export interface HostedLifecycleRunReservation extends Omit<
  HostedLifecycleRunReservationInput,
  'deadlineAtMs'
> {
  readonly runId: RunId;
  readonly promotionOperationId: string;
  readonly planSha256: string;
  readonly rosterBindingSha256: string;
  readonly createdAtMs: number;
}

export type HostedLifecycleRunReservationResult =
  | {
      readonly kind: 'reserved' | 'idempotent_replay';
      readonly reservation: HostedLifecycleRunReservation;
    }
  | { readonly kind: 'conflict'; readonly reason: 'binding_mismatch' | 'resource_claimed' }
  | {
      readonly kind: 'unavailable';
      readonly reason: 'promotion_missing' | 'legacy_frozen_without_binding' | 'authority_changed';
    };

export interface HostedLifecycleRunReservationGateway {
  reserve(
    input: HostedLifecycleRunReservationInput,
    options: { readonly signal: AbortSignal }
  ): Promise<HostedLifecycleRunReservationResult>;
  /** Historical binding only. Callers must independently check current authority. */
  lookup(runId: RunId): Promise<HostedLifecycleRunReservation | null>;
}

const SHA = /^[a-f0-9]{64}$/;
const COMMAND = /^lifecycle-command_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const IDEMPOTENCY = /^idempotency_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const OWNER_AUTHORITY = /^owner-authority_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const OWNER_SESSION = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const USER_OR_SESSION = /^[a-z][a-z0-9-]*_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/;
const INPUT_KEYS = [
  'schemaVersion',
  'workspaceId',
  'runtimeWorkspaceId',
  'teamId',
  'actorId',
  'deploymentId',
  'bootId',
  'commandId',
  'idempotencyKey',
  'expectedRevision',
  'expectedPlanGeneration',
  'ownerAuthority',
  'ownerGeneration',
  'ownerSessionId',
  'restoreGeneration',
  'mountGeneration',
  'ownerEffectFence',
  'authorityEvidence',
  'deadlineAtMs',
] as const;

export function parseHostedLifecycleRunReservationInput(
  value: unknown
): HostedLifecycleRunReservationInput {
  const input = exactPublicationRecord(value, INPUT_KEYS);
  const fence = exactPublicationRecord(input.ownerEffectFence, [
    'grantRevision',
    'identityChecksum',
  ]);
  const evidence = exactPublicationRecord(input.authorityEvidence, [
    'userId',
    'sessionId',
    'grantGeneration',
  ]);
  if (
    input.schemaVersion !== 1 ||
    typeof input.commandId !== 'string' ||
    !COMMAND.test(input.commandId) ||
    typeof input.idempotencyKey !== 'string' ||
    !IDEMPOTENCY.test(input.idempotencyKey) ||
    typeof input.expectedPlanGeneration !== 'string' ||
    !/^plan-generation_[a-f0-9]{64}$/.test(input.expectedPlanGeneration) ||
    typeof input.ownerAuthority !== 'string' ||
    !OWNER_AUTHORITY.test(input.ownerAuthority) ||
    typeof input.ownerSessionId !== 'string' ||
    !OWNER_SESSION.test(input.ownerSessionId) ||
    !Number.isSafeInteger(input.ownerGeneration) ||
    (input.ownerGeneration as number) < 1 ||
    !Number.isSafeInteger(input.restoreGeneration) ||
    (input.restoreGeneration as number) < 0 ||
    !Number.isSafeInteger(input.mountGeneration) ||
    (input.mountGeneration as number) < 1 ||
    !Number.isSafeInteger(input.deadlineAtMs) ||
    (input.deadlineAtMs as number) < 1 ||
    typeof fence.grantRevision !== 'string' ||
    !SHA.test(fence.grantRevision) ||
    typeof fence.identityChecksum !== 'string' ||
    !SHA.test(fence.identityChecksum) ||
    typeof evidence.userId !== 'string' ||
    !USER_OR_SESSION.test(evidence.userId) ||
    typeof evidence.sessionId !== 'string' ||
    !USER_OR_SESSION.test(evidence.sessionId) ||
    !Number.isSafeInteger(evidence.grantGeneration) ||
    (evidence.grantGeneration as number) < 0 ||
    evidence.grantGeneration !== input.restoreGeneration
  ) {
    throw new TypeError('hosted-run-reservation-input-invalid');
  }
  return Object.freeze({
    schemaVersion: 1,
    workspaceId: parseWorkspaceId(input.workspaceId),
    runtimeWorkspaceId: parseWorkspaceId(input.runtimeWorkspaceId),
    teamId: parseTeamId(input.teamId),
    actorId: parseActorId(input.actorId),
    deploymentId: parseDeploymentId(input.deploymentId),
    bootId: parseBootId(input.bootId),
    commandId: input.commandId,
    idempotencyKey: input.idempotencyKey,
    expectedRevision: parseRevision(input.expectedRevision),
    expectedPlanGeneration: input.expectedPlanGeneration,
    ownerAuthority: input.ownerAuthority,
    ownerGeneration: input.ownerGeneration as number,
    ownerSessionId: input.ownerSessionId,
    restoreGeneration: input.restoreGeneration as number,
    mountGeneration: input.mountGeneration as number,
    ownerEffectFence: Object.freeze({
      grantRevision: fence.grantRevision,
      identityChecksum: fence.identityChecksum,
    }),
    authorityEvidence: Object.freeze({
      userId: evidence.userId,
      sessionId: evidence.sessionId,
      grantGeneration: evidence.grantGeneration as number,
    }),
    deadlineAtMs: input.deadlineAtMs as number,
  });
}

export function parseHostedLifecycleRunReservation(value: unknown): HostedLifecycleRunReservation {
  const record = exactPublicationRecord(value, [
    ...INPUT_KEYS.filter((key) => key !== 'deadlineAtMs'),
    'runId',
    'promotionOperationId',
    'planSha256',
    'rosterBindingSha256',
    'createdAtMs',
  ]);
  const inputValue = Object.fromEntries(
    INPUT_KEYS.filter((key) => key !== 'deadlineAtMs').map((key) => [key, record[key]])
  );
  const { deadlineAtMs: ignored, ...input } = parseHostedLifecycleRunReservationInput({
    ...inputValue,
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
  });
  void ignored;
  if (
    typeof record.planSha256 !== 'string' ||
    !SHA.test(record.planSha256) ||
    typeof record.rosterBindingSha256 !== 'string' ||
    !SHA.test(record.rosterBindingSha256) ||
    record.expectedPlanGeneration !== `plan-generation_${record.planSha256}` ||
    !Number.isSafeInteger(record.createdAtMs) ||
    (record.createdAtMs as number) < 0
  ) {
    throw new TypeError('hosted-run-reservation-record-invalid');
  }
  return Object.freeze({
    ...input,
    runId: parseRunId(record.runId),
    promotionOperationId: promotionOperationId(record.promotionOperationId),
    planSha256: record.planSha256,
    rosterBindingSha256: record.rosterBindingSha256,
    createdAtMs: record.createdAtMs as number,
  });
}

export function parseHostedLifecycleRunReservationResult(
  value: unknown
): HostedLifecycleRunReservationResult {
  const result = exactPublicationRecord(
    value,
    (value as { kind?: unknown })?.kind === 'reserved' ||
      (value as { kind?: unknown })?.kind === 'idempotent_replay'
      ? ['kind', 'reservation']
      : ['kind', 'reason']
  );
  if (result.kind === 'reserved' || result.kind === 'idempotent_replay') {
    return {
      kind: result.kind,
      reservation: parseHostedLifecycleRunReservation(result.reservation),
    };
  }
  if (
    result.kind === 'conflict' &&
    (result.reason === 'binding_mismatch' || result.reason === 'resource_claimed')
  ) {
    return { kind: result.kind, reason: result.reason };
  }
  if (
    result.kind === 'unavailable' &&
    (result.reason === 'promotion_missing' ||
      result.reason === 'legacy_frozen_without_binding' ||
      result.reason === 'authority_changed')
  ) {
    return { kind: result.kind, reason: result.reason };
  }
  throw new TypeError('hosted-run-reservation-result-invalid');
}
