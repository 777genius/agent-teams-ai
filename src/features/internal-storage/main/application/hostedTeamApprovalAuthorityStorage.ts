import { RUNTIME_PERMISSION_APPROVAL_SUMMARY_MAXIMUM_BYTES } from '@features/team-runtime-control/contracts';
import {
  parseActorId,
  parseSessionId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';

import type {
  HostedTeamApprovalAuthorityScope,
  HostedTeamApprovalDecisionStorageRequest,
  HostedTeamApprovalDeliveryAcknowledgeRequest,
  HostedTeamApprovalDeliveryClaimRequest,
  HostedTeamApprovalDeliveryRecord,
  HostedTeamApprovalObservationReceipt,
  HostedTeamApprovalPendingReadRecord,
  HostedTeamApprovalPendingReadRequest,
  HostedTeamApprovalPendingReadResult,
  HostedTeamApprovalPendingStorageRecord,
  HostedTeamApprovalPreviewReadRequest,
  HostedTeamApprovalPreviewReadResult,
  HostedTeamApprovalPreviewStorageRecord,
  HostedTeamApprovalStorageDecision,
  HostedTeamApprovalTimeoutAuditRequest,
} from '../../contracts/hostedTeamApprovalAuthorityStorageContracts';

export {
  hashHostedTeamApprovalDecision,
  hashHostedTeamApprovalGeneration,
  hashHostedTeamApprovalIdentity,
  hashHostedTeamApprovalTimeout,
  parseHostedTeamApprovalDecisionStorageResult,
  parseHostedTeamApprovalDeliveryReconciliationReadResult,
  parseHostedTeamApprovalTimeoutAuditResult,
  parseHostedTeamApprovalVoidResult,
  serializeHostedTeamApprovalDeliveryIntent,
} from './hostedTeamApprovalAuthorityStorageOutputs';

const MAX_PREVIEW_BYTES = 64 * 1024;
const MAX_DELIVERY_BATCH = 50;
const MAX_DELIVERY_LEASE_MS = 5 * 60 * 1000;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_IDEMPOTENCY_KEY_LENGTH = 128;
const MAX_PAYLOAD_HASH_LENGTH = 64;
const APPROVAL_ID = /^approval_[0-9a-f]{32}$/;
const GENERATION = /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/;
const PREVIEW_REF = /^approval_preview_[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/;
const IDEMPOTENCY_KEY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const AUDIT_ID = /^approval_audit_[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/;
const DELIVERY_ID = /^approval_delivery_[A-Za-z0-9][A-Za-z0-9._-]{0,231}$/;
const DELIVERY_REF = /^delivery_ref_[A-Za-z0-9][A-Za-z0-9._-]{0,239}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const CATEGORIES = new Set(['file_change', 'command', 'network', 'other']);
const STORED_DECISIONS = new Set<HostedTeamApprovalStorageDecision>(['allow', 'deny', 'timeout']);
const HOST_PATH =
  /(?:^|[\s"'`(])(?:~[\\/]|[A-Za-z]:[\\/]|\/(?:Users|home|var|tmp|etc|private|mnt|Volumes|opt)\/)/;

type UnknownRecord = Record<PropertyKey, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactRecord(value: unknown, keys: readonly string[], label: string): UnknownRecord {
  if (!isRecord(value)) throw new TypeError(`${label}-invalid`);
  const ownKeys = Reflect.ownKeys(value);
  if (
    ownKeys.length !== keys.length ||
    ownKeys.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
    !keys.every((key) => Object.hasOwn(value, key))
  ) {
    throw new TypeError(`${label}-invalid`);
  }
  return value;
}

function finiteNonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) {
    throw new TypeError(`${label}-invalid`);
  }
  return value as number;
}

function positive(value: unknown, label: string): number {
  const parsed = finiteNonNegative(value, label);
  if (parsed < 1) throw new TypeError(`${label}-invalid`);
  return parsed;
}

function identifier(value: unknown, label: string, maximum = MAX_IDENTIFIER_LENGTH): string {
  if (
    typeof value !== 'string' ||
    value.length < 1 ||
    new TextEncoder().encode(value).byteLength > maximum ||
    value.trim() !== value ||
    value.includes('\0') ||
    HOST_PATH.test(value)
  ) {
    throw new TypeError(`${label}-invalid`);
  }
  return value;
}

function safeText(
  value: unknown,
  label: string,
  maximum: number,
  allowNewlines: boolean,
  allowEmpty = false
): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length < 1) ||
    new TextEncoder().encode(value).byteLength > maximum ||
    HOST_PATH.test(value)
  ) {
    throw new TypeError(`${label}-invalid`);
  }
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    const allowed = codePoint === 9 || (allowNewlines && (codePoint === 10 || codePoint === 13));
    if ((codePoint <= 31 && !allowed) || codePoint === 127) {
      throw new TypeError(`${label}-invalid`);
    }
  }
  return value;
}

