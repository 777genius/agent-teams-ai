import type { HostedTeamApprovalDeliveryOutboxPort } from '../../../ports/HostedTeamApprovalAuthorityStoragePort';
import type {
  HostedApprovalDecisionReconciliationPort,
  HostedTeamApprovalRuntimeBridgeClockPort,
} from '../../../ports/HostedTeamApprovalRuntimeBridgePorts';
import type { HostedTeamApprovalPartition } from '@features/internal-storage/contracts';

export interface HostedApprovalDecisionReconciliationRequest {
  readonly workspaceId: string;
  readonly authorityGeneration: string;
  readonly restoreGeneration: number;
  readonly partition: HostedTeamApprovalPartition;
  readonly providerDeliveryId: string;
  readonly approvalGeneration: string;
  readonly deliveryGeneration: number;
  readonly reconciliationRef: string;
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly deadlineAtMs: number;
}

const RECONCILIATION_LEASE_DURATION_MS = 2 * 60 * 1_000;

export type HostedApprovalDecisionReconciliationResult =
  | { readonly status: 'delivered' | 'retry_authorized' }
  | {
      readonly status: 'operator_required' | 'unavailable';
      readonly claim?: Readonly<{ deliveryGeneration: number; operationId: string }>;
    }
  | { readonly status: 'stale_binding' | 'not_found' };

/**
 * Applies the only recovery policy for ambiguous provider delivery: a proven
 * `not_delivered` result reopens the outbox; every other unresolved outcome
 * remains durably quarantined under the same exact generation binding.
 */
export class HostedApprovalDecisionReconciliationCoordinator {
  constructor(
    private readonly deliveryOutbox: HostedTeamApprovalDeliveryOutboxPort,
    private readonly externalReconciliation: HostedApprovalDecisionReconciliationPort,
    private readonly clock: HostedTeamApprovalRuntimeBridgeClockPort
  ) {}

  async reconcile(
    request: HostedApprovalDecisionReconciliationRequest
  ): Promise<HostedApprovalDecisionReconciliationResult> {
    let now: number;
    try {
      now = this.clock.now();
    } catch {
      return Object.freeze({ status: 'unavailable' });
    }
    if (!Number.isSafeInteger(now) || now < 0 || now >= request.deadlineAtMs) {
      return Object.freeze({ status: 'unavailable' });
    }
    const binding = {
      workspaceId: request.workspaceId,
      authorityGeneration: request.authorityGeneration,
      restoreGeneration: request.restoreGeneration,
      partition: request.partition,
      deliveryId: request.providerDeliveryId,
      approvalGeneration: request.approvalGeneration,
      deliveryGeneration: request.deliveryGeneration,
      reconciliationRef: request.reconciliationRef,
      ownerId: request.ownerId,
      leaseToken: request.leaseToken,
      leaseDurationMs: RECONCILIATION_LEASE_DURATION_MS,
      deadlineAtMs: request.deadlineAtMs,
    } as const;
    try {
      const admission = await this.deliveryOutbox.readDeliveryReconciliation(binding);
      if (admission.kind === 'unavailable') return Object.freeze({ status: 'unavailable' });
      if (admission.kind !== 'claimed') return Object.freeze({ status: admission.kind });
      const result = await this.externalReconciliation.reconcileRuntimePermissionDecision({
        reconciliationRef: request.reconciliationRef,
        providerDeliveryId: request.providerDeliveryId,
        partition: request.partition,
      });
      if (result.status === 'operator_required' || result.status === 'unavailable') {
        return Object.freeze({
          status: result.status,
          claim: Object.freeze({
            deliveryGeneration: admission.deliveryGeneration,
            operationId: request.leaseToken,
          }),
        });
      }
      await this.deliveryOutbox.settleDeliveryReconciliation({
        workspaceId: binding.workspaceId,
        authorityGeneration: binding.authorityGeneration,
        restoreGeneration: binding.restoreGeneration,
        partition: binding.partition,
        deliveryId: binding.deliveryId,
        approvalGeneration: binding.approvalGeneration,
        reconciliationRef: binding.reconciliationRef,
        ownerId: binding.ownerId,
        leaseToken: binding.leaseToken,
        deadlineAtMs: binding.deadlineAtMs,
        deliveryGeneration: admission.deliveryGeneration,
        outcome: result.status,
      });
      return Object.freeze({
        status: result.status === 'delivered' ? 'delivered' : 'retry_authorized',
      });
    } catch {
      return Object.freeze({ status: 'unavailable' });
    }
  }
}
