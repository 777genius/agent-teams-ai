import { HostedApprovalRuntimeAdmissionPublisher } from './HostedApprovalRuntimeAdmissionPublisher';
import { DescriptorAnchoredHostedApprovalRuntimeAdmissionStateStore } from './HostedApprovalRuntimeAdmissionStateStore';
import { openTrustedDirectoryCapability } from './HostedApprovalRuntimeDescriptorStorage';

import type {
  AuthoritativeHostedApprovalRuntimeBindingLease,
  HostedApprovalRuntimeAdmissionStateStore,
  HostedApprovalRuntimeLifecycle,
  HostedApprovalRuntimePublication,
} from './HostedApprovalRuntimeAdmissionPublisher';

export const HOSTED_APPROVAL_RUNTIME_PRODUCTION_ELIGIBLE = false as const;
export const HOSTED_APPROVAL_RUNTIME_ORCHESTRATOR_CAPABILITY = false as const;

export interface HostedApprovalRuntimeAuthoritativeEvidence {
  currentLifecycle(teamName: string): Promise<HostedApprovalRuntimeLifecycle | null>;
  acquireRosterSessionBootstrapProcessLease(
    teamName: string
  ): Promise<AuthoritativeHostedApprovalRuntimeBindingLease | null>;
  expectedInstalledArtifactDigest(teamName: string): Promise<`sha256:${string}` | null>;
}

export interface HostedApprovalRuntimeAdmissionCompositionDependencies {
  /**
   * Product release gate. A disabled composition never publishes an admission, so its lifecycle
   * barriers run the effect directly and never open or change team or app-data directories.
   */
  readonly enabled?: boolean;
  /** Returns an existing private per-team directory; composition never creates parents. */
  readonly resolveTeamDirectoryPath: (teamName: string) => string;
  /** Existing private app-state directory outside the team-owned runtime partition. */
  readonly stateDirectoryPath: string;
  readonly authoritativeEvidence: HostedApprovalRuntimeAuthoritativeEvidence;
}

/** Focused lifecycle coordinator: revocation is awaited before every destructive runtime effect. */
export interface HostedApprovalRuntimeAdmissionCoordinator {
  ensureAbsent(teamName: string, reason: string): Promise<HostedApprovalRuntimePublication>;
  reconcileCurrent(teamName: string): Promise<HostedApprovalRuntimePublication>;
  transition(
    teamName: string,
    lifecycle: HostedApprovalRuntimeLifecycle
  ): Promise<HostedApprovalRuntimePublication>;
  beforeCancel<T>(teamName: string, effect: () => Promise<T>): Promise<T>;
  beforeBindingChange<T>(teamName: string, effect: () => Promise<T>): Promise<T>;
  beforeFailure<T>(teamName: string, effect: () => Promise<T>): Promise<T>;
  beforeStop<T>(teamName: string, effect: () => Promise<T>): Promise<T>;
  beforeOwnerLoss<T>(teamName: string, effect: () => Promise<T>): Promise<T>;
  beforeShutdown<T>(teamNames: readonly string[], effect: () => Promise<T>): Promise<T>;
}

const CAPABILITY_DISABLED = 'hosted-approval-runtime-capability-disabled';

function absent(reason: string): Promise<HostedApprovalRuntimePublication> {
  return Promise.resolve(Object.freeze({ state: 'absent' as const, reason }));
}

/**
 * The approval capability is off in every build, so no admission is ever published and none can
 * exist to revoke. The Owner reads one only under a launcher-signed approval activation.
 */
const DISABLED_COORDINATOR: HostedApprovalRuntimeAdmissionCoordinator = Object.freeze({
  ensureAbsent: (_teamName: string, reason: string) => absent(reason),
  reconcileCurrent: () => absent(CAPABILITY_DISABLED),
  transition: () => absent(CAPABILITY_DISABLED),
  beforeCancel: <T>(_teamName: string, operation: () => Promise<T>) => operation(),
  beforeBindingChange: <T>(_teamName: string, operation: () => Promise<T>) => operation(),
  beforeFailure: <T>(_teamName: string, operation: () => Promise<T>) => operation(),
  beforeStop: <T>(_teamName: string, operation: () => Promise<T>) => operation(),
  beforeOwnerLoss: <T>(_teamName: string, operation: () => Promise<T>) => operation(),
  beforeShutdown: <T>(_teamNames: readonly string[], operation: () => Promise<T>) => operation(),
});

export function createHostedApprovalRuntimeAdmissionComposition(
  dependencies: HostedApprovalRuntimeAdmissionCompositionDependencies
): HostedApprovalRuntimeAdmissionCoordinator {
  if (dependencies.enabled === false) return DISABLED_COORDINATOR;
  const stateStore: HostedApprovalRuntimeAdmissionStateStore =
    new DescriptorAnchoredHostedApprovalRuntimeAdmissionStateStore(() =>
      openTrustedDirectoryCapability(dependencies.stateDirectoryPath)
    );
  const publisher = new HostedApprovalRuntimeAdmissionPublisher({
    openTeamDirectory: (teamName) =>
      openTrustedDirectoryCapability(dependencies.resolveTeamDirectoryPath(teamName)),
    acquireAuthoritativeBinding: (teamName) =>
      dependencies.authoritativeEvidence.acquireRosterSessionBootstrapProcessLease(teamName),
    resolveExpectedOpenCodeArtifactDigest: (teamName) =>
      dependencies.authoritativeEvidence.expectedInstalledArtifactDigest(teamName),
    stateStore,
  });
  const revokeBefore = async <T>(teamName: string, reason: string, effect: () => Promise<T>) => {
    await publisher.revoke(teamName, reason);
    return effect();
  };
  const coordinator: HostedApprovalRuntimeAdmissionCoordinator = {
    ensureAbsent(teamName, reason) {
      return publisher.revoke(teamName, reason);
    },
    async reconcileCurrent(teamName) {
      const lifecycle = await dependencies.authoritativeEvidence.currentLifecycle(teamName);
      return lifecycle
        ? publisher.reconcile(teamName, lifecycle)
        : publisher.revoke(teamName, 'hosted-approval-runtime-authority-unavailable');
    },
    transition(teamName, lifecycle) {
      return publisher.reconcile(teamName, lifecycle);
    },
    beforeCancel<T>(teamName: string, effect: () => Promise<T>) {
      return revokeBefore(teamName, 'cancelled', effect);
    },
    beforeBindingChange<T>(teamName: string, effect: () => Promise<T>) {
      return revokeBefore(teamName, 'binding-changed', effect);
    },
    beforeFailure<T>(teamName: string, effect: () => Promise<T>) {
      return revokeBefore(teamName, 'failed', effect);
    },
    beforeStop<T>(teamName: string, effect: () => Promise<T>) {
      return revokeBefore(teamName, 'stopped', effect);
    },
    beforeOwnerLoss<T>(teamName: string, effect: () => Promise<T>) {
      return revokeBefore(teamName, 'owner-lost', effect);
    },
    async beforeShutdown<T>(teamNames: readonly string[], effect: () => Promise<T>) {
      for (const teamName of [...new Set(teamNames)].toSorted()) {
        await publisher.revoke(teamName, 'shutdown');
      }
      return effect();
    },
  };
  return Object.freeze(coordinator);
}
