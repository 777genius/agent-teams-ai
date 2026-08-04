import type {
  HostedTeamApprovalAuthorityScope,
  HostedTeamApprovalDeliveryAcknowledgeRequest,
  HostedTeamApprovalDeliveryClaimRequest,
  HostedTeamApprovalDeliveryRecord,
  HostedTeamApprovalPendingReadRecord,
  HostedTeamApprovalPendingStorageRecord,
} from '@features/internal-storage/contracts';
import type { QueryContext, TeamId } from '@shared/contracts/hosted';

/**
 * Resolves the current trusted approval authority scope. Browser requests do
 * not supply workspace, authority, or restore-generation identity.
 */
export interface HostedTeamApprovalAuthorityScopeResolverPort {
  resolveScope(
    teamId: TeamId,
    context: QueryContext
  ): Promise<HostedTeamApprovalAuthorityScope | null>;
}

/** Trusted lifecycle-owner ingress; it never starts or owns that lifecycle. */
export interface HostedTeamApprovalPendingIngressPort {
  observePending(
    record: HostedTeamApprovalPendingStorageRecord
  ): Promise<HostedTeamApprovalPendingReadRecord>;
}

/**
 * Recoverable delivery handoff for the external lifecycle owner. Delivery IDs
 * remain stable across lease recovery so the receiver can be idempotent.
 */
export interface HostedTeamApprovalDeliveryOutboxPort {
  claimDeliveries(
    request: HostedTeamApprovalDeliveryClaimRequest
  ): Promise<readonly HostedTeamApprovalDeliveryRecord[]>;
  acknowledgeDelivery(request: HostedTeamApprovalDeliveryAcknowledgeRequest): Promise<void>;
}
