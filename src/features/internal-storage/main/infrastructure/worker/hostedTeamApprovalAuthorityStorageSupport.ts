import {
  parseHostedTeamApprovalDeliveryRecord,
  parseHostedTeamApprovalPendingReadRecord,
  parseHostedTeamApprovalPreviewStorageRecord,
} from '../../application/hostedTeamApprovalAuthorityStorage';

import type {
  HostedTeamApprovalAuthorityScope,
  HostedTeamApprovalDeliveryRecord,
  HostedTeamApprovalPendingReadRecord,
  HostedTeamApprovalPreviewReadResult,
  HostedTeamApprovalStorageDecision,
} from '../../../contracts/hostedTeamApprovalAuthorityStorageContracts';
import type DatabaseConstructor from 'better-sqlite3';

export type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;
export type UnknownRow = Record<string, unknown>;

export const RECORD_COLUMNS = `
  workspace_id, team_id, authority_generation, restore_generation,
  run_id, request_id, approval_id, approval_generation,
  category, summary, requested_at_ms, expires_at_ms,
  preview_ref, preview_content, preview_byte_length, preview_truncated, preview_is_binary,
  delivery_ref, state, decision, revision, observed_at_ms, resolved_at_ms,
  last_idempotency_key, payload_hash`;

export const DELIVERY_COLUMNS = `
  delivery_id, principal_id, workspace_id, team_id, authority_generation, restore_generation,
  run_id, request_id, approval_id, approval_generation,
  decision, payload_hash, delivery_ref, state,
  delivery_generation, delivery_owner_id, delivery_lease_token, delivery_claimed_at_ms,
  delivery_lease_expires_at_ms, delivered_at_ms, created_at_ms`;

export function assertDeadlineOpen(deadlineAtMs: number): void {
  if (!Number.isSafeInteger(deadlineAtMs) || deadlineAtMs < 1 || Date.now() >= deadlineAtMs) {
    throw new Error('hosted-team-approval-storage-deadline-expired');
  }
}

export function isNonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

export function scopeParameters(scope: HostedTeamApprovalAuthorityScope): readonly unknown[] {
  return [scope.workspaceId, scope.teamId, scope.authorityGeneration, scope.restoreGeneration];
}

function partitionFromRow(row: UnknownRow): { readonly teamId: string; readonly runId: string } {
  return {
    teamId: row.team_id as string,
    runId: row.run_id as string,
  };
}

export function pendingRecordFromRow(row: UnknownRow): HostedTeamApprovalPendingReadRecord {
  return parseHostedTeamApprovalPendingReadRecord({
    runId: row.run_id,
    requestId: row.request_id,
    approvalId: row.approval_id,
    approvalGeneration: row.approval_generation,
    category: row.category,
    summary: row.summary,
    requestedAtMs: row.requested_at_ms,
    expiresAtMs: row.expires_at_ms,
    previewRef: row.preview_ref,
  });
}

export function previewFromRow(row: UnknownRow): HostedTeamApprovalPreviewReadResult {
  if (
    typeof row.preview_ref !== 'string' ||
    typeof row.preview_content !== 'string' ||
    !Number.isSafeInteger(row.preview_byte_length) ||
    (row.preview_truncated !== 0 && row.preview_truncated !== 1) ||
    (row.preview_is_binary !== 0 && row.preview_is_binary !== 1)
  ) {
    return Object.freeze({ kind: 'not_found' });
  }
  return Object.freeze({
    kind: 'found',
    preview: parseHostedTeamApprovalPreviewStorageRecord({
      previewRef: row.preview_ref,
      content: row.preview_content,
      byteLength: row.preview_byte_length,
      truncated: row.preview_truncated === 1,
      isBinary: row.preview_is_binary === 1,
    }),
  });
}

