import {
  hashHostedTeamApprovalDecision,
  hashHostedTeamApprovalGeneration,
  hashHostedTeamApprovalIdentity,
  parseHostedTeamApprovalDecisionStorageRequest,
  parseHostedTeamApprovalDeliveryAcknowledgeRequest,
  parseHostedTeamApprovalDeliveryClaimRequest,
  parseHostedTeamApprovalPendingReadRequest,
  parseHostedTeamApprovalPendingReadResult,
  parseHostedTeamApprovalPendingStorageRecord,
  parseHostedTeamApprovalPreviewReadRequest,
  parseHostedTeamApprovalTimeoutAuditRequest,
  serializeHostedTeamApprovalDeliveryIntent,
} from '../../application/hostedTeamApprovalAuthorityStorage';

import { assertInternalStorageMutationAdmissionOpen } from './coordinationDurabilityWorkerOps';
import {
  assertDeadlineOpen,
  DELIVERY_COLUMNS,
  deliveryRecordFromRow,
  isDecision,
  isNonNegativeInteger,
  isPositiveInteger,
  nextAuditTime,
  pendingRecordFromRow,
  previewFromRow,
  readRecord,
  readReplacementGeneration,
  RECORD_COLUMNS,
  scopeParameters,
  type SqliteDatabase,
  type UnknownRow,
} from './hostedTeamApprovalAuthorityStorageSupport';
import {
  markHostedTeamApprovalDeliveryOperatorRequired,
  readHostedTeamApprovalDeliveryReconciliation,
  settleHostedTeamApprovalDeliveryReconciliation,
} from './hostedTeamApprovalDeliveryReconciliationStorageOps';
import { expireHostedTeamApprovals } from './hostedTeamApprovalTimeoutStorageOps';

import type {
  HostedTeamApprovalDecisionStorageResult,
  HostedTeamApprovalDeliveryRecord,
  HostedTeamApprovalPendingReadRecord,
  HostedTeamApprovalPreviewReadResult,
} from '../../../contracts/hostedTeamApprovalAuthorityStorageContracts';

export type HostedTeamApprovalAuthorityWorkerOp =
  | 'hostedTeamApprovalAuthority.observe'
  | 'hostedTeamApprovalAuthority.readPending'
  | 'hostedTeamApprovalAuthority.readPreview'
  | 'hostedTeamApprovalAuthority.decide'
  | 'hostedTeamApprovalAuthority.claimDeliveries'
  | 'hostedTeamApprovalAuthority.acknowledgeDelivery'
  | 'hostedTeamApprovalAuthority.markDeliveryOperatorRequired'
  | 'hostedTeamApprovalAuthority.readDeliveryReconciliation'
  | 'hostedTeamApprovalAuthority.settleDeliveryReconciliation'
  | 'hostedTeamApprovalAuthority.auditTimeouts';
/** External orchestrator invokes durable ingress/outbox; this never launches, owns, or invokes a runtime. */
export class HostedTeamApprovalAuthorityStorageOps {
  constructor(
    private readonly getDatabase: () => SqliteDatabase,
    private readonly storageNow: () => number = Date.now
  ) {}

  handle(op: HostedTeamApprovalAuthorityWorkerOp, payload: unknown): unknown {
    switch (op) {
      case 'hostedTeamApprovalAuthority.observe':
        return this.observe(payload);
      case 'hostedTeamApprovalAuthority.readPending':
        return this.readPending(payload);
      case 'hostedTeamApprovalAuthority.readPreview':
        return this.readPreview(payload);
      case 'hostedTeamApprovalAuthority.decide':
        return this.decide(payload);
      case 'hostedTeamApprovalAuthority.claimDeliveries':
        return this.claimDeliveries(payload);
      case 'hostedTeamApprovalAuthority.acknowledgeDelivery':
        this.acknowledgeDelivery(payload);
        return undefined;
      case 'hostedTeamApprovalAuthority.markDeliveryOperatorRequired':
        markHostedTeamApprovalDeliveryOperatorRequired(
          this.getDatabase(),
          payload,
          this.storageNow
        );
        return undefined;
      case 'hostedTeamApprovalAuthority.readDeliveryReconciliation':
        return readHostedTeamApprovalDeliveryReconciliation(
          this.getDatabase(),
          payload,
          this.storageNow
        );
      case 'hostedTeamApprovalAuthority.settleDeliveryReconciliation':
        settleHostedTeamApprovalDeliveryReconciliation(
          this.getDatabase(),
          payload,
          this.storageNow
        );
        return undefined;
      case 'hostedTeamApprovalAuthority.auditTimeouts':
        return this.auditTimeouts(payload);
    }
  }