function approvalId(value: unknown): string {
  if (typeof value !== 'string' || !APPROVAL_ID.test(value)) {
    throw new TypeError('hosted-team-approval-storage-approval-id-invalid');
  }
  return value;
}

function generation(value: unknown, label: string): string {
  if (typeof value !== 'string' || !GENERATION.test(value)) {
    throw new TypeError(`${label}-invalid`);
  }
  return value;
}

function storedDecision(value: unknown): HostedTeamApprovalStorageDecision {
  if (!STORED_DECISIONS.has(value as HostedTeamApprovalStorageDecision)) {
    throw new TypeError('hosted-team-approval-storage-decision-invalid');
  }
  return value as HostedTeamApprovalStorageDecision;
}

function browserDecision(value: unknown): 'allow' | 'deny' {
  if (value !== 'allow' && value !== 'deny') {
    throw new TypeError('hosted-team-approval-storage-decision-invalid');
  }
  return value;
}

function previewRef(value: unknown): string {
  if (typeof value !== 'string' || !PREVIEW_REF.test(value)) {
    throw new TypeError('hosted-team-approval-storage-preview-ref-invalid');
  }
  return value;
}

function payloadHash(value: unknown): string {
  if (
    typeof value !== 'string' ||
    value.length !== MAX_PAYLOAD_HASH_LENGTH ||
    !SHA256.test(value)
  ) {
    throw new TypeError('hosted-team-approval-storage-payload-hash-invalid');
  }
  return value;
}

export function parseHostedTeamApprovalAuthorityScope(
  value: unknown
): HostedTeamApprovalAuthorityScope {
  const input = exactRecord(
    value,
    ['principalId', 'workspaceId', 'teamId', 'authorityGeneration', 'restoreGeneration'],
    'hosted-team-approval-storage-scope'
  );
  return Object.freeze({
    principalId: parseActorId(input.principalId),
    workspaceId: parseWorkspaceId(input.workspaceId),
    teamId: parseTeamId(input.teamId),
    authorityGeneration: generation(
      input.authorityGeneration,
      'hosted-team-approval-storage-authority-generation'
    ),
    restoreGeneration: finiteNonNegative(
      input.restoreGeneration,
      'hosted-team-approval-storage-restore-generation'
    ),
  });
}

export function parseHostedTeamApprovalPreviewStorageRecord(
  value: unknown
): HostedTeamApprovalPreviewStorageRecord {
  const input = exactRecord(
    value,
    ['previewRef', 'content', 'byteLength', 'truncated', 'isBinary'],
    'hosted-team-approval-storage-preview'
  );
  const content = safeText(
    input.content,
    'hosted-team-approval-storage-preview-content',
    MAX_PREVIEW_BYTES,
    true,
    true
  );
  const byteLength = finiteNonNegative(
    input.byteLength,
    'hosted-team-approval-storage-preview-byte-length'
  );
  if (
    byteLength > MAX_PREVIEW_BYTES ||
    typeof input.truncated !== 'boolean' ||
    typeof input.isBinary !== 'boolean' ||
    new TextEncoder().encode(content).byteLength > byteLength ||
    (input.isBinary && content !== '')
  ) {
    throw new TypeError('hosted-team-approval-storage-preview-invalid');
  }
  return Object.freeze({
    previewRef: previewRef(input.previewRef),
    content,
    byteLength,
    truncated: input.truncated,
    isBinary: input.isBinary,
  });
}