export function deliveryRecordFromRow(
  row: UnknownRow,
  expected: { readonly ownerId: string; readonly leaseToken: string }
): HostedTeamApprovalDeliveryRecord {
  if (
    row.delivery_owner_id !== expected.ownerId ||
    row.delivery_lease_token !== expected.leaseToken ||
    row.state !== 'pending'
  ) {
    throw new Error('hosted-team-approval-storage-delivery-claim-lost');
  }
  return parseHostedTeamApprovalDeliveryRecord({
    deliveryId: row.delivery_id,
    principal: JSON.parse(row.principal_id as string) as unknown,
    workspaceId: row.workspace_id,
    authorityGeneration: row.authority_generation,
    restoreGeneration: row.restore_generation,
    partition: partitionFromRow(row),
    requestId: row.request_id,
    approvalId: row.approval_id,
    approvalGeneration: row.approval_generation,
    decision: row.decision,
    payloadHash: row.payload_hash,
    deliveryRef: row.delivery_ref,
    deliveryGeneration: row.delivery_generation,
    ownerId: row.delivery_owner_id,
    leaseToken: row.delivery_lease_token,
    claimedAtMs: row.delivery_claimed_at_ms,
    leaseExpiresAtMs: row.delivery_lease_expires_at_ms,
    createdAtMs: row.created_at_ms,
  });
}

export function readRecord(
  db: SqliteDatabase,
  scope: HostedTeamApprovalAuthorityScope,
  expectedRunId: string,
  approvalId: string,
  approvalGeneration: string
): UnknownRow | undefined {
  return db
    .prepare(
      `SELECT ${RECORD_COLUMNS}
       FROM hosted_team_approval_records
       WHERE workspace_id = ? AND team_id = ? AND authority_generation = ?
         AND restore_generation = ? AND run_id = ?
         AND approval_id = ? AND approval_generation = ?`
    )
    .get(...scopeParameters(scope), expectedRunId, approvalId, approvalGeneration) as
    | UnknownRow
    | undefined;
}

export function readReplacementGeneration(
  db: SqliteDatabase,
  scope: HostedTeamApprovalAuthorityScope,
  expectedRunId: string,
  approvalId: string,
  expectedApprovalGeneration: string
): string | null {
  const row = db
    .prepare(
      `SELECT approval_generation
       FROM hosted_team_approval_records
       WHERE workspace_id = ? AND team_id = ? AND authority_generation = ?
         AND restore_generation = ? AND run_id = ?
         AND approval_id = ? AND approval_generation <> ?
       ORDER BY CASE state WHEN 'pending' THEN 0 WHEN 'resolved' THEN 1 ELSE 2 END,
                COALESCE(resolved_at_ms, observed_at_ms) DESC
       LIMIT 1`
    )
    .get(...scopeParameters(scope), expectedRunId, approvalId, expectedApprovalGeneration) as
    | { readonly approval_generation: unknown }
    | undefined;
  return row && typeof row.approval_generation === 'string' ? row.approval_generation : null;
}

export function nextAuditTime(
  db: SqliteDatabase,
  scope: HostedTeamApprovalAuthorityScope,
  record: UnknownRow,
  nowMs: number
): number {
  if (
    !isNonNegativeInteger(record.requested_at_ms) ||
    !isNonNegativeInteger(record.observed_at_ms)
  ) {
    throw new Error('hosted-team-approval-storage-chronology-invalid');
  }
  const latest = db
    .prepare(
      `SELECT MAX(occurred_at_ms) AS occurred_at_ms
       FROM hosted_team_approval_audit
       WHERE workspace_id = ? AND team_id = ? AND authority_generation = ?
         AND restore_generation = ?`
    )
    .get(...scopeParameters(scope)) as { readonly occurred_at_ms: unknown } | undefined;
  const previous = latest?.occurred_at_ms;
  if (previous !== null && previous !== undefined && !isNonNegativeInteger(previous)) {
    throw new Error('hosted-team-approval-storage-chronology-invalid');
  }
  const occurredAtMs = Math.max(
    nowMs,
    record.requested_at_ms,
    record.observed_at_ms,
    previous === null || previous === undefined ? 0 : previous + 1
  );
  if (!Number.isSafeInteger(occurredAtMs)) {
    throw new Error('hosted-team-approval-storage-chronology-invalid');
  }
  return occurredAtMs;
}

export const isDecision = (value: unknown): value is HostedTeamApprovalStorageDecision =>
  value === 'allow' || value === 'deny' || value === 'timeout';