  private observe(value: unknown): HostedTeamApprovalPendingReadRecord {
    const input = parseHostedTeamApprovalPendingStorageRecord(value);
    assertDeadlineOpen(input.deadlineAtMs);
    const db = this.getDatabase();
    return db
      .transaction(() => {
        assertDeadlineOpen(input.deadlineAtMs);
        assertInternalStorageMutationAdmissionOpen(db, null);
        const observedAtMs = this.nowMs();
        if (input.observedAtMs > observedAtMs) {
          throw new Error('hosted-team-approval-storage-observation-time-invalid');
        }
        const identityHash = hashHostedTeamApprovalIdentity(input);
        const existing = db
          .prepare(
            `SELECT ${RECORD_COLUMNS} FROM hosted_team_approval_records
             WHERE workspace_id = ? AND team_id = ? AND authority_generation = ?
               AND restore_generation = ? AND run_id = ? AND request_id = ?`
          )
          .get(...scopeParameters(input.scope), input.runId, input.requestId) as
          | UnknownRow
          | undefined;
        if (existing) {
          if (
            existing.approval_id !== input.approvalId ||
            existing.approval_generation !== input.approvalGeneration
          ) {
            throw new Error('hosted-team-approval-storage-observation-identity-conflict');
          }
          if (existing.state !== 'pending') {
            throw new Error('hosted-team-approval-storage-observation-generation-stale');
          }
          if (existing.payload_hash !== identityHash) {
            throw new Error('hosted-team-approval-storage-observation-identity-conflict');
          }
          return pendingRecordFromRow(existing);
        }
        const derivedIdentity = db
          .prepare(
            `SELECT request_id, approval_generation
             FROM hosted_team_approval_records
             WHERE workspace_id = ? AND team_id = ? AND authority_generation = ?
               AND restore_generation = ? AND run_id = ? AND approval_id = ?`
          )
          .get(...scopeParameters(input.scope), input.runId, input.approvalId) as
          | UnknownRow
          | undefined;
        if (derivedIdentity) {
          throw new Error('hosted-team-approval-storage-observation-identity-conflict');
        }
        db.prepare(
          `INSERT INTO hosted_team_approval_records (
            workspace_id, team_id, authority_generation, restore_generation,
            run_id, request_id, approval_id, approval_generation,
            category, summary, requested_at_ms, expires_at_ms,
            preview_ref, preview_content, preview_byte_length, preview_truncated, preview_is_binary,
            delivery_ref, state, decision, revision, observed_at_ms, resolved_at_ms,
            last_idempotency_key, payload_hash
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
                    'pending', NULL, 1, ?, NULL, NULL, ?)`
        ).run(
          ...scopeParameters(input.scope),
          input.runId,
          input.requestId,
          input.approvalId,
          input.approvalGeneration,
          input.category,
          input.summary,
          input.requestedAtMs,
          input.expiresAtMs,
          input.preview?.previewRef ?? null,
          input.preview?.content ?? null,
          input.preview?.byteLength ?? null,
          input.preview === null ? null : input.preview.truncated ? 1 : 0,
          input.preview === null ? null : input.preview.isBinary ? 1 : 0,
          input.deliveryRef,
          input.observedAtMs,
          identityHash
        );
        assertDeadlineOpen(input.deadlineAtMs);
        const row = db
          .prepare(
            `SELECT ${RECORD_COLUMNS}
             FROM hosted_team_approval_records
             WHERE workspace_id = ? AND team_id = ? AND authority_generation = ?
               AND restore_generation = ? AND run_id = ? AND request_id = ?`
          )
          .get(...scopeParameters(input.scope), input.runId, input.requestId) as
          | UnknownRow
          | undefined;
        if (!row) throw new Error('hosted-team-approval-storage-observe-missing');
        return pendingRecordFromRow(row);
      })
      .immediate();
  }