export function parseHostedTeamApprovalPendingStorageRecord(
  value: unknown
): HostedTeamApprovalPendingStorageRecord {
  const input = exactRecord(
    value,
    [
      'scope',
      'runId',
      'requestId',
      'approvalId',
      'approvalGeneration',
      'category',
      'summary',
      'requestedAtMs',
      'expiresAtMs',
      'preview',
      'deliveryRef',
      'observedAtMs',
      'deadlineAtMs',
    ],
    'hosted-team-approval-storage-pending'
  );
  const requestedAtMs = finiteNonNegative(
    input.requestedAtMs,
    'hosted-team-approval-storage-requested-at'
  );
  const expiresAtMs =
    input.expiresAtMs === null
      ? null
      : finiteNonNegative(input.expiresAtMs, 'hosted-team-approval-storage-expires-at');
  if (
    (expiresAtMs !== null && expiresAtMs <= requestedAtMs) ||
    !Number.isSafeInteger(input.observedAtMs) ||
    (input.observedAtMs as number) < requestedAtMs ||
    !CATEGORIES.has(input.category as string) ||
    typeof input.deliveryRef !== 'string' ||
    !DELIVERY_REF.test(input.deliveryRef)
  ) {
    throw new TypeError('hosted-team-approval-storage-pending-invalid');
  }
  return Object.freeze({
    scope: parseHostedTeamApprovalAuthorityScope(input.scope),
    runId: identifier(input.runId, 'hosted-team-approval-storage-run-id'),
    requestId: identifier(input.requestId, 'hosted-team-approval-storage-request-id'),
    approvalId: approvalId(input.approvalId),
    approvalGeneration: generation(
      input.approvalGeneration,
      'hosted-team-approval-storage-approval-generation'
    ),
    category: input.category as HostedTeamApprovalPendingStorageRecord['category'],
    summary: safeText(
      input.summary,
      'hosted-team-approval-storage-summary',
      RUNTIME_PERMISSION_APPROVAL_SUMMARY_MAXIMUM_BYTES,
      false
    ),
    requestedAtMs,
    expiresAtMs,
    preview:
      input.preview === null ? null : parseHostedTeamApprovalPreviewStorageRecord(input.preview),
    deliveryRef: input.deliveryRef,
    observedAtMs: finiteNonNegative(input.observedAtMs, 'hosted-team-approval-storage-observed-at'),
    deadlineAtMs: positive(input.deadlineAtMs, 'hosted-team-approval-storage-deadline'),
  });
}

export function parseHostedTeamApprovalPendingReadRequest(
  value: unknown
): HostedTeamApprovalPendingReadRequest {
  const input = exactRecord(
    value,
    [
      'scope',
      'expectedRunId',
      'afterApprovalId',
      'afterApprovalGenerationHash',
      'limit',
      'deadlineAtMs',
    ],
    'hosted-team-approval-storage-pending-read-request'
  );
  const limit = positive(input.limit, 'hosted-team-approval-storage-pending-read-limit');
  const afterApprovalId = input.afterApprovalId === null ? null : approvalId(input.afterApprovalId);
  const afterApprovalGenerationHash =
    input.afterApprovalGenerationHash === null
      ? null
      : payloadHash(input.afterApprovalGenerationHash);
  if (
    limit > MAX_DELIVERY_BATCH + 1 ||
    (afterApprovalId === null) !== (afterApprovalGenerationHash === null)
  ) {
    throw new TypeError('hosted-team-approval-storage-pending-read-limit-invalid');
  }
  return Object.freeze({
    scope: parseHostedTeamApprovalAuthorityScope(input.scope),
    expectedRunId: identifier(input.expectedRunId, 'hosted-team-approval-storage-run-id'),
    afterApprovalId,
    afterApprovalGenerationHash,
    limit,
    deadlineAtMs: positive(input.deadlineAtMs, 'hosted-team-approval-storage-deadline'),
  });
}

