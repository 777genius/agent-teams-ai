// eslint-disable-next-line no-restricted-imports -- Production composition consumes bounded hosted approval facets.
import {
  createHostedApprovalAdmissionAuthority,
  HostedApprovalRuntimeOrchestratorAuthority,
  HostedApprovalRuntimeOrchestratorRouter,
  type HostedApprovalRuntimeWireAuthority,
} from '@features/team-approvals/main/hosted';
import { parseActorId, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';

import { createHostedOperatorProductionComposition } from './hostedOperatorProductionComposition';

import type { HostedRouteAdmissionBinding } from './application';
import type { OrchestratorLifecycleOwnerProofKey } from './hostedLifecycleOrchestratorReadiness';
import type { HostedLifecycleProductionOwnerAdmission } from './hostedLifecycleProductionOwnerAdmission';
import type { HostedOperatorProductionComposition } from './hostedOperatorProductionComposition';
import type { TeamLifecycleCommandMutationLease } from './teamLifecycleCommandComposition';
import type { HostedAuthenticatedPrincipal } from '@features/hosted-access';
import type {
  HostedTeamApprovalAuthorityStorageGateway,
  TeamIdentityReadGateway,
} from '@features/internal-storage/contracts';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { WorkspaceMountBinding } from '@features/workspace-registry';

export interface CreateHostedApprovalProductionCompositionDependencies {
  readonly authentication: {
    authenticatedPrincipalFor(request: object): HostedAuthenticatedPrincipal | null;
  };
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly expectedDeploymentId: string;
  readonly actorId: string;
  readonly mountBinding: WorkspaceMountBinding;
  readonly restoreGeneration: number;
  readonly teamIdentities: TeamIdentityReadGateway;
  readonly approvalStorage: HostedTeamApprovalAuthorityStorageGateway;
  readonly routeAdmissionBinding: HostedRouteAdmissionBinding;
  readonly ownerAdmission: HostedLifecycleProductionOwnerAdmission;
  readonly ownerProofKey: OrchestratorLifecycleOwnerProofKey;
}

export interface CreateOptionalHostedApprovalProductionCompositionDependencies {
  readonly authentication: CreateHostedApprovalProductionCompositionDependencies['authentication'];
  readonly expectedDeploymentId: string;
  readonly restoreGeneration: number;
  readonly actorId: string | null;
  readonly routeDependencies: Readonly<{
    runtimeInstance: RuntimeInstanceContext;
    mountBinding: WorkspaceMountBinding;
    teamIdentities: TeamIdentityReadGateway;
  }> | null;
  readonly approvalStorage: HostedTeamApprovalAuthorityStorageGateway;
  readonly routeAdmissionBinding: HostedRouteAdmissionBinding;
  readonly ownerAdmission: HostedLifecycleProductionOwnerAdmission | null;
  readonly ownerProofKey: OrchestratorLifecycleOwnerProofKey | null;
}

export function createOptionalHostedApprovalProductionComposition(
  dependencies: CreateOptionalHostedApprovalProductionCompositionDependencies
): HostedOperatorProductionComposition | null {
  const ownerAdmission = dependencies.ownerAdmission;
  const routeDependencies = dependencies.routeDependencies;
  if (
    ownerAdmission === null ||
    ownerAdmission.approvalRoutes.length === 0 ||
    routeDependencies === null ||
    dependencies.actorId === null ||
    dependencies.ownerProofKey === null
  ) {
    return null;
  }
  return createHostedApprovalProductionComposition({
    authentication: dependencies.authentication,
    runtimeInstance: routeDependencies.runtimeInstance,
    expectedDeploymentId: dependencies.expectedDeploymentId,
    actorId: dependencies.actorId,
    mountBinding: routeDependencies.mountBinding,
    restoreGeneration: dependencies.restoreGeneration,
    teamIdentities: routeDependencies.teamIdentities,
    approvalStorage: dependencies.approvalStorage,
    routeAdmissionBinding: dependencies.routeAdmissionBinding,
    ownerAdmission,
    ownerProofKey: dependencies.ownerProofKey,
  });
}

/**
 * Mounts approvals only from the launcher-signed v4 route catalog. Every runtime effect is routed
 * from its immutable team partition; browser state and process-global team selection are absent.
 */
export function createHostedApprovalProductionComposition(
  dependencies: CreateHostedApprovalProductionCompositionDependencies
): HostedOperatorProductionComposition {
  const admission = dependencies.ownerAdmission;
  const workspaceId = parseWorkspaceId(admission.bootstrapBinding.workspaceId);
  if (
    admission.approvalRoutes.length === 0 ||
    admission.approvalSnapshot === null ||
    admission.approvalAdmission.state !== 'active' ||
    dependencies.runtimeInstance.deploymentId !== admission.bootstrapBinding.deploymentId ||
    dependencies.runtimeInstance.bootId !== admission.bootstrapBinding.bootId ||
    dependencies.mountBinding.workspaceId !== workspaceId ||
    dependencies.mountBinding.bootId !== dependencies.runtimeInstance.bootId ||
    dependencies.mountBinding.mountGeneration !== admission.bootstrapBinding.mountGeneration
  ) {
    throw new TypeError('hosted-approval-production-admission-binding-invalid');
  }

  const privateAuthority = createHostedApprovalAdmissionAuthority({
    pin: admission.approvalAdmission,
    snapshot: admission.approvalSnapshot,
  });
  if (privateAuthority === null) {
    throw new TypeError('hosted-approval-production-private-authority-invalid');
  }

  const wireAuthority: HostedApprovalRuntimeWireAuthority = Object.freeze({
    actorId: parseActorId(dependencies.actorId),
    deploymentId: dependencies.runtimeInstance.deploymentId,
    bootId: dependencies.runtimeInstance.bootId,
    restoreGeneration: dependencies.restoreGeneration,
    workspaceId,
    mountBinding: Object.freeze({
      mountGeneration: dependencies.mountBinding.mountGeneration,
      declaredRootHash: dependencies.mountBinding.declaredRootHash,
    }),
  });
  const routes = admission.approvalRoutes.map((route) => {
    const teamId = parseTeamId(route.teamId);
    const authority = new HostedApprovalRuntimeOrchestratorAuthority({
      lease: createApprovalRouteMutationLease(admission, route),
      ownerProofKey: dependencies.ownerProofKey,
      authority: wireAuthority,
      getAdmittedIngressAuthority: async (candidate) =>
        candidate.teamId === teamId
          ? privateAuthority.getAdmittedIngressAuthority(candidate)
          : null,
    });
    return Object.freeze({ teamId, authority });
  });
  const router = new HostedApprovalRuntimeOrchestratorRouter(routes);
  try {
    const operator = createHostedOperatorProductionComposition({
      authentication: dependencies.authentication,
      runtimeInstance: dependencies.runtimeInstance,
      expectedDeploymentId: dependencies.expectedDeploymentId,
      workspaceId,
      mountGeneration: dependencies.mountBinding.mountGeneration,
      restoreGeneration: dependencies.restoreGeneration,
      teamIdentities: dependencies.teamIdentities,
      approvalStorage: dependencies.approvalStorage,
      approvalRuntime: {
        teamIds: Object.freeze(routes.map((route) => route.teamId)),
        ownerId: `approval-owner:${admission.expectedOwnerBinding.ownerSessionId}`,
        leaseToken: `approval-lease:${admission.expectedOwnerBinding.ownerGeneration}:${admission.expectedOwnerBinding.ownerSessionId}`,
        ingressEffectOutbox: router,
        ingressAuthority: router,
        externalDecisionDelivery: router,
        externalDecisionReconciliation: router,
      },
      routeAdmissionBinding: dependencies.routeAdmissionBinding,
    });
    let closed = false;
    return Object.freeze({
      isReady: () => operator.isReady(),
      reconcileApprovalDecision: operator.reconcileApprovalDecision.bind(operator),
      register: operator.register.bind(operator),
      close(): void {
        if (closed) return;
        closed = true;
        operator.close();
        router.close();
      },
    });
  } catch (error) {
    router.close();
    throw error;
  }
}

function createApprovalRouteMutationLease(
  admission: HostedLifecycleProductionOwnerAdmission,
  route: HostedLifecycleProductionOwnerAdmission['approvalRoutes'][number]
): TeamLifecycleCommandMutationLease {
  let invalidated = false;
  const binding = Object.freeze({
    ownerAuthority: admission.ownerAuthority,
    ownerGeneration: route.ownerGeneration,
    ownerSessionId: route.ownerSessionId,
    socketIdentity: route.socketIdentity,
  });
  return Object.freeze({
    socketPath: route.socketPath,
    currentBinding: () => (invalidated ? null : binding),
    invalidate: () => {
      invalidated = true;
    },
  });
}
