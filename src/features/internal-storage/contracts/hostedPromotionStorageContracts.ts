import { parseRevision, parseWorkspaceId } from '@shared/contracts/hosted';

import {
  exactPublicationRecord,
  parseTeamDraftPublicationScope,
} from './teamDraftPublicationContracts';
import { parseTeamAdoptionIntentId } from './teamIdentityStorageContracts';

import type { HostedPromotionRosterBindingReadResult } from './hostedPromotionRosterBindingContracts';
import type { TeamDraftPublicationScope } from './teamDraftPublicationContracts';
import type { Revision, WorkspaceId } from '@shared/contracts/hosted';

/** Internal host conversation. None of these inputs constitutes HTTP authority. */
export interface HostedPromotionBinding extends TeamDraftPublicationScope {
  readonly createOperationId: string;
  readonly runtimeWorkspaceId: WorkspaceId;
  readonly bindingGeneration: number;
  readonly expectedRevision: Revision;
  readonly idempotencyKey: string;
}
export interface HostedPromotionBegin extends HostedPromotionBinding {
  readonly admittedWorkspaceRoot: string;
  readonly deadlineAtMs: number;
  /** Server captured evidence, checked again under SQLite IMMEDIATE by the production worker. */
  readonly authorityEvidence?: Readonly<{
    userId: string;
    sessionId: string;
    grantRevision: string;
    grantGeneration: number;
  }>;
}
export interface HostedPromotionLookup extends TeamDraftPublicationScope {
  readonly reference: { readonly operationId: string } | { readonly idempotencyKey: string };
}
/** Private recovery record: never serialize this object to a browser. */
export interface HostedPromotionRecord extends HostedPromotionBinding {
  readonly operationId: string;
  readonly admittedWorkspaceRoot: string;
  readonly frozenRosterJson: string;
  readonly frozenDraftJson: string;
  readonly laneIds: readonly string[];
  readonly planJson: string;
  readonly planSha256: string;
  readonly planGeneration: string;
  readonly createdAtMs: number;
  readonly state: 'frozen';
}
export type HostedPromotionBeginResult =
  | { readonly kind: 'frozen'; readonly operation: HostedPromotionRecord }
  | {
      readonly kind: 'conflict';
      readonly reason: 'binding_mismatch' | 'revision_mismatch' | 'operation_mismatch';
    }
  | {
      readonly kind: 'unavailable';
      readonly reason:
        | 'configuration_missing'
        | 'publication_missing'
        | 'manual_approval_unavailable'
        | 'unsupported_lane'
        | 'legacy_frozen_without_binding';
    };
export interface HostedPromotionStorageGateway {
  begin(
    input: HostedPromotionBegin,
    options: { readonly signal: AbortSignal }
  ): Promise<HostedPromotionBeginResult>;
  lookup(input: HostedPromotionLookup): Promise<HostedPromotionRecord | null>;
  lookupRosterBinding(
    input: HostedPromotionLookup
  ): Promise<HostedPromotionRosterBindingReadResult>;
}

const KEYS = [
  'workspaceId',
  'teamId',
  'actorId',
  'deploymentId',
  'createOperationId',
  'runtimeWorkspaceId',
  'bindingGeneration',
  'expectedRevision',
  'idempotencyKey',
] as const;
export function promotionKey(value: unknown): string {
  if (typeof value !== 'string' || !/^idempotency_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(value)) {
    throw new TypeError('promotion-key-invalid');
  }
  return value;
}
export function promotionOperationId(value: unknown): string {
  if (typeof value !== 'string' || !/^promotion_[a-f0-9]{32}$/.test(value))
    throw new TypeError('promotion-id-invalid');
  return value;
}
export function parseHostedPromotionBegin(value: unknown): HostedPromotionBegin {
  const raw = value as Record<string, unknown>;
  const hasEvidence =
    raw !== null && typeof raw === 'object' && Object.hasOwn(raw, 'authorityEvidence');
  const input = exactPublicationRecord(value, [
    ...KEYS,
    'admittedWorkspaceRoot',
    'deadlineAtMs',
    ...(hasEvidence ? ['authorityEvidence'] : []),
  ]);
  const { workspaceId, teamId, actorId, deploymentId } = input;
  if (
    !Number.isSafeInteger(input.bindingGeneration) ||
    (input.bindingGeneration as number) < 1 ||
    !Number.isSafeInteger(input.deadlineAtMs) ||
    (input.deadlineAtMs as number) < 1 ||
    typeof input.admittedWorkspaceRoot !== 'string' ||
    !input.admittedWorkspaceRoot.startsWith('/') ||
    input.admittedWorkspaceRoot.includes('\0') ||
    input.admittedWorkspaceRoot.length > 4096
  ) {
    throw new TypeError('promotion-host-input-invalid');
  }
  return {
    ...parseTeamDraftPublicationScope({ workspaceId, teamId, actorId, deploymentId }),
    createOperationId: parseTeamAdoptionIntentId(input.createOperationId),
    runtimeWorkspaceId: parseWorkspaceId(input.runtimeWorkspaceId),
    bindingGeneration: input.bindingGeneration as number,
    expectedRevision: parseRevision(input.expectedRevision),
    idempotencyKey: promotionKey(input.idempotencyKey),
    admittedWorkspaceRoot: input.admittedWorkspaceRoot,
    deadlineAtMs: input.deadlineAtMs as number,
    ...(hasEvidence ? { authorityEvidence: parseAuthorityEvidence(input.authorityEvidence) } : {}),
  };
}

