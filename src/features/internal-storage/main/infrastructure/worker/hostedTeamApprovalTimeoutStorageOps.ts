import { createHash } from 'node:crypto';

import {
  hashHostedTeamApprovalTimeout,
  serializeHostedTeamApprovalDeliveryIntent,
} from '../../application/hostedTeamApprovalAuthorityStorage';

import type { HostedTeamApprovalAuthorityScope } from '../../../contracts/hostedTeamApprovalAuthorityStorageContracts';
import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;
type UnknownRow = Record<string, unknown>;

function timeoutIdentity(row: UnknownRow): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        schemaVersion: 1,
        teamId: row.team_id,
        runId: row.run_id,
        requestId: row.request_id,
        approvalId: row.approval_id,
        approvalGeneration: row.approval_generation,
        expiresAtMs: row.expires_at_ms,
        deliveryRef: row.delivery_ref,
      })
    )
    .digest('hex');
}

/** Resolves every due approval in the caller-owned transaction. */
export function expireHostedTeamApprovals(input: {
  readonly db: SqliteDatabase;
  readonly scope?: HostedTeamApprovalAuthorityScope;
  readonly expectedRunId?: string;
  readonly nowMs: number;
  readonly approvalId?: string;
  readonly approvalGeneration?: string;
}): number {
  const rows = input.db
    .prepare(
      `SELECT workspace_id, team_id, authority_generation, restore_generation,
              run_id, request_id, approval_id, approval_generation,
              delivery_ref, payload_hash, revision, expires_at_ms
       FROM hosted_team_approval_records
       WHERE ${input.scope === undefined ? '' : 'workspace_id = ? AND team_id = ? AND authority_generation = ? AND restore_generation = ? AND'}
         ${input.expectedRunId === undefined ? '' : 'run_id = ? AND'}
         state = 'pending' AND expires_at_ms IS NOT NULL AND expires_at_ms <= ?
         ${input.approvalId === undefined ? '' : 'AND approval_id = ? AND approval_generation = ?'}
       ORDER BY expires_at_ms ASC, approval_id ASC`
    )
    .all(
      ...(input.scope === undefined
        ? []
        : [
            input.scope.workspaceId,
            input.scope.teamId,
            input.scope.authorityGeneration,
            input.scope.restoreGeneration,
          ]),
      ...(input.expectedRunId === undefined ? [] : [input.expectedRunId]),
      input.nowMs,
      ...(input.approvalId === undefined ? [] : [input.approvalId, input.approvalGeneration])
    ) as UnknownRow[];
  let expired = 0;
  for (const row of rows) {
    if (
      typeof row.team_id !== 'string' ||
      typeof row.run_id !== 'string' ||
      typeof row.request_id !== 'string' ||
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
    const latest = input.db
      .prepare(
        `SELECT MAX(occurred_at_ms) AS occurred_at_ms
         FROM hosted_team_approval_audit
         WHERE workspace_id = ? AND team_id = ? AND authority_generation = ?
           AND restore_generation = ? AND run_id = ?`
      )
      .get(
        row.workspace_id,
        row.team_id,
        row.authority_generation,
        row.restore_generation,
        row.run_id
      ) as { readonly occurred_at_ms: unknown } | undefined;
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
         WHERE workspace_id = ? AND team_id = ? AND authority_generation = ?
           AND restore_generation = ? AND run_id = ? AND request_id = ?
           AND state = 'pending' AND revision = ? AND expires_at_ms <= ?`
      )
      .run(
        occurredAtMs,
        row.workspace_id,
        row.team_id,
        row.authority_generation,
        row.restore_generation,
        row.run_id,
        row.request_id,
        row.revision,
        occurredAtMs
      );
    if (update.changes !== 1) continue;
    const auditId = `approval_audit_timeout-${identity}`;
    const deliveryId = `approval_delivery_timeout-${identity}`;
    input.db
      .prepare(
        `INSERT INTO hosted_team_approval_audit (
          audit_id, workspace_id, team_id, authority_generation, restore_generation,
          run_id, request_id, approval_id, approval_generation,
          decision, payload_hash, actor_id, session_id, occurred_at_ms
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'timeout', ?, 'system:approval-timeout', ?, ?)`
      )
      .run(
        auditId,
        row.workspace_id,
        row.team_id,
        row.authority_generation,
        row.restore_generation,
        row.run_id,
        row.request_id,
        row.approval_id,
        row.approval_generation,
        payloadHash,
        `session_approval-timeout-${identity}`,
        occurredAtMs
      );
    input.db
      .prepare(
        `INSERT INTO hosted_team_approval_delivery_outbox (
          delivery_id, principal_id, workspace_id, team_id, authority_generation,
          restore_generation, run_id, request_id, approval_id, approval_generation,
          decision, payload_hash, delivery_ref, intent_json, state, delivery_generation,
          delivery_owner_id, delivery_lease_token, delivery_claimed_at_ms,
          delivery_lease_expires_at_ms, delivered_at_ms, created_at_ms
        ) VALUES (?, '{"kind":"system_timeout"}', ?, ?, ?, ?, ?, ?, ?, ?, 'timeout', ?, ?, ?, 'pending', 0,
          NULL, NULL, NULL, NULL, NULL, ?)`
      )
      .run(
        deliveryId,
        row.workspace_id,
        row.team_id,
        row.authority_generation,
        row.restore_generation,
        row.run_id,
        row.request_id,
        row.approval_id,
        row.approval_generation,
        payloadHash,
        row.delivery_ref,
        serializeHostedTeamApprovalDeliveryIntent({
          partition: { teamId: row.team_id, runId: row.run_id },
          requestId: row.request_id,
          approvalId: row.approval_id,
          approvalGeneration: row.approval_generation,
          decision: 'timeout',
          payloadHash,
          deliveryId,
          principal: { kind: 'system_timeout' },
          deliveryRef: row.delivery_ref,
        }),
        occurredAtMs
      );
    expired += 1;
  }
  return expired;
}