export function parseHostedTeamApprovalPendingReadRecord(
  value: unknown
): HostedTeamApprovalPendingReadRecord {
  const input = exactRecord(
    value,
    [
      'runId',
      'requestId',
      'approvalId',
      'approvalGeneration',
      'category',
      'summary',
      'requestedAtMs',
      'expiresAtMs',
      'previewRef',
    ],
    'hosted-team-approval-storage-pending-read-record'
  );
  const requestedAtMs = finiteNonNegative(
    input.requestedAtMs,
    'hosted-team-approval-storage-requested-at'
  );
  const expiresAtMs =
    input.expiresAtMs === null
      ? null
      : finiteNonNegative(input.expiresAtMs, 'hosted-team-approval-storage-expires-at');
  if (
    (expiresAtMs !== null && expiresAtMs <= requestedAtMs) ||
    !CATEGORIES.has(input.category as string)
  ) {
    throw new TypeError('hosted-team-approval-storage-pending-read-record-invalid');
  }
  return Object.freeze({
    runId: identifier(input.runId, 'hosted-team-approval-storage-run-id'),
    requestId: identifier(input.requestId, 'hosted-team-approval-storage-request-id'),
    approvalId: approvalId(input.approvalId),
    approvalGeneration: generation(
      input.approvalGeneration,
      'hosted-team-approval-storage-approval-generation'
    ),
    category: input.category as HostedTeamApprovalPendingReadRecord['category'],
    summary: safeText(
      input.summary,
      'hosted-team-approval-storage-summary',
      RUNTIME_PERMISSION_APPROVAL_SUMMARY_MAXIMUM_BYTES,
      false
    ),
    requestedAtMs,
    expiresAtMs,
    previewRef: input.previewRef === null ? null : previewRef(input.previewRef),
  });
}

export function parseHostedTeamApprovalObservationReceipt(
  value: unknown
): HostedTeamApprovalObservationReceipt {
  if (
    !isRecord(value) ||
    Reflect.ownKeys(value).length !== 10 ||
    !Object.hasOwn(value, 'deliveryRef') ||
    typeof value.deliveryRef !== 'string' ||
    !DELIVERY_REF.test(value.deliveryRef)
  ) {
    throw new TypeError('hosted-team-approval-storage-observation-receipt-invalid');
  }
  const { deliveryRef, ...pending } = value;
  return Object.freeze({ ...parseHostedTeamApprovalPendingReadRecord(pending), deliveryRef });
}

export function parseHostedTeamApprovalPendingReadResult(
  value: unknown
): HostedTeamApprovalPendingReadResult {
  const input = exactRecord(
    value,
    ['records', 'hasMore'],
    'hosted-team-approval-storage-pending-read-result'
  );
  if (
    !Array.isArray(input.records) ||
    input.records.length > MAX_DELIVERY_BATCH + 1 ||
    typeof input.hasMore !== 'boolean'
  ) {
    throw new TypeError('hosted-team-approval-storage-pending-read-result-invalid');
  }
  const records = input.records.map(parseHostedTeamApprovalPendingReadRecord);
  const ids = new Set(records.map((record) => record.approvalId));
  if (ids.size !== records.length) {
    throw new TypeError('hosted-team-approval-storage-pending-read-result-invalid');
  }
  return Object.freeze({ records: Object.freeze(records), hasMore: input.hasMore });
}

export function parseHostedTeamApprovalPreviewReadRequest(
  value: unknown
): HostedTeamApprovalPreviewReadRequest {
  const input = exactRecord(
    value,
    [
      'scope',
      'expectedRunId',
      'approvalId',
      'expectedApprovalGeneration',
      'previewRef',
      'deadlineAtMs',
    ],
    'hosted-team-approval-storage-preview-read-request'
  );
  return Object.freeze({
    scope: parseHostedTeamApprovalAuthorityScope(input.scope),
    expectedRunId: identifier(input.expectedRunId, 'hosted-team-approval-storage-run-id'),
    approvalId: approvalId(input.approvalId),
    expectedApprovalGeneration: generation(
      input.expectedApprovalGeneration,
      'hosted-team-approval-storage-approval-generation'
    ),
    previewRef: previewRef(input.previewRef),
    deadlineAtMs: positive(input.deadlineAtMs, 'hosted-team-approval-storage-deadline'),
  });
}

