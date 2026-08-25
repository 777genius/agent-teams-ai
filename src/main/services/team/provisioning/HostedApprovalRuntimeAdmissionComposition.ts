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
  /** Product release gate. Disabled composition still owns and awaits every lifecycle barrier. */
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

export function createHostedApprovalRuntimeAdmissionComposition(
  dependencies: HostedApprovalRuntimeAdmissionCompositionDependencies
): HostedApprovalRuntimeAdmissionCoordinator {
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
  if (dependencies.enabled === false) return disabledCoordinator(publisher);
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

function disabledCoordinator(
  publisher: HostedApprovalRuntimeAdmissionPublisher
): HostedApprovalRuntimeAdmissionCoordinator {
  const revokeBefore = async <T>(teamName: string, operation: () => Promise<T>): Promise<T> => {
    await publisher.revoke(teamName, 'hosted-approval-runtime-capability-disabled');
    return operation();
  };
  return Object.freeze({
    ensureAbsent: (teamName: string, reason: string) => publisher.revoke(teamName, reason),
    reconcileCurrent: (teamName: string) =>
      publisher.revoke(teamName, 'hosted-approval-runtime-capability-disabled'),
    transition: (teamName: string) =>
      publisher.revoke(teamName, 'hosted-approval-runtime-capability-disabled'),
    beforeCancel: revokeBefore,
    beforeBindingChange: revokeBefore,
    beforeFailure: revokeBefore,
    beforeStop: revokeBefore,
    beforeOwnerLoss: revokeBefore,
    beforeShutdown: async <T>(teamNames: readonly string[], operation: () => Promise<T>) => {
      for (const teamName of [...new Set(teamNames)].toSorted()) {
        await publisher.revoke(teamName, 'hosted-approval-runtime-capability-disabled');
      }
      return operation();
    },
  });
}
