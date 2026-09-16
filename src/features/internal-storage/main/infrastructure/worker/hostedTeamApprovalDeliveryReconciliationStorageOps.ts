import {
  parseHostedTeamApprovalDeliveryOperatorRequiredRequest,
  parseHostedTeamApprovalDeliveryReconciliationRequest,
  parseHostedTeamApprovalDeliveryReconciliationSettleRequest,
} from '../../application/hostedTeamApprovalAuthorityStorage';

import { assertInternalStorageMutationAdmissionOpen } from './coordinationDurabilityWorkerOps';
import {
  assertDeadlineOpen,
  isNonNegativeInteger,
  isPositiveInteger,
  type SqliteDatabase,
  type UnknownRow,
} from './hostedTeamApprovalAuthorityStorageSupport';

import type { HostedTeamApprovalDeliveryReconciliationReadResult } from '../../../contracts/hostedTeamApprovalAuthorityStorageContracts';

function nowMs(storageNow: () => number): number {
  const value = storageNow();
  if (!isNonNegativeInteger(value)) throw new Error('hosted-team-approval-storage-clock-invalid');
  return value;
}

export function markHostedTeamApprovalDeliveryOperatorRequired(
  db: SqliteDatabase,
  value: unknown,
  storageNow: () => number
): void {
  const input = parseHostedTeamApprovalDeliveryOperatorRequiredRequest(value);
  assertDeadlineOpen(input.deadlineAtMs);
  db.transaction(() => {
    assertInternalStorageMutationAdmissionOpen(db, null);
    const row = db
      .prepare(
        `SELECT state, delivery_generation, delivery_owner_id, delivery_lease_token,
              delivery_lease_expires_at_ms, approval_generation, reconciliation_ref
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
    if (
      row.state === 'operator_required' &&
      row.delivery_generation === input.deliveryGeneration + 1 &&
      row.approval_generation === input.approvalGeneration &&
      row.reconciliation_ref === input.reconciliationRef &&
      row.delivery_owner_id === input.ownerId &&
      row.delivery_lease_token === input.leaseToken
    )
      return;
    const quarantinedAtMs = nowMs(storageNow);
    const boundaryLeaseExpiresAtMs = quarantinedAtMs + input.boundaryLeaseDurationMs;
    if (!Number.isSafeInteger(boundaryLeaseExpiresAtMs)) {
      throw new Error('hosted-team-approval-storage-delivery-boundary-lease-invalid');
    }
    if (
      row.state !== 'pending' ||
      row.delivery_generation !== input.deliveryGeneration ||
      row.approval_generation !== input.approvalGeneration ||
      row.delivery_owner_id !== input.ownerId ||
      row.delivery_lease_token !== input.leaseToken ||
      !isPositiveInteger(row.delivery_lease_expires_at_ms) ||
      row.delivery_lease_expires_at_ms <= quarantinedAtMs
    )
      throw new Error('hosted-team-approval-storage-delivery-operator-required-conflict');
    const update = db
      .prepare(
        `UPDATE hosted_team_approval_delivery_outbox
       SET state = 'operator_required', reconciliation_ref = ?, operator_required_at_ms = ?,
           delivery_generation = delivery_generation + 1,
           delivery_lease_expires_at_ms = ?
       WHERE delivery_id = ? AND workspace_id = ? AND authority_generation = ?
         AND restore_generation = ? AND team_id = ? AND run_id = ? AND approval_generation = ?
         AND state = 'pending' AND delivery_generation = ? AND delivery_owner_id = ?
         AND delivery_lease_token = ? AND delivery_lease_expires_at_ms > ?`
      )
      .run(
        input.reconciliationRef,
        quarantinedAtMs,
        boundaryLeaseExpiresAtMs,
        input.deliveryId,
        input.workspaceId,
        input.authorityGeneration,
        input.restoreGeneration,
        input.partition.teamId,
        input.partition.runId,
        input.approvalGeneration,
        input.deliveryGeneration,
        input.ownerId,
        input.leaseToken,
        quarantinedAtMs
      );
    if (update.changes !== 1) {
      throw new Error('hosted-team-approval-storage-delivery-operator-required-conflict');
    }
    assertDeadlineOpen(input.deadlineAtMs);
  }).immediate();
}

export function readHostedTeamApprovalDeliveryReconciliation(
  db: SqliteDatabase,
  value: unknown,
  storageNow: () => number
): HostedTeamApprovalDeliveryReconciliationReadResult {
  const input = parseHostedTeamApprovalDeliveryReconciliationRequest(value);
  assertDeadlineOpen(input.deadlineAtMs);
  return db
    .transaction(() => {
      assertInternalStorageMutationAdmissionOpen(db, null);
      const row = db
        .prepare(
          `SELECT workspace_id, authority_generation, restore_generation, team_id, run_id,
            approval_generation, delivery_generation, state, reconciliation_ref,
            delivery_owner_id, delivery_lease_token, delivery_lease_expires_at_ms
     FROM hosted_team_approval_delivery_outbox WHERE delivery_id = ?`
        )
        .get(input.deliveryId) as UnknownRow | undefined;
      if (!row) return Object.freeze({ kind: 'not_found' });
      const exactBase =
        row.workspace_id === input.workspaceId &&
        row.authority_generation === input.authorityGeneration &&
        row.restore_generation === input.restoreGeneration &&
        row.team_id === input.partition.teamId &&
        row.run_id === input.partition.runId &&
        row.approval_generation === input.approvalGeneration &&
        row.state === 'operator_required' &&
        row.reconciliation_ref === input.reconciliationRef;
      assertDeadlineOpen(input.deadlineAtMs);
      if (!exactBase) return Object.freeze({ kind: 'stale_binding' });
      const claimedAtMs = nowMs(storageNow);
      const sameOperation =
        row.delivery_owner_id === input.ownerId && row.delivery_lease_token === input.leaseToken;
      if (
        !isPositiveInteger(row.delivery_generation) ||
        input.deliveryGeneration > row.delivery_generation
      )
        return Object.freeze({ kind: 'stale_binding' });
      if (
        isPositiveInteger(row.delivery_lease_expires_at_ms) &&
        row.delivery_lease_expires_at_ms > claimedAtMs
      ) {
        return sameOperation
          ? Object.freeze({ kind: 'claimed', deliveryGeneration: row.delivery_generation })
          : Object.freeze({ kind: 'unavailable' });
      }
      if (
        !isPositiveInteger(row.delivery_lease_expires_at_ms) ||
        row.delivery_lease_expires_at_ms > claimedAtMs
      ) {
        return Object.freeze({ kind: 'unavailable' });
      }
      const leaseExpiresAtMs = claimedAtMs + input.leaseDurationMs;
      if (!Number.isSafeInteger(leaseExpiresAtMs))
        throw new Error('hosted-team-approval-storage-reconciliation-lease-invalid');
      const update = db
        .prepare(
          `UPDATE hosted_team_approval_delivery_outbox
     SET delivery_generation = delivery_generation + 1,
         delivery_owner_id = ?, delivery_lease_token = ?, delivery_claimed_at_ms = ?,
         delivery_lease_expires_at_ms = ?
     WHERE delivery_id = ? AND workspace_id = ? AND authority_generation = ?
       AND restore_generation = ? AND team_id = ? AND run_id = ? AND approval_generation = ?
       AND state = 'operator_required' AND delivery_generation = ? AND reconciliation_ref = ?
       AND delivery_lease_expires_at_ms <= ?`
        )
        .run(
          input.ownerId,
          input.leaseToken,
          claimedAtMs,
          leaseExpiresAtMs,
          input.deliveryId,
          input.workspaceId,
          input.authorityGeneration,
          input.restoreGeneration,
          input.partition.teamId,
          input.partition.runId,
          input.approvalGeneration,
          row.delivery_generation,
          input.reconciliationRef,
          claimedAtMs
        );
      if (update.changes !== 1) return Object.freeze({ kind: 'unavailable' });
      assertDeadlineOpen(input.deadlineAtMs);
      return Object.freeze({
        kind: 'claimed',
        deliveryGeneration: row.delivery_generation + 1,
      });
    })
    .immediate();
}

export function settleHostedTeamApprovalDeliveryReconciliation(
  db: SqliteDatabase,
  value: unknown,
  storageNow: () => number
): void {
  const input = parseHostedTeamApprovalDeliveryReconciliationSettleRequest(value);
  assertDeadlineOpen(input.deadlineAtMs);
  db.transaction(() => {
    assertInternalStorageMutationAdmissionOpen(db, null);
    const stateSql =
      input.outcome === 'delivered'
        ? `state = 'delivered', delivered_at_ms = ?`
        : `state = 'pending', delivered_at_ms = NULL, reconciliation_ref = NULL,
           operator_required_at_ms = NULL`;
    const settledAtMs = nowMs(storageNow);
    const parameters = input.outcome === 'delivered' ? [settledAtMs] : [];
    const update = db
      .prepare(
        `UPDATE hosted_team_approval_delivery_outbox SET ${stateSql},
         delivery_generation = delivery_generation + 1, delivery_owner_id = NULL,
         delivery_lease_token = NULL, delivery_claimed_at_ms = NULL,
         delivery_lease_expires_at_ms = NULL
       WHERE delivery_id = ? AND workspace_id = ? AND authority_generation = ?
         AND restore_generation = ? AND team_id = ? AND run_id = ? AND approval_generation = ?
         AND state = 'operator_required' AND delivery_generation = ? AND reconciliation_ref = ?
         AND delivery_owner_id = ? AND delivery_lease_token = ?
         AND delivery_lease_expires_at_ms > ?`
      )
      .run(
        ...parameters,
        input.deliveryId,
        input.workspaceId,
        input.authorityGeneration,
        input.restoreGeneration,
        input.partition.teamId,
        input.partition.runId,
        input.approvalGeneration,
        input.deliveryGeneration,
        input.reconciliationRef,
        input.ownerId,
        input.leaseToken,
        settledAtMs
      );
    if (update.changes !== 1) {
      throw new Error('hosted-team-approval-storage-delivery-reconciliation-conflict');
    }
    assertDeadlineOpen(input.deadlineAtMs);
  }).immediate();
}