export function parseHostedTeamApprovalPreviewReadResult(
  value: unknown
): HostedTeamApprovalPreviewReadResult {
  if (!isRecord(value)) {
    throw new TypeError('hosted-team-approval-storage-preview-read-result-invalid');
  }
  const input = exactRecord(
    value,
    Object.hasOwn(value, 'kind') && value.kind === 'found'
      ? ['kind', 'preview']
      : Object.hasOwn(value, 'kind') && value.kind === 'stale_generation'
        ? ['kind', 'currentApprovalGeneration']
        : ['kind'],
    'hosted-team-approval-storage-preview-read-result'
  );
  if (input.kind === 'found') {
    return Object.freeze({
      kind: 'found',
      preview: parseHostedTeamApprovalPreviewStorageRecord(input.preview),
    });
  }
  if (input.kind === 'stale_generation') {
    return Object.freeze({
      kind: 'stale_generation',
      currentApprovalGeneration: generation(
        input.currentApprovalGeneration,
        'hosted-team-approval-storage-approval-generation'
      ),
    });
  }
  if (input.kind === 'not_found') return Object.freeze({ kind: 'not_found' });
  throw new TypeError('hosted-team-approval-storage-preview-read-result-invalid');
}

export function parseHostedTeamApprovalDecisionStorageRequest(
  value: unknown
): HostedTeamApprovalDecisionStorageRequest {
  const input = exactRecord(
    value,
    [
      'scope',
      'expectedRunId',
      'approvalId',
      'expectedApprovalGeneration',
      'idempotencyKey',
      'decision',
      'payloadHash',
      'audit',
      'delivery',
      'deadlineAtMs',
    ],
    'hosted-team-approval-storage-decision-request'
  );
  if (
    typeof input.idempotencyKey !== 'string' ||
    input.idempotencyKey.length > MAX_IDEMPOTENCY_KEY_LENGTH ||
    !IDEMPOTENCY_KEY.test(input.idempotencyKey)
  ) {
    throw new TypeError('hosted-team-approval-storage-idempotency-key-invalid');
  }
  const scope = parseHostedTeamApprovalAuthorityScope(input.scope);
  const audit = exactRecord(
    input.audit,
    ['auditId', 'principalId', 'sessionId'],
    'hosted-team-approval-storage-audit'
  );
  if (
    typeof audit.auditId !== 'string' ||
    !AUDIT_ID.test(audit.auditId) ||
    audit.principalId !== scope.principalId
  ) {
    throw new TypeError('hosted-team-approval-storage-audit-invalid');
  }
  const delivery = exactRecord(
    input.delivery,
    ['deliveryId'],
    'hosted-team-approval-storage-delivery'
  );
  if (typeof delivery.deliveryId !== 'string' || !DELIVERY_ID.test(delivery.deliveryId)) {
    throw new TypeError('hosted-team-approval-storage-delivery-invalid');
  }
  return Object.freeze({
    scope,
    expectedRunId: identifier(input.expectedRunId, 'hosted-team-approval-storage-run-id'),
    approvalId: approvalId(input.approvalId),
    expectedApprovalGeneration: generation(
      input.expectedApprovalGeneration,
      'hosted-team-approval-storage-approval-generation'
    ),
    idempotencyKey: input.idempotencyKey,
    decision: browserDecision(input.decision),
    payloadHash: payloadHash(input.payloadHash),
    audit: Object.freeze({
      auditId: audit.auditId,
      principalId: scope.principalId,
      sessionId: parseSessionId(audit.sessionId),
    }),
    delivery: Object.freeze({
      deliveryId: delivery.deliveryId,
    }),
    deadlineAtMs: positive(input.deadlineAtMs, 'hosted-team-approval-storage-deadline'),
  });
}

