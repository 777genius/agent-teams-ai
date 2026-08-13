import type { HostedTeamApprovalDeliveryOutboxPort } from '../../../ports/HostedTeamApprovalAuthorityStoragePort';
import type {
  HostedApprovalDecisionExternalLifecycleDeliveryPort,
  HostedTeamApprovalRuntimeBridgeClockPort,
} from '../../../ports/HostedTeamApprovalRuntimeBridgePorts';
import type { HostedTeamApprovalDeliveryRecord } from '@features/internal-storage/contracts';

const MAX_LEASE_DURATION_MS = 5 * 60 * 1_000;
const MAX_BATCH_SIZE = 100;

export interface HostedApprovalDecisionDeliveryRequest {
  readonly workspaceId: string;
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

/**
 * Delivers only records claimed from the durable approval decision outbox.
 * Its provider-facing conversation is a narrow external lifecycle port; it
 * never starts, stops, or otherwise owns a runtime lifecycle.
 */
export class HostedApprovalDecisionDeliveryCoordinator {
  constructor(
    private readonly deliveryOutbox: HostedTeamApprovalDeliveryOutboxPort,
    private readonly externalDelivery: HostedApprovalDecisionExternalLifecycleDeliveryPort,
    private readonly clock: HostedTeamApprovalRuntimeBridgeClockPort
  ) {}

  async deliver(
    request: HostedApprovalDecisionDeliveryRequest
  ): Promise<HostedApprovalDecisionDeliveryResult> {
    const startedAtMs = currentTime(this.clock);
    if (startedAtMs === null || !isOpenRequest(request, startedAtMs)) {
      throw new Error('hosted-approval-delivery-unavailable');
    }
    let records: readonly HostedTeamApprovalDeliveryRecord[];
    try {
      records = await this.deliveryOutbox.claimDeliveries({
        workspaceId: request.workspaceId,
        authorityGeneration: request.authorityGeneration,
        restoreGeneration: request.restoreGeneration,
        ownerId: request.ownerId,
        leaseToken: request.leaseToken,
        leaseDurationMs: request.leaseDurationMs,
        limit: request.limit,
        deadlineAtMs: request.deadlineAtMs,
      });
    } catch (error) {
      throw new Error('hosted-approval-delivery-claim-unavailable', { cause: error });
    }
    let delivered = 0;
    let acknowledged = 0;
    for (const record of records) {
      const beforeDelivery = currentTime(this.clock);
      if (
        beforeDelivery === null ||
        beforeDelivery >= request.deadlineAtMs ||
        !ownsOpenLease(record, request, beforeDelivery)
      ) {
        continue;
      }
      try {
        const delivery = await this.externalDelivery.deliverRuntimePermissionDecision({
          providerDeliveryId: record.deliveryId,
          principal: record.principal,
          deliveryRef: record.deliveryRef,
          approvalId: record.approvalId,
          approvalGeneration: record.approvalGeneration,
          decision: record.decision,
          partition: record.partition,
          requestId: record.requestId,
        });
        if (delivery.status !== 'delivered' && delivery.status !== 'idempotent_replay') continue;
        delivered += 1;
        const beforeAcknowledge = currentTime(this.clock);
        if (
          beforeAcknowledge === null ||
          beforeAcknowledge >= request.deadlineAtMs ||
          !ownsOpenLease(record, request, beforeAcknowledge)
        ) {
          continue;
        }
        await this.deliveryOutbox.acknowledgeDelivery({
          workspaceId: record.workspaceId,
          authorityGeneration: record.authorityGeneration,
          restoreGeneration: record.restoreGeneration,
          partition: record.partition,
          deliveryId: record.deliveryId,
          deliveryGeneration: record.deliveryGeneration,
          ownerId: request.ownerId,
          leaseToken: request.leaseToken,
          deadlineAtMs: request.deadlineAtMs,
        });
        acknowledged += 1;
      } catch {
        // Keep the durable outbox record for lease recovery and idempotent retry.
      }
    }
    return Object.freeze({
      claimed: records.length,
      delivered,
      acknowledged,
      retained: records.length - acknowledged,
    });
  }
}
