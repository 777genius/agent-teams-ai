import { createHash } from 'node:crypto';

import {
  hashHostedTeamApprovalTimeout,
  serializeHostedTeamApprovalDeliveryIntent,
} from '../../application/hostedTeamApprovalAuthorityStorage';

import type { HostedTeamApprovalAuthorityScope } from '../../../contracts/hostedTeamApprovalAuthorityStorageContracts';
import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;
type UnknownRow = Record<string, unknown>;

function scopeFromRow(row: UnknownRow): HostedTeamApprovalAuthorityScope {
  return {
    principalId: row.principal_id as string,
    workspaceId: row.workspace_id as string,
    teamId: row.team_id as string,
    authorityGeneration: row.authority_generation as string,
    restoreGeneration: row.restore_generation as number,
  };
}

const scopeParameters = (scope: HostedTeamApprovalAuthorityScope): readonly unknown[] => [
  scope.principalId,
  scope.workspaceId,
  scope.teamId,
  scope.authorityGeneration,
  scope.restoreGeneration,
];

function timeoutIdentity(row: UnknownRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        principalId: row.principal_id,
        workspaceId: row.workspace_id,
        teamId: row.team_id,
        authorityGeneration: row.authority_generation,
        restoreGeneration: row.restore_generation,
        approvalId: row.approval_id,
        approvalGeneration: row.approval_generation,
        expiresAtMs: row.expires_at_ms,
        deliveryRef: row.delivery_ref,
      })
    )
    .digest('hex');
}

/**
 * Resolves every due approval in one caller-owned transaction. Reads and outbox claims invoke this
 * sweep, so expiry is persisted even when no browser is mounted or submits a late decision.
 */
export function expireHostedTeamApprovals(input: {
  readonly db: SqliteDatabase;
  readonly scope?: HostedTeamApprovalAuthorityScope;
  readonly nowMs: number;
  readonly approvalId?: string;
  readonly approvalGeneration?: string;
}): number {
  const rows = input.db
    .prepare(
      `SELECT principal_id, workspace_id, team_id, authority_generation, restore_generation,
              approval_id, approval_generation, delivery_ref, payload_hash, revision, expires_at_ms
       FROM hosted_team_approval_records
       WHERE ${input.scope === undefined ? '' : 'principal_id = ? AND workspace_id = ? AND team_id = ? AND authority_generation = ? AND restore_generation = ? AND'}
         state = 'pending' AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?
         ${input.approvalId === undefined ? '' : 'AND approval_id = ? AND approval_generation = ?'}
       ORDER BY expires_at_ms ASC, approval_id ASC`
    )
    .all(
      ...(input.scope === undefined ? [] : scopeParameters(input.scope)),
      input.nowMs,
      ...(input.approvalId === undefined ? [] : [input.approvalId, input.approvalGeneration])
    ) as UnknownRow[];
  let expired = 0;
  for (const row of rows) {
    if (
      typeof row.approval_id !== 'string' ||
      typeof row.approval_generation !== 'string' ||
      typeof row.delivery_ref !== 'string' ||
      typeof row.payload_hash !== 'string' ||
      !Number.isSafeInteger(row.revision) ||
      !Number.isSafeInteger(row.expires_at_ms)
    ) {
      throw new Error('hosted-team-approval-storage-timeout-record-invalid');
    }
    const identity = timeoutIdentity(row);
    const payloadHash = hashHostedTeamApprovalTimeout(row.payload_hash);
    const scope = scopeFromRow(row);
    const latest = input.db
      .prepare(
        `SELECT MAX(occurred_at_ms) AS occurred_at_ms
         FROM hosted_team_approval_audit
         WHERE principal_id = ? AND workspace_id = ? AND team_id = ?
           AND authority_generation = ? AND restore_generation = ?`
      )
      .get(...scopeParameters(scope)) as { readonly occurred_at_ms: unknown } | undefined;
    const previous = latest?.occurred_at_ms;
    if (previous !== null && previous !== undefined && !Number.isSafeInteger(previous)) {
      throw new Error('hosted-team-approval-storage-timeout-chronology-invalid');
    }
    const occurredAtMs = Math.max(
      input.nowMs,
      row.expires_at_ms as number,
      previous === null || previous === undefined ? 0 : (previous as number) + 1
    );
    const update = input.db
      .prepare(
        `UPDATE hosted_team_approval_records
         SET state = 'resolved', decision = 'timeout', revision = revision + 1,
             resolved_at_ms = ?, last_idempotency_key = NULL
         WHERE principal_id = ? AND workspace_id = ? AND team_id = ?
           AND authority_generation = ? AND restore_generation = ?
           AND approval_id = ? AND approval_generation = ?
           AND state = 'pending' AND revision = ? AND expires_at_ms <= ?`
      )
      .run(
        occurredAtMs,
        ...scopeParameters(scope),
        row.approval_id,
        row.approval_generation,
        row.revision,
        occurredAtMs
      );
    if (update.changes !== 1) continue;
    const auditId = `approval_audit_timeout-${identity}`;
    const deliveryId = `approval_delivery_timeout-${identity}`;
    input.db
      .prepare(
        `INSERT INTO hosted_team_approval_audit (
          audit_id, principal_id, workspace_id, team_id, authority_generation, restore_generation,
          approval_id, approval_generation, decision, payload_hash, actor_id, session_id,
          occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'timeout', ?, 'system:approval-timeout', ?, ?)`
      )
      .run(
        auditId,
        ...scopeParameters(scope),
        row.approval_id,
        row.approval_generation,
        payloadHash,
        `session_approval-timeout-${identity}`,
        occurredAtMs
      );
    input.db
      .prepare(
        `INSERT INTO hosted_team_approval_delivery_outbox (
          delivery_id, principal_id, workspace_id, team_id, authority_generation, restore_generation,
          approval_id, approval_generation, decision, payload_hash, delivery_ref, intent_json,
          state, delivery_generation, delivery_owner_id, delivery_lease_token,
          delivery_claimed_at_ms, delivery_lease_expires_at_ms, delivered_at_ms, created_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'timeout', ?, ?, ?, 'pending', 0,
          NULL, NULL, NULL, NULL, NULL, ?)`
      )
      .run(
        deliveryId,
        ...scopeParameters(scope),
        row.approval_id,
        row.approval_generation,
        payloadHash,
        row.delivery_ref,
        serializeHostedTeamApprovalDeliveryIntent({
          scope,
          approvalId: row.approval_id,
          approvalGeneration: row.approval_generation,
          decision: 'timeout',
          payloadHash,
          deliveryId,
          deliveryRef: row.delivery_ref,
        }),
        occurredAtMs
      );
    expired += 1;
  }
  return expired;
}
