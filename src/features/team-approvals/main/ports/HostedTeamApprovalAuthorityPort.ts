import type { HostedTeamApprovalDecisionCommand } from '../../contracts/hosted';
import type {
  HostedTeamApprovalDecisionAdmissionResult,
  HostedTeamApprovalPageSourceRequest,
  HostedTeamApprovalPageSourceResult,
  HostedTeamApprovalPreviewSourceRequest,
  HostedTeamApprovalPreviewSourceResult,
} from '../../core/application/ports/HostedTeamApprovalPorts';
import type { QueryContext } from '@shared/contracts/hosted';

/**
 * Server-owned approval authority consumed by the hosted feature.
 *
 * Each operation revalidates the exact QueryContext scope within the authoritative observation. A
 * pending read selects only currently pending approvals. A preview read binds the opaque reference
 * to the same team, approval, and generation before returning its bounded projection.
 *
 * `compareAndClaimDecision` performs scope revalidation, pending-generation comparison,
 * idempotency matching, the one-decision claim, and redacted audit commit atomically. A committed
 * claim and its persisted-before-delivery handoff are durable before `committed` is returned, so a
 * caller can safely recover through the authority's idempotent receipt.
 */
export interface HostedTeamApprovalAuthorityPort {
  readPendingPage(
    request: HostedTeamApprovalPageSourceRequest,
    context: QueryContext
  ): Promise<HostedTeamApprovalPageSourceResult>;

  readPreviewByOpaqueRef(
    request: HostedTeamApprovalPreviewSourceRequest,
    context: QueryContext
  ): Promise<HostedTeamApprovalPreviewSourceResult>;

  compareAndClaimDecision(
    command: HostedTeamApprovalDecisionCommand,
    context: QueryContext
  ): Promise<HostedTeamApprovalDecisionAdmissionResult>;
}
