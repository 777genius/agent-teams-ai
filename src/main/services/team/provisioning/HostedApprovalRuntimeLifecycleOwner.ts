import type { HostedApprovalRuntimePublication } from './HostedApprovalRuntimeAdmissionPublisher';
import type { HostedApprovalRuntimeTransitionEvidence } from './HostedApprovalRuntimeAuthoritativeEvidenceAdapter';
import type { HostedApprovalRuntimeTransitionService } from './HostedApprovalRuntimeTransitionService';

/**
 * Product-owned input port for the trusted launcher lifecycle owner. The caller cannot publish from
 * ambient state: every transition carries the authoritative lease and installed-artifact reread.
 */
export interface HostedApprovalRuntimeLifecycleOwner {
  transition(
    teamName: string,
    evidence: HostedApprovalRuntimeTransitionEvidence
  ): Promise<HostedApprovalRuntimePublication>;
}

export function createHostedApprovalRuntimeLifecycleOwner(
  runtime: HostedApprovalRuntimeTransitionService
): HostedApprovalRuntimeLifecycleOwner {
  return Object.freeze({
    transition(teamName: string, evidence: HostedApprovalRuntimeTransitionEvidence) {
      return runtime.transition(teamName, evidence.lifecycle, evidence);
    },
  });
}
