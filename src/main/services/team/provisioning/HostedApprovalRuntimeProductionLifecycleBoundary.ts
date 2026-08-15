import type {
  HostedApprovalRuntimeLifecycle,
  HostedApprovalRuntimePublication,
} from './HostedApprovalRuntimeAdmissionPublisher';
import type { HostedApprovalRuntimeTransitionEvidence } from './HostedApprovalRuntimeAuthoritativeEvidenceAdapter';
import type { HostedApprovalRuntimeLifecycleOwner } from './HostedApprovalRuntimeLifecycleOwner';
import type { HostedApprovalRuntimeTransitionService } from './HostedApprovalRuntimeTransitionService';

export interface HostedApprovalRuntimeOwnerLeaseContract {
  acquireTransitionEvidence(
    teamName: string,
    lifecycle: HostedApprovalRuntimeLifecycle
  ): Promise<HostedApprovalRuntimeTransitionEvidence | null>;
}

/**
 * Authoritative product lifecycle input. The external owner supplies a single-use binding lease;
 * this boundary never reconstructs authority from team files or ambient process state.
 */
export class HostedApprovalRuntimeProductionLifecycleBoundary {
  constructor(
    private readonly owner: HostedApprovalRuntimeLifecycleOwner,
    private readonly runtime: HostedApprovalRuntimeTransitionService
  ) {}

  async publish(
    teamName: string,
    lifecycle: HostedApprovalRuntimeLifecycle,
    ownerLease: HostedApprovalRuntimeOwnerLeaseContract | null
  ): Promise<HostedApprovalRuntimePublication> {
    let evidence: HostedApprovalRuntimeTransitionEvidence | null | undefined;
    try {
      evidence = await ownerLease?.acquireTransitionEvidence(teamName, lifecycle);
    } catch {
      await this.runtime.ensureAbsent(teamName, 'hosted-approval-runtime-owner-lease-unavailable');
      return unavailableOwnerLease();
    }
    if (!evidence || JSON.stringify(evidence.lifecycle) !== JSON.stringify(lifecycle)) {
      await this.runtime.ensureAbsent(teamName, 'hosted-approval-runtime-owner-lease-unavailable');
      return unavailableOwnerLease();
    }

    try {
      const publication = await this.owner.transition(teamName, evidence);
      if (publication.state === 'unavailable') {
        await this.runtime.ensureAbsent(teamName, publication.reason);
      }
      return publication;
    } catch (error) {
      await this.runtime.ensureAbsent(teamName, 'hosted-approval-runtime-transition-failed');
      throw error;
    }
  }

  ensureAbsent(teamName: string, reason: string): Promise<HostedApprovalRuntimePublication> {
    return this.runtime.ensureAbsent(teamName, reason);
  }
}

function unavailableOwnerLease(): HostedApprovalRuntimePublication {
  return Object.freeze({
    state: 'unavailable',
    reason: 'hosted-approval-runtime-owner-lease-unavailable',
  });
}
