import { createHash, randomBytes } from 'node:crypto';

import type { HostedTeamApprovalDeliveryOutboxPort } from '../../../ports/HostedTeamApprovalAuthorityStoragePort';
import type {
  HostedApprovalDecisionExternalLifecycleDeliveryPort,
  HostedTeamApprovalRuntimeBridgeClockPort,
} from '../../../ports/HostedTeamApprovalRuntimeBridgePorts';
import type { HostedTeamApprovalDeliveryRecord } from '@features/internal-storage/contracts';

const MAX_LEASE_DURATION_MS = 5 * 60 * 1_000;
const MAX_BATCH_SIZE = 100;
/** Longer than the runtime wire's maximum 60 second exchange timeout. */
const BOUNDARY_LEASE_DURATION_MS = 2 * 60 * 1_000;

export interface HostedApprovalDecisionDeliveryRequest {
  readonly workspaceId: string;
  readonly teamId: string;
  readonly authorityGeneration: string;
  readonly restoreGeneration: number;
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly leaseDurationMs: number;
  readonly limit: number;
  readonly deadlineAtMs: number;
}

export interface HostedApprovalDecisionDeliveryResult {
  readonly claimed: number;
  readonly delivered: number;
  readonly acknowledged: number;
  readonly retained: number;
  readonly operatorRequired: number;
}

export type HostedApprovalDeliveryClaimTokenFactory = () => string;

function createClaimToken(): string {
  return `approval-claim_${randomBytes(24).toString('hex')}`;
}