export function parseHostedTeamApprovalDeliveryClaimRequest(
  value: unknown
): HostedTeamApprovalDeliveryClaimRequest {
  const input = exactRecord(
    value,
    [
      'workspaceId',
      'teamId',
      'authorityGeneration',
      'restoreGeneration',
      'ownerId',
      'leaseToken',
      'leaseDurationMs',
      'limit',
      'deadlineAtMs',
    ],
    'hosted-team-approval-storage-delivery-claim-request'
  );
  const leaseDurationMs = positive(
    input.leaseDurationMs,
    'hosted-team-approval-storage-delivery-lease-duration'
  );
  const limit = positive(input.limit, 'hosted-team-approval-storage-delivery-limit');
  if (leaseDurationMs > MAX_DELIVERY_LEASE_MS || limit > MAX_DELIVERY_BATCH) {
    throw new TypeError('hosted-team-approval-storage-delivery-claim-request-invalid');
  }
  return Object.freeze({
    workspaceId: parseWorkspaceId(input.workspaceId),
    teamId: parseTeamId(input.teamId),
    authorityGeneration: generation(
      input.authorityGeneration,
      'hosted-team-approval-storage-authority-generation'
    ),
    restoreGeneration: finiteNonNegative(
      input.restoreGeneration,
      'hosted-team-approval-storage-restore-generation'
    ),
    ownerId: identifier(input.ownerId, 'hosted-team-approval-storage-delivery-owner'),
    leaseToken: identifier(input.leaseToken, 'hosted-team-approval-storage-delivery-lease-token'),
    leaseDurationMs,
    limit,
    deadlineAtMs: positive(input.deadlineAtMs, 'hosted-team-approval-storage-deadline'),
  });
}

export function parseHostedTeamApprovalDeliveryRecord(
  value: unknown
): HostedTeamApprovalDeliveryRecord {
  const input = exactRecord(
    value,
    [
      'deliveryId',
      'principal',
      'workspaceId',
      'authorityGeneration',
      'restoreGeneration',
      'partition',
      'requestId',
      'approvalId',
      'approvalGeneration',
      'decision',
      'payloadHash',
      'deliveryRef',
      'deliveryGeneration',
      'ownerId',
      'leaseToken',
      'claimedAtMs',
      'leaseExpiresAtMs',
      'createdAtMs',
    ],
    'hosted-team-approval-storage-delivery-record'
  );
  if (
    typeof input.deliveryId !== 'string' ||
    !DELIVERY_ID.test(input.deliveryId) ||
    typeof input.deliveryRef !== 'string' ||
    !DELIVERY_REF.test(input.deliveryRef)
  ) {
    throw new TypeError('hosted-team-approval-storage-delivery-record-invalid');
  }
  const claimedAtMs = finiteNonNegative(
    input.claimedAtMs,
    'hosted-team-approval-storage-delivery-claimed-at'
  );
  const leaseExpiresAtMs = positive(
    input.leaseExpiresAtMs,
    'hosted-team-approval-storage-delivery-lease-expires-at'
  );
  if (leaseExpiresAtMs <= claimedAtMs) {
    throw new TypeError('hosted-team-approval-storage-delivery-record-invalid');
  }
  return Object.freeze({
    deliveryId: input.deliveryId,
    principal: parseDeliveryPrincipal(input.principal, input.decision),
    workspaceId: parseWorkspaceId(input.workspaceId),
    authorityGeneration: generation(
      input.authorityGeneration,
      'hosted-team-approval-storage-authority-generation'
    ),
    restoreGeneration: finiteNonNegative(
      input.restoreGeneration,
      'hosted-team-approval-storage-restore-generation'
    ),
    partition: (() => {
      const partition = exactRecord(
        input.partition,
        ['teamId', 'runId'],
        'hosted-team-approval-storage-delivery-partition'
      );
      return Object.freeze({
        teamId: identifier(partition.teamId, 'hosted-team-approval-storage-team-id'),
        runId: identifier(partition.runId, 'hosted-team-approval-storage-run-id'),
      });
    })(),
    requestId: identifier(input.requestId, 'hosted-team-approval-storage-request-id'),
    approvalId: approvalId(input.approvalId),
    approvalGeneration: generation(
      input.approvalGeneration,
      'hosted-team-approval-storage-approval-generation'
    ),
    decision: storedDecision(input.decision),
    payloadHash: payloadHash(input.payloadHash),
    deliveryRef: input.deliveryRef,
    deliveryGeneration: positive(
      input.deliveryGeneration,
      'hosted-team-approval-storage-delivery-generation'
    ),
    ownerId: identifier(input.ownerId, 'hosted-team-approval-storage-delivery-owner'),
    leaseToken: identifier(input.leaseToken, 'hosted-team-approval-storage-delivery-lease-token'),
    claimedAtMs,
    leaseExpiresAtMs,
    createdAtMs: finiteNonNegative(
      input.createdAtMs,
      'hosted-team-approval-storage-delivery-created-at'
    ),
  });
}