  private readPending(value: unknown): ReturnType<typeof parseHostedTeamApprovalPendingReadResult> {
    const input = parseHostedTeamApprovalPendingReadRequest(value);
    assertDeadlineOpen(input.deadlineAtMs);
    const db = this.getDatabase();
    return db
      .transaction(() => {
        assertInternalStorageMutationAdmissionOpen(db, null);
        expireHostedTeamApprovals({
          db,
          scope: input.scope,
          expectedRunId: input.expectedRunId,
          nowMs: this.nowMs(),
        });
        if (input.afterApprovalId !== null && input.afterApprovalGenerationHash !== null) {
          const cursor = db
            .prepare(
              `SELECT approval_generation
             FROM hosted_team_approval_records
             WHERE workspace_id = ? AND team_id = ? AND authority_generation = ?
               AND restore_generation = ? AND run_id = ? AND approval_id = ? AND state = 'pending'`
            )
            .get(...scopeParameters(input.scope), input.expectedRunId, input.afterApprovalId) as
            | { readonly approval_generation: unknown }
            | undefined;
          if (
            typeof cursor?.approval_generation !== 'string' ||
            hashHostedTeamApprovalGeneration(cursor.approval_generation) !==
              input.afterApprovalGenerationHash
          ) {
            throw new Error('hosted-team-approval-storage-pending-cursor-stale');
          }
        }
        const rows = db
          .prepare(
            `SELECT ${RECORD_COLUMNS}
           FROM hosted_team_approval_records
           WHERE workspace_id = ? AND team_id = ? AND authority_generation = ?
             AND restore_generation = ? AND run_id = ? AND state = 'pending'
             AND (expires_at_ms IS NULL OR expires_at_ms > ?)
             AND (? IS NULL OR approval_id > ?)
           ORDER BY approval_id ASC
           LIMIT ?`
          )
          .all(
            ...scopeParameters(input.scope),
            input.expectedRunId,
            this.nowMs(),
            input.afterApprovalId,
            input.afterApprovalId,
            input.limit + 1
          ) as UnknownRow[];
        assertDeadlineOpen(input.deadlineAtMs);
        return parseHostedTeamApprovalPendingReadResult({
          records: rows.slice(0, input.limit).map(pendingRecordFromRow),
          hasMore: rows.length > input.limit,
        });
      })
      .immediate();
  }

  private readPreview(value: unknown): HostedTeamApprovalPreviewReadResult {
    const input = parseHostedTeamApprovalPreviewReadRequest(value);
    assertDeadlineOpen(input.deadlineAtMs);
    const db = this.getDatabase();
    db.transaction(() => {
      assertInternalStorageMutationAdmissionOpen(db, null);
      expireHostedTeamApprovals({
        db,
        scope: input.scope,
        expectedRunId: input.expectedRunId,
        nowMs: this.nowMs(),
        approvalId: input.approvalId,
        approvalGeneration: input.expectedApprovalGeneration,
      });
    }).immediate();
    const current = db
      .prepare(
        `SELECT ${RECORD_COLUMNS}
         FROM hosted_team_approval_records
         WHERE workspace_id = ? AND team_id = ? AND authority_generation = ?
           AND restore_generation = ? AND run_id = ?
           AND approval_id = ? AND approval_generation = ? AND state = 'pending'`
      )
      .get(
        ...scopeParameters(input.scope),
        input.expectedRunId,
        input.approvalId,
        input.expectedApprovalGeneration
      ) as UnknownRow | undefined;
    if (current) {
      assertDeadlineOpen(input.deadlineAtMs);
      return current.preview_ref === input.previewRef
        ? previewFromRow(current)
        : Object.freeze({ kind: 'not_found' });
    }
    const replacement = readReplacementGeneration(
      db,
      input.scope,
      input.expectedRunId,
      input.approvalId,
      input.expectedApprovalGeneration
    );
    assertDeadlineOpen(input.deadlineAtMs);
    if (replacement !== null) {
      return {
        kind: 'stale_generation',
        currentApprovalGeneration: replacement,
      };
    }
    return Object.freeze({ kind: 'not_found' });
  }