function currentTime(clock: HostedTeamApprovalRuntimeBridgeClockPort): number | null {
  try {
    const value = clock.now();
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
}

function isOpenRequest(request: HostedApprovalDecisionDeliveryRequest, now: number): boolean {
  return (
    isIdentifier(request.ownerId) &&
    isIdentifier(request.leaseToken) &&
    Number.isSafeInteger(request.leaseDurationMs) &&
    request.leaseDurationMs > 0 &&
    request.leaseDurationMs <= MAX_LEASE_DURATION_MS &&
    Number.isSafeInteger(request.limit) &&
    request.limit > 0 &&
    request.limit <= MAX_BATCH_SIZE &&
    Number.isSafeInteger(request.deadlineAtMs) &&
    request.deadlineAtMs > now
  );
}

function ownsOpenLease(
  record: HostedTeamApprovalDeliveryRecord,
  request: HostedApprovalDecisionDeliveryRequest,
  now: number
): boolean {
  return (
    record.ownerId === request.ownerId &&
    record.leaseToken === request.leaseToken &&
    record.leaseExpiresAtMs > now
  );
}

function reconciliationRef(record: HostedTeamApprovalDeliveryRecord): string {
  const digest = createHash('sha256')
    .update(`${record.deliveryId}\0${record.deliveryGeneration}`)
    .digest('hex');
  return `approval-reconciliation_${digest}`;
}

/**
 * Delivers only records claimed from the durable approval decision outbox.
 * Its provider-facing conversation is a narrow external lifecycle port; it
 * never starts, stops, or otherwise owns a runtime lifecycle.
 */
export class HostedApprovalDecisionDeliveryCoordinator {
  constructor(
    private readonly deliveryOutbox: HostedTeamApprovalDeliveryOutboxPort,
    private readonly externalDelivery: HostedApprovalDecisionExternalLifecycleDeliveryPort,
    private readonly clock: HostedTeamApprovalRuntimeBridgeClockPort,
    private readonly claimTokenFactory: HostedApprovalDeliveryClaimTokenFactory = createClaimToken
  ) {}

  async deliver(
    request: HostedApprovalDecisionDeliveryRequest
  ): Promise<HostedApprovalDecisionDeliveryResult> {
    const startedAtMs = currentTime(this.clock);
    if (startedAtMs === null || !isOpenRequest(request, startedAtMs)) {
      throw new Error('hosted-approval-delivery-unavailable');
    }
    const claimLeaseToken = this.claimTokenFactory();
    if (!isIdentifier(claimLeaseToken) || claimLeaseToken === request.leaseToken) {
      throw new Error('hosted-approval-delivery-claim-token-invalid');
    }
    const claimRequest = Object.freeze({ ...request, leaseToken: claimLeaseToken });
    let records: readonly HostedTeamApprovalDeliveryRecord[];
    try {
      records = await this.deliveryOutbox.claimDeliveries({
        workspaceId: request.workspaceId,
        teamId: request.teamId,
        authorityGeneration: request.authorityGeneration,
        restoreGeneration: request.restoreGeneration,
        ownerId: request.ownerId,
        leaseToken: claimLeaseToken,
        leaseDurationMs: request.leaseDurationMs,
        limit: request.limit,
        deadlineAtMs: request.deadlineAtMs,
      });
    } catch (error) {
      throw new Error('hosted-approval-delivery-claim-unavailable', { cause: error });
    }
    let delivered = 0;
    let acknowledged = 0;
    let operatorRequired = 0;
    for (const record of records) {
      let boundaryFenced = false;
      const beforeDelivery = currentTime(this.clock);
      if (
        beforeDelivery === null ||
        beforeDelivery >= request.deadlineAtMs ||
        record.partition.teamId !== request.teamId ||
        !ownsOpenLease(record, claimRequest, beforeDelivery)
      ) {
        continue;
      }
      try {
        const stableReconciliationRef = reconciliationRef(record);
        await this.deliveryOutbox.markDeliveryOperatorRequired({
          workspaceId: record.workspaceId,
          authorityGeneration: record.authorityGeneration,
          restoreGeneration: record.restoreGeneration,
          partition: record.partition,
          deliveryId: record.deliveryId,
          approvalGeneration: record.approvalGeneration,
          deliveryGeneration: record.deliveryGeneration,
          ownerId: request.ownerId,
          leaseToken: claimLeaseToken,
          deadlineAtMs: request.deadlineAtMs,
          reconciliationRef: stableReconciliationRef,
          boundaryLeaseDurationMs: BOUNDARY_LEASE_DURATION_MS,
        });
        boundaryFenced = true;
        const fencedGeneration = record.deliveryGeneration + 1;
        const delivery = await this.externalDelivery.deliverRuntimePermissionDecision({
          providerDeliveryId: record.deliveryId,
          reconciliationRef: stableReconciliationRef,
          principal: record.principal,
          deliveryRef: record.deliveryRef,
          approvalId: record.approvalId,
          approvalGeneration: record.approvalGeneration,
          decision: record.decision,
          partition: record.partition,
          requestId: record.requestId,
        });
        if (delivery.status === 'operator_required') {
          if (delivery.reconciliationRef !== stableReconciliationRef) {
            throw new Error('hosted-approval-delivery-reconciliation-reference-mismatch');
          }
          operatorRequired += 1;
          continue;
        }
        if (delivery.status !== 'delivered' && delivery.status !== 'idempotent_replay') {
          operatorRequired += 1;
          continue;
        }
        delivered += 1;
        const beforeAcknowledge = currentTime(this.clock);
        if (beforeAcknowledge === null || beforeAcknowledge >= request.deadlineAtMs) {
          continue;
        }
        await this.deliveryOutbox.settleDeliveryReconciliation({
          workspaceId: record.workspaceId,
          authorityGeneration: record.authorityGeneration,
          restoreGeneration: record.restoreGeneration,
          partition: record.partition,
          deliveryId: record.deliveryId,
          approvalGeneration: record.approvalGeneration,
          deliveryGeneration: fencedGeneration,
          reconciliationRef: stableReconciliationRef,
          ownerId: request.ownerId,
          leaseToken: claimLeaseToken,
          deadlineAtMs: request.deadlineAtMs,
          outcome: 'delivered',
        });
        acknowledged += 1;
      } catch {
        // Once fenced, every failure is an ambiguous provider effect and remains quarantined.
        if (boundaryFenced) operatorRequired += 1;
      }
    }
    return Object.freeze({
      claimed: records.length,
      delivered,
      acknowledged,
      retained: records.length - acknowledged,
      operatorRequired,
    });
  }
}