function parseDeliveryPrincipal(
  value: unknown,
  decision: unknown
): HostedTeamApprovalDeliveryRecord['principal'] {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('hosted-team-approval-storage-principal-invalid');
  }
  const principal = value as Record<string, unknown>;
  if (
    principal.kind === 'operator' &&
    Object.keys(principal).length === 2 &&
    Object.hasOwn(principal, 'actorId') &&
    decision !== 'timeout'
  ) {
    return Object.freeze({ kind: 'operator', actorId: parseActorId(principal.actorId) });
  }
  if (
    principal.kind === 'system_timeout' &&
    Object.keys(principal).length === 1 &&
    decision === 'timeout'
  ) {
    return Object.freeze({ kind: 'system_timeout' });
  }
  throw new TypeError('hosted-team-approval-storage-principal-invalid');
}

export function parseHostedTeamApprovalDeliveryAcknowledgeRequest(
  value: unknown
): HostedTeamApprovalDeliveryAcknowledgeRequest {
  const input = exactRecord(
    value,
    [
      'workspaceId',
      'authorityGeneration',
      'restoreGeneration',
      'partition',
      'deliveryId',
      'deliveryGeneration',
      'ownerId',
      'leaseToken',
      'deadlineAtMs',
    ],
    'hosted-team-approval-storage-delivery-acknowledge-request'
  );
  if (typeof input.deliveryId !== 'string' || !DELIVERY_ID.test(input.deliveryId)) {
    throw new TypeError('hosted-team-approval-storage-delivery-acknowledge-request-invalid');
  }
  return Object.freeze({
    workspaceId: parseWorkspaceId(input.workspaceId),
    authorityGeneration: generation(
      input.authorityGeneration,
      'hosted-team-approval-storage-authority-generation'
    ),
    restoreGeneration: finiteNonNegative(
      input.restoreGeneration,
      'hosted-team-approval-storage-restore-generation'
    ),
    partition: (() => {
      const partition = exactRecord(
        input.partition,
        ['teamId', 'runId'],
        'hosted-team-approval-storage-delivery-partition'
      );
      return Object.freeze({
        teamId: identifier(partition.teamId, 'hosted-team-approval-storage-team-id'),
        runId: identifier(partition.runId, 'hosted-team-approval-storage-run-id'),
      });
    })(),
    deliveryId: input.deliveryId,
    deliveryGeneration: positive(
      input.deliveryGeneration,
      'hosted-team-approval-storage-delivery-generation'
    ),
    ownerId: identifier(input.ownerId, 'hosted-team-approval-storage-delivery-owner'),
    leaseToken: identifier(input.leaseToken, 'hosted-team-approval-storage-delivery-lease-token'),
    deadlineAtMs: positive(input.deadlineAtMs, 'hosted-team-approval-storage-deadline'),
  });
}

export function parseHostedTeamApprovalTimeoutAuditRequest(
  value: unknown
): HostedTeamApprovalTimeoutAuditRequest {
  const input = exactRecord(
    value,
    ['nextAuditTimeMs', 'deadlineAtMs'],
    'hosted-team-approval-storage-timeout-audit-request'
  );
  return Object.freeze({
    nextAuditTimeMs: finiteNonNegative(
      input.nextAuditTimeMs,
      'hosted-team-approval-storage-next-audit-time'
    ),
    deadlineAtMs: positive(input.deadlineAtMs, 'hosted-team-approval-storage-deadline'),
  });
}

export {
  parseHostedTeamApprovalDeliveryOperatorRequiredRequest,
  parseHostedTeamApprovalDeliveryReconciliationRequest,
  parseHostedTeamApprovalDeliveryReconciliationSettleRequest,
} from './hostedTeamApprovalDeliveryReconciliationValidation';