  private decide(value: unknown): HostedTeamApprovalDecisionStorageResult {
    const input = parseHostedTeamApprovalDecisionStorageRequest(value);
    assertDeadlineOpen(input.deadlineAtMs);
    const db = this.getDatabase();
    return db
      .transaction(() => {
        assertDeadlineOpen(input.deadlineAtMs);
        assertInternalStorageMutationAdmissionOpen(db, null);
        expireHostedTeamApprovals({
          db,
          scope: input.scope,
          expectedRunId: input.expectedRunId,
          nowMs: this.nowMs(),
          approvalId: input.approvalId,
          approvalGeneration: input.expectedApprovalGeneration,
        });
        const record = readRecord(
          db,
          input.scope,
          input.expectedRunId,
          input.approvalId,
          input.expectedApprovalGeneration
        );
        if (!record) {
          const replacement = readReplacementGeneration(
            db,
            input.scope,
            input.expectedRunId,
            input.approvalId,
            input.expectedApprovalGeneration
          );
          return replacement === null
            ? Object.freeze({ kind: 'not_found' as const })
            : Object.freeze({
                kind: 'stale_generation' as const,
                currentApprovalGeneration: replacement,
              });
        }
        if (
          typeof record.payload_hash !== 'string' ||
          !/^[a-f0-9]{64}$/.test(record.payload_hash)
        ) {
          throw new Error('hosted-team-approval-storage-approval-identity-invalid');
        }
        const payloadHash = hashHostedTeamApprovalDecision(input.payloadHash, record.payload_hash);

        const idempotency = db
          .prepare(
            `SELECT approval_id, approval_generation, decision, payload_hash, revision
             FROM hosted_team_approval_idempotency
             WHERE workspace_id = ? AND team_id = ? AND authority_generation = ?
               AND restore_generation = ? AND run_id = ? AND idempotency_key = ?`
          )
          .get(...scopeParameters(input.scope), input.expectedRunId, input.idempotencyKey) as
          | UnknownRow
          | undefined;
        if (idempotency) {
          if (
            idempotency.approval_id !== input.approvalId ||
            idempotency.approval_generation !== input.expectedApprovalGeneration ||
            idempotency.decision !== input.decision ||
            idempotency.payload_hash !== payloadHash
          ) {
            return Object.freeze({
              kind: 'conflict' as const,
              reason: 'idempotency_mismatch' as const,
            });
          }
          if (!isPositiveInteger(idempotency.revision)) {
            throw new Error('hosted-team-approval-storage-revision-invalid');
          }
          return Object.freeze({
            kind: 'idempotent_replay' as const,
            receipt: {
              approvalGeneration: input.expectedApprovalGeneration,
              decision: input.decision,
              revision: idempotency.revision,
            },
          });
        }

        if (record.state === 'resolved' && record.decision === 'timeout') {
          return Object.freeze({ kind: 'expired' as const });
        }
        if (
          record.state !== 'pending' ||
          (typeof record.decision !== 'undefined' && record.decision !== null)
        ) {
          if (typeof record.approval_generation !== 'string' || !isDecision(record.decision)) {
            throw new Error('hosted-team-approval-storage-resolved-record-invalid');
          }
          return Object.freeze({
            kind: 'already_resolved' as const,
            approvalGeneration: record.approval_generation,
            decision: record.decision,
          });
        }
        const revision = record.revision;
        if (!isPositiveInteger(revision)) {
          throw new Error('hosted-team-approval-storage-revision-invalid');
        }
        const nextRevision = revision + 1;
        const occurredAtMs = nextAuditTime(db, input.scope, record, this.nowMs());
        const update = db
          .prepare(
            `UPDATE hosted_team_approval_records
             SET state = 'resolved', decision = ?, revision = ?, resolved_at_ms = ?,
                 last_idempotency_key = ?
             WHERE workspace_id = ? AND team_id = ? AND authority_generation = ?
               AND restore_generation = ? AND run_id = ?
               AND approval_id = ? AND approval_generation = ?
               AND state = 'pending' AND revision = ?`
          )
          .run(
            input.decision,
            nextRevision,
            occurredAtMs,
            input.idempotencyKey,
            ...scopeParameters(input.scope),
            input.expectedRunId,
            input.approvalId,
            input.expectedApprovalGeneration,
            revision
          );
        if (update.changes !== 1) {
          throw new Error('hosted-team-approval-storage-decision-cas-lost');
        }

        const deliveryRef = record.delivery_ref;
        if (typeof deliveryRef !== 'string') {
          throw new Error('hosted-team-approval-storage-delivery-reference-invalid');
        }
        const intentJson = serializeHostedTeamApprovalDeliveryIntent({
          partition: { teamId: input.scope.teamId, runId: input.expectedRunId },
          requestId: record.request_id as string,
          approvalId: input.approvalId,
          approvalGeneration: input.expectedApprovalGeneration,
          decision: input.decision,
          payloadHash,
          deliveryId: input.delivery.deliveryId,
          principal: { kind: 'operator', actorId: input.audit.principalId },
          deliveryRef,
        });
        db.prepare(
          `INSERT INTO hosted_team_approval_audit (
            audit_id, workspace_id, team_id, authority_generation, restore_generation,
            run_id, request_id, approval_id, approval_generation,
            decision, payload_hash, actor_id, session_id, occurred_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          input.audit.auditId,
          ...scopeParameters(input.scope),
          input.expectedRunId,
          record.request_id,
          input.approvalId,
          input.expectedApprovalGeneration,
          input.decision,
          payloadHash,
          input.audit.principalId,
          input.audit.sessionId,
          occurredAtMs
        );
        db.prepare(
          `INSERT INTO hosted_team_approval_delivery_outbox (
            delivery_id, principal_id, workspace_id, team_id, authority_generation,
            restore_generation, run_id, request_id, approval_id, approval_generation,
            decision, payload_hash, delivery_ref, intent_json,
            state, delivery_generation, delivery_owner_id, delivery_lease_token, delivery_claimed_at_ms,
            delivery_lease_expires_at_ms, delivered_at_ms, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, NULL, NULL, NULL, NULL, ?)`
        ).run(
          input.delivery.deliveryId,
          JSON.stringify({ kind: 'operator', actorId: input.audit.principalId }),
          ...scopeParameters(input.scope),
          input.expectedRunId,
          record.request_id,
          input.approvalId,
          input.expectedApprovalGeneration,
          input.decision,
          payloadHash,
          deliveryRef,
          intentJson,
          occurredAtMs
        );
        db.prepare(
          `INSERT INTO hosted_team_approval_idempotency (
            workspace_id, team_id, authority_generation, restore_generation,
            run_id, idempotency_key, request_id, approval_id,
            approval_generation, decision, payload_hash, revision,
            audit_id, delivery_id, created_at_ms
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          ...scopeParameters(input.scope),
          input.expectedRunId,
          input.idempotencyKey,
          record.request_id,
          input.approvalId,
          input.expectedApprovalGeneration,
          input.decision,
          payloadHash,
          nextRevision,
          input.audit.auditId,
          input.delivery.deliveryId,
          occurredAtMs
        );
        assertDeadlineOpen(input.deadlineAtMs);
        return Object.freeze({
          kind: 'committed' as const,
          receipt: {
            approvalGeneration: input.expectedApprovalGeneration,
            decision: input.decision,
            revision: nextRevision,
          },
        });
      })
      .immediate();
  }

  private claimDeliveries(value: unknown): readonly HostedTeamApprovalDeliveryRecord[] {
    const input = parseHostedTeamApprovalDeliveryClaimRequest(value);
    assertDeadlineOpen(input.deadlineAtMs);
    const db = this.getDatabase();
    return db
      .transaction(() => {
        assertDeadlineOpen(input.deadlineAtMs);
        assertInternalStorageMutationAdmissionOpen(db, null);
        const claimedAtMs = this.nowMs();
        expireHostedTeamApprovals({ db, nowMs: claimedAtMs });
        const leaseExpiresAtMs = claimedAtMs + input.leaseDurationMs;
        if (!Number.isSafeInteger(leaseExpiresAtMs)) {
          throw new Error('hosted-team-approval-storage-delivery-lease-invalid');
        }
        const candidates = db
          .prepare(
            `SELECT ${DELIVERY_COLUMNS}
             FROM hosted_team_approval_delivery_outbox
             WHERE workspace_id = ? AND team_id = ?
               AND authority_generation = ? AND restore_generation = ?
               AND state = 'pending'
               AND (
                 (delivery_owner_id IS NULL AND delivery_lease_token IS NULL
                     AND delivery_lease_expires_at_ms IS NULL)
                 OR delivery_lease_expires_at_ms <= ?
               )
             ORDER BY created_at_ms ASC, delivery_id ASC
             LIMIT ?`
          )
          .all(
            input.workspaceId,
            input.teamId,
            input.authorityGeneration,
            input.restoreGeneration,
            claimedAtMs,
            input.limit
          ) as UnknownRow[];
        const claimed: HostedTeamApprovalDeliveryRecord[] = [];
        for (const candidate of candidates) {
          const update = db
            .prepare(
              `UPDATE hosted_team_approval_delivery_outbox
                 SET delivery_generation = delivery_generation + 1,
                     delivery_owner_id = ?, delivery_lease_token = ?,
                     delivery_claimed_at_ms = ?, delivery_lease_expires_at_ms = ?
                 WHERE delivery_id = ?
                   AND state = 'pending'
                   AND (
                     (delivery_owner_id IS NULL AND delivery_lease_token IS NULL
                      AND delivery_lease_expires_at_ms IS NULL)
                     OR delivery_lease_expires_at_ms <= ?
                   )`
            )
            .run(
              input.ownerId,
              input.leaseToken,
              claimedAtMs,
              leaseExpiresAtMs,
              candidate.delivery_id,
              claimedAtMs
            );
          if (update.changes !== 1) {
            throw new Error('hosted-team-approval-storage-delivery-claim-lost');
          }
          const row = db
            .prepare(
              `SELECT ${DELIVERY_COLUMNS}
               FROM hosted_team_approval_delivery_outbox
               WHERE delivery_id = ? AND workspace_id = ? AND authority_generation = ?
                 AND restore_generation = ?`
            )
            .get(
              candidate.delivery_id,
              input.workspaceId,
              input.authorityGeneration,
              input.restoreGeneration
            ) as UnknownRow | undefined;
          if (!row) throw new Error('hosted-team-approval-storage-delivery-missing');
          claimed.push(deliveryRecordFromRow(row, input));
        }
        assertDeadlineOpen(input.deadlineAtMs);
        return Object.freeze(claimed);
      })
      .immediate();
  }

  private acknowledgeDelivery(value: unknown): void {
    const input = parseHostedTeamApprovalDeliveryAcknowledgeRequest(value);
    assertDeadlineOpen(input.deadlineAtMs);
    const db = this.getDatabase();
    db.transaction(() => {
      assertDeadlineOpen(input.deadlineAtMs);
      assertInternalStorageMutationAdmissionOpen(db, null);
      const acknowledgedAtMs = this.nowMs();
      const row = db
        .prepare(
          `SELECT ${DELIVERY_COLUMNS}
           FROM hosted_team_approval_delivery_outbox
           WHERE delivery_id = ? AND workspace_id = ? AND authority_generation = ?
             AND restore_generation = ? AND team_id = ? AND run_id = ?`
        )
        .get(
          input.deliveryId,
          input.workspaceId,
          input.authorityGeneration,
          input.restoreGeneration,
          input.partition.teamId,
          input.partition.runId
        ) as UnknownRow | undefined;
      if (!row) throw new Error('hosted-team-approval-storage-delivery-not-found');
      const leaseMatches =
        row.delivery_generation === input.deliveryGeneration &&
        row.delivery_owner_id === input.ownerId &&
        row.delivery_lease_token === input.leaseToken;
      if (row.state === 'delivered') {
        if (!leaseMatches) throw new Error('hosted-team-approval-storage-delivery-ack-conflict');
        return;
      }
      if (
        row.state !== 'pending' ||
        !leaseMatches ||
        typeof row.delivery_lease_expires_at_ms !== 'number' ||
        row.delivery_lease_expires_at_ms <= acknowledgedAtMs
      ) {
        throw new Error('hosted-team-approval-storage-delivery-ack-conflict');
      }
      const update = db
        .prepare(
          `UPDATE hosted_team_approval_delivery_outbox
           SET state = 'delivered', delivered_at_ms = ?
           WHERE delivery_id = ?
             AND workspace_id = ? AND authority_generation = ? AND restore_generation = ?
             AND team_id = ? AND run_id = ?
             AND state = 'pending' AND delivery_generation = ?
             AND delivery_owner_id = ? AND delivery_lease_token = ?
             AND delivery_lease_expires_at_ms > ?`
        )
        .run(
          acknowledgedAtMs,
          input.deliveryId,
          input.workspaceId,
          input.authorityGeneration,
          input.restoreGeneration,
          input.partition.teamId,
          input.partition.runId,
          input.deliveryGeneration,
          input.ownerId,
          input.leaseToken,
          acknowledgedAtMs
        );
      if (update.changes !== 1) {
        throw new Error('hosted-team-approval-storage-delivery-ack-conflict');
      }
      assertDeadlineOpen(input.deadlineAtMs);
    }).immediate();
  }

  private auditTimeouts(value: unknown): {
    readonly resolvedCount: number;
    readonly nextAuditTimeMs: number | null;
  } {
    const input = parseHostedTeamApprovalTimeoutAuditRequest(value);
    assertDeadlineOpen(input.deadlineAtMs);
    const db = this.getDatabase();
    return db
      .transaction(() => {
        assertDeadlineOpen(input.deadlineAtMs);
        assertInternalStorageMutationAdmissionOpen(db, null);
        const highWater = db
          .prepare(
            `SELECT MAX(value) AS value FROM (
              SELECT MAX(observed_at_ms) AS value FROM hosted_team_approval_records
              UNION ALL SELECT MAX(resolved_at_ms) FROM hosted_team_approval_records
              UNION ALL SELECT MAX(occurred_at_ms) FROM hosted_team_approval_audit
              UNION ALL SELECT MAX(created_at_ms) FROM hosted_team_approval_delivery_outbox
              UNION ALL SELECT MAX(delivered_at_ms) FROM hosted_team_approval_delivery_outbox
              UNION ALL SELECT MAX(operator_required_at_ms) FROM hosted_team_approval_delivery_outbox
            )`
          )
          .get() as { readonly value: unknown } | undefined;
        const previous = highWater?.value;
        if (previous !== null && previous !== undefined && !isNonNegativeInteger(previous)) {
          throw new Error('hosted-team-approval-storage-chronology-invalid');
        }
        const auditTimeMs = Math.max(
          input.nextAuditTimeMs,
          this.nowMs(),
          previous === null || previous === undefined ? 0 : previous
        );
        if (!Number.isSafeInteger(auditTimeMs)) {
          throw new Error('hosted-team-approval-storage-chronology-invalid');
        }
        const resolvedCount = expireHostedTeamApprovals({ db, nowMs: auditTimeMs });
        const next = db
          .prepare(
            `SELECT MIN(expires_at_ms) AS expires_at_ms
             FROM hosted_team_approval_records
             WHERE state = 'pending' AND expires_at_ms IS NOT NULL`
          )
          .get() as { readonly expires_at_ms: unknown } | undefined;
        const nextAuditTimeMs = next?.expires_at_ms;
        if (
          nextAuditTimeMs !== null &&
          nextAuditTimeMs !== undefined &&
          (!isNonNegativeInteger(nextAuditTimeMs) || nextAuditTimeMs <= auditTimeMs)
        ) {
          throw new Error('hosted-team-approval-storage-next-audit-time-invalid');
        }
        assertDeadlineOpen(input.deadlineAtMs);
        return Object.freeze({
          resolvedCount,
          nextAuditTimeMs:
            nextAuditTimeMs === null || nextAuditTimeMs === undefined ? null : nextAuditTimeMs,
        });
      })
      .immediate();
  }

  private nowMs(): number {
    const value = this.storageNow();
    if (!isNonNegativeInteger(value)) {
      throw new Error('hosted-team-approval-storage-clock-invalid');
    }
    return value;
  }
}