function parseAuthorityEvidence(
  value: unknown
): NonNullable<HostedPromotionBegin['authorityEvidence']> {
  const input = exactPublicationRecord(value, [
    'userId',
    'sessionId',
    'grantRevision',
    'grantGeneration',
  ]);
  if (
    typeof input.userId !== 'string' ||
    !/^[a-z][a-z0-9-]*_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(input.userId) ||
    typeof input.sessionId !== 'string' ||
    !/^[a-z][a-z0-9-]*_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/.test(input.sessionId) ||
    typeof input.grantRevision !== 'string' ||
    !/^[a-f0-9]{64}$/.test(input.grantRevision) ||
    !Number.isSafeInteger(input.grantGeneration) ||
    (input.grantGeneration as number) < 0
  ) {
    throw new TypeError('promotion-authority-evidence-invalid');
  }
  return {
    userId: input.userId,
    sessionId: input.sessionId,
    grantRevision: input.grantRevision,
    grantGeneration: input.grantGeneration as number,
  };
}
export function parseHostedPromotionLookup(value: unknown): HostedPromotionLookup {
  const input = exactPublicationRecord(value, [
    'workspaceId',
    'teamId',
    'actorId',
    'deploymentId',
    'reference',
  ]);
  const { workspaceId, teamId, actorId, deploymentId } = input;
  const byOperation =
    !!input.reference &&
    typeof input.reference === 'object' &&
    Object.hasOwn(input.reference, 'operationId');
  const reference = exactPublicationRecord(input.reference, [
    byOperation ? 'operationId' : 'idempotencyKey',
  ]);
  return {
    ...parseTeamDraftPublicationScope({ workspaceId, teamId, actorId, deploymentId }),
    reference: byOperation
      ? { operationId: promotionOperationId(reference.operationId) }
      : { idempotencyKey: promotionKey(reference.idempotencyKey) },
  };
}

export function parseHostedPromotionRecord(value: unknown): HostedPromotionRecord {
  const input = exactPublicationRecord(value, [
    ...KEYS,
    'operationId',
    'admittedWorkspaceRoot',
    'frozenRosterJson',
    'frozenDraftJson',
    'laneIds',
    'planJson',
    'planSha256',
    'planGeneration',
    'createdAtMs',
    'state',
  ]);
  const {
    operationId,
    frozenRosterJson,
    frozenDraftJson,
    laneIds,
    planJson,
    planSha256,
    planGeneration,
    createdAtMs,
    state,
    ...binding
  } = input;
  const { deadlineAtMs: ignored, ...parsed } = parseHostedPromotionBegin({
    ...binding,
    deadlineAtMs: Number.MAX_SAFE_INTEGER,
  });
  void ignored;
  if (
    state !== 'frozen' ||
    !Number.isSafeInteger(createdAtMs) ||
    (createdAtMs as number) < 0 ||
    typeof planSha256 !== 'string' ||
    !/^[a-f0-9]{64}$/.test(planSha256) ||
    planGeneration !== `plan-generation_${planSha256}` ||
    !Array.isArray(laneIds) ||
    laneIds.length < 1 ||
    laneIds.length > 32 ||
    Reflect.ownKeys(laneIds).length !== laneIds.length + 1 ||
    Array.from({ length: laneIds.length }, (_, index) => index).some(
      (index) => !Object.hasOwn(laneIds, index)
    ) ||
    laneIds.some((id) => typeof id !== 'string' || !/^lane_[a-f0-9]{32}$/.test(id)) ||
    new Set(laneIds).size !== laneIds.length
  ) {
    throw new TypeError('promotion-record-invalid');
  }
  const bounded = (text: unknown, limit: number): string => {
    if (typeof text !== 'string' || new TextEncoder().encode(text).length > limit)
      throw new TypeError('promotion-record-bytes-invalid');
    return text;
  };
  return {
    ...parsed,
    operationId: promotionOperationId(operationId),
    state,
    laneIds: Object.freeze([...laneIds]) as readonly string[],
    createdAtMs: createdAtMs as number,
    frozenRosterJson: bounded(frozenRosterJson, 256 * 1024),
    frozenDraftJson: bounded(frozenDraftJson, 256 * 1024),
    planJson: bounded(planJson, 256 * 1024),
    planSha256,
    planGeneration,
  };
}

export function parseHostedPromotionBeginResult(value: unknown): HostedPromotionBeginResult {
  if (!value || typeof value !== 'object') throw new TypeError('promotion-result-invalid');
  if ('kind' in value && value.kind === 'frozen') {
    const input = exactPublicationRecord(value, ['kind', 'operation']);
    return { kind: 'frozen', operation: parseHostedPromotionRecord(input.operation) };
  }
  const input = exactPublicationRecord(value, ['kind', 'reason']);
  if (
    input.kind === 'conflict' &&
    (input.reason === 'binding_mismatch' ||
      input.reason === 'revision_mismatch' ||
      input.reason === 'operation_mismatch')
  ) {
    return { kind: input.kind, reason: input.reason };
  }
  if (
    input.kind === 'unavailable' &&
    (input.reason === 'configuration_missing' ||
      input.reason === 'publication_missing' ||
      input.reason === 'manual_approval_unavailable' ||
      input.reason === 'unsupported_lane' ||
      input.reason === 'legacy_frozen_without_binding')
  ) {
    return { kind: input.kind, reason: input.reason };
  }
  throw new TypeError('promotion-result-invalid');
}
