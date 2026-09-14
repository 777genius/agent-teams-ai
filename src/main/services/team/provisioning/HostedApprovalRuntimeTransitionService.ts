import type { HostedApprovalRuntimeAdmissionCoordinator } from './HostedApprovalRuntimeAdmissionComposition';
import type {
  HostedApprovalRuntimeLifecycle,
  HostedApprovalRuntimePublication,
} from './HostedApprovalRuntimeAdmissionPublisher';
import type {
  HostedApprovalRuntimeTransitionAuthority,
  HostedApprovalRuntimeTransitionEvidence,
} from './HostedApprovalRuntimeAuthoritativeEvidenceAdapter';

export interface HostedApprovalRuntimeTransitionServiceDependencies {
  readonly coordinator: HostedApprovalRuntimeAdmissionCoordinator | null;
  readonly transitionAuthority: HostedApprovalRuntimeTransitionAuthority | null;
}

const LIFECYCLE_EVIDENCE_MISMATCH = 'hosted-approval-runtime-lifecycle-evidence-mismatch';

/**
 * Focused application boundary for launcher-authorized admission transitions. It deliberately sits
 * beside the compatibility facade: hosted authority never becomes a TeamProvisioningService slot or
 * public method.
 */
export class HostedApprovalRuntimeTransitionService {
  constructor(private readonly dependencies: HostedApprovalRuntimeTransitionServiceDependencies) {}

  async transition(
    teamName: string,
    lifecycle: HostedApprovalRuntimeLifecycle,
    evidence?: HostedApprovalRuntimeTransitionEvidence
  ): Promise<HostedApprovalRuntimePublication> {
    const { coordinator, transitionAuthority } = this.dependencies;
    if (!coordinator) return unavailable();
    if (!evidence) return coordinator.transition(teamName, lifecycle);
    if (!transitionAuthority) {
      return rejectOwnerEvidence(coordinator, teamName);
    }
    let lifecycleMatches = false;
    try {
      lifecycleMatches = sameLifecycle(evidence.lifecycle, lifecycle);
    } catch {
      // A Proxy may reject the evidence.lifecycle read before sameLifecycle receives its argument.
    }
    if (!lifecycleMatches) {
      return rejectOwnerEvidence(coordinator, teamName);
    }
    return transitionAuthority.withEvidence(teamName, evidence, () =>
      coordinator.transition(teamName, lifecycle)
    );
  }

  ensureAbsent(teamName: string, reason = 'startup'): Promise<HostedApprovalRuntimePublication> {
    return (
      this.dependencies.coordinator?.ensureAbsent(teamName, reason) ??
      Promise.resolve(unavailable())
    );
  }

  beforeCancel<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    return this.dependencies.coordinator?.beforeCancel(teamName, operation) ?? operation();
  }

  beforeBindingChange<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    return this.dependencies.coordinator?.beforeBindingChange(teamName, operation) ?? operation();
  }

  beforeFailure<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    return this.dependencies.coordinator?.beforeFailure(teamName, operation) ?? operation();
  }

  beforeStop<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    return this.dependencies.coordinator?.beforeStop(teamName, operation) ?? operation();
  }

  beforeOwnerLoss<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    return this.dependencies.coordinator?.beforeOwnerLoss(teamName, operation) ?? operation();
  }

  beforeShutdown<T>(teamNames: readonly string[], operation: () => Promise<T>): Promise<T> {
    return this.dependencies.coordinator?.beforeShutdown(teamNames, operation) ?? operation();
  }
}

async function rejectOwnerEvidence(
  coordinator: HostedApprovalRuntimeAdmissionCoordinator,
  teamName: string
): Promise<HostedApprovalRuntimePublication> {
  const absence = await coordinator.ensureAbsent(teamName, LIFECYCLE_EVIDENCE_MISMATCH);
  if (absence.state !== 'absent' && absence.state !== 'revoked') {
    throw new Error('hosted-approval-runtime-admission-absence-unconfirmed');
  }
  return Object.freeze({
    state: 'unavailable' as const,
    reason: LIFECYCLE_EVIDENCE_MISMATCH,
  });
}

function sameLifecycle(
  left: HostedApprovalRuntimeLifecycle,
  right: HostedApprovalRuntimeLifecycle
): boolean {
  try {
    if (left.state !== right.state || left.ownerGeneration !== right.ownerGeneration) return false;
    if (left.state === 'provisioning' || right.state === 'provisioning') {
      return left.state === right.state;
    }
    if (left.approvalGeneration !== right.approvalGeneration) return false;
    if (left.state === 'restart_required' || right.state === 'restart_required') {
      return left.state === right.state;
    }
    return left.approvalDigest === right.approvalDigest;
  } catch {
    return false;
  }
}

function unavailable(): HostedApprovalRuntimePublication {
  return Object.freeze({
    state: 'unavailable' as const,
    reason: 'hosted-approval-runtime-coordinator-unavailable',
  });
}
