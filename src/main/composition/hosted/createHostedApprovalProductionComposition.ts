// eslint-disable-next-line no-restricted-imports -- Production composition consumes bounded hosted approval facets.
import {
  createHostedApprovalAdmissionAuthority,
  HostedApprovalRuntimeOrchestratorAuthority,
  HostedApprovalRuntimeOrchestratorRouter,
  type HostedApprovalRuntimeWireAuthority,
} from '@features/team-approvals/main/hosted';
import { parseActorId, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';

import {
  activateHostedApprovalRuntime,
  HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
  HOSTED_APPROVAL_ACTIVATION_MANIFEST_FORMAT,
  type HostedApprovalRuntimeActivationBinding,
  type HostedApprovalRuntimeActivationLease,
  type HostedApprovalRuntimeActivationOptions,
  type HostedApprovalRuntimeActivationPublicationContract,
  sameHostedApprovalActivationOwner,
} from '../../services/team/provisioning/HostedApprovalRuntimeActivationEnvelope';

import {
  createHostedOperatorProductionComposition,
  type HostedOperatorProductionComposition,
} from './hostedOperatorProductionComposition';

import type { HostedRouteAdmissionBinding } from './application';
import type { OrchestratorLifecycleOwnerProofKey } from './hostedLifecycleOrchestratorReadiness';
import type { HostedLifecycleProductionOwnerAdmission } from './hostedLifecycleProductionOwnerAdmission';
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
  readonly activationPublication: HostedApprovalRuntimeActivationPublicationContract;
  readonly activateApprovalRuntime?: (
    options: HostedApprovalRuntimeActivationOptions
  ) => Promise<HostedApprovalRuntimeActivationLease>;
  readonly approvalActivationTimeoutMs?: number;
  readonly onApprovalOwnerLoss?: (error: Error) => void;
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
  readonly activationPublication: HostedApprovalRuntimeActivationPublicationContract | null;
  readonly activateApprovalRuntime?: CreateHostedApprovalProductionCompositionDependencies['activateApprovalRuntime'];
  readonly approvalActivationTimeoutMs?: number;
  readonly onApprovalOwnerLoss?: (error: Error) => void;
}

export async function createOptionalHostedApprovalProductionComposition(
  dependencies: CreateOptionalHostedApprovalProductionCompositionDependencies
): Promise<HostedOperatorProductionComposition | null> {
  const ownerAdmission = dependencies.ownerAdmission;
  const routeDependencies = dependencies.routeDependencies;
  if (
    ownerAdmission === null ||
    ownerAdmission.approvalRoutes.length === 0 ||
    routeDependencies === null ||
    dependencies.actorId === null ||
    dependencies.ownerProofKey === null ||
    dependencies.activationPublication === null
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
    activationPublication: dependencies.activationPublication,
    ...(dependencies.activateApprovalRuntime === undefined
      ? {}
      : { activateApprovalRuntime: dependencies.activateApprovalRuntime }),
    ...(dependencies.approvalActivationTimeoutMs === undefined
      ? {}
      : { approvalActivationTimeoutMs: dependencies.approvalActivationTimeoutMs }),
    ...(dependencies.onApprovalOwnerLoss === undefined
      ? {}
      : { onApprovalOwnerLoss: dependencies.onApprovalOwnerLoss }),
  });
}

/**
 * Mounts approvals only from the launcher-signed v4 route catalog. Every runtime effect is routed
 * from its immutable team partition; browser state and process-global team selection are absent.
 */
export async function createHostedApprovalProductionComposition(
  dependencies: CreateHostedApprovalProductionCompositionDependencies
): Promise<HostedOperatorProductionComposition> {
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
  const activationLeases: HostedApprovalRuntimeActivationLease[] = [];
  let operator: HostedOperatorProductionComposition | null = null;
  let router: HostedApprovalRuntimeOrchestratorRouter | null = null;
  let closed = false;
  const closeActivatedSurface = (): void => {
    if (closed) return;
    // Revoke logical route leases before any downstream cleanup can run.
    closed = true;
    for (const lease of activationLeases) lease.invalidate();
    router?.close();
    operator?.close();
  };
  const activation = dependencies.activateApprovalRuntime ?? activateHostedApprovalRuntime;
  try {
    for (const route of admission.approvalRoutes) {
      const ownerBinding = Object.freeze({
        ownerAuthority: admission.ownerAuthority,
        ownerGeneration: route.ownerGeneration,
        ownerSessionId: route.ownerSessionId,
        socketIdentity: route.socketIdentity,
      });
      const binding: HostedApprovalRuntimeActivationBinding = Object.freeze({
        deploymentId: dependencies.runtimeInstance.deploymentId,
        bootId: dependencies.runtimeInstance.bootId,
        workspaceId: route.workspaceId,
        teamId: route.teamId,
        restoreGeneration: dependencies.restoreGeneration,
        mountBinding: Object.freeze({
          mountGeneration: dependencies.mountBinding.mountGeneration,
          declaredRootHash: dependencies.mountBinding.declaredRootHash,
        }),
        ownerBinding,
        socketPath: route.socketPath,
        approvalGeneration: route.approvalGeneration,
        admissionOwnerGeneration: admission.approvalAdmission.ownerGeneration,
        approvalDigest: route.approvalDigest,
        admissionDocumentDigest: dependencies.activationPublication.admissionDocumentDigest,
        artifactDigest: route.artifactDigest,
        activationCapability: HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
        wireCapabilityDigest: route.wireCapabilityDigest,
        signedManifest: Object.freeze({
          format: HOSTED_APPROVAL_ACTIVATION_MANIFEST_FORMAT,
          manifestDigest: admission.manifestDigest,
          releasePinDigest: admission.releasePinDigest,
          launcherKeyId: admission.launcherKeyId,
        }),
      });
      const lease = await activation({
        binding,
        admissionDocument: dependencies.activationPublication.admissionDocument,
        proofKey: dependencies.ownerProofKey,
        signingIdentity: dependencies.activationPublication.signingIdentity,
        ...(dependencies.approvalActivationTimeoutMs === undefined
          ? {}
          : { timeoutMs: dependencies.approvalActivationTimeoutMs }),
        onOwnerLoss: () => {
          closeActivatedSurface();
          dependencies.onApprovalOwnerLoss?.(
            new Error('hosted-approval-production-activation-owner-lost')
          );
        },
      });
      if (closed || !sameHostedApprovalActivationOwner(lease, ownerBinding)) {
        lease.invalidate();
        throw new Error('hosted-approval-production-activation-ready-invalid');
      }
      activationLeases.push(lease);
    }
  } catch (error) {
    closeActivatedSurface();
    throw error;
  }
  try {
    const routes = admission.approvalRoutes.map((route, index) => {
      const teamId = parseTeamId(route.teamId);
      const activationLease = activationLeases[index];
      if (!activationLease) {
        throw new Error('hosted-approval-production-activation-lease-missing');
      }
      const authority = new HostedApprovalRuntimeOrchestratorAuthority({
        lease: createApprovalRouteMutationLease(admission, route, activationLease),
        ownerProofKey: dependencies.ownerProofKey,
        authority: wireAuthority,
        getAdmittedIngressAuthority: async (candidate) =>
          candidate.teamId === teamId
            ? privateAuthority.getAdmittedIngressAuthority(candidate)
            : null,
      });
      return Object.freeze({ teamId, authority });
    });
    const createdRouter = new HostedApprovalRuntimeOrchestratorRouter(routes);
    router = createdRouter;
    const createdOperator = createHostedOperatorProductionComposition({
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
        ingressEffectOutbox: createdRouter,
        ingressAuthority: createdRouter,
        externalDecisionDelivery: createdRouter,
        externalDecisionReconciliation: createdRouter,
      },
      routeAdmissionBinding: dependencies.routeAdmissionBinding,
    });
    operator = createdOperator;
    return Object.freeze({
      isReady: () =>
        !closed && activationLeases.every((lease) => lease.isReady()) && createdOperator.isReady(),
      reconcileApprovalDecision: createdOperator.reconcileApprovalDecision.bind(createdOperator),
      register(app: Parameters<HostedOperatorProductionComposition['register']>[0]): void {
        if (closed || activationLeases.some((lease) => !lease.isReady())) {
          throw new Error('hosted-approval-production-activation-unavailable');
        }
        createdOperator.register(app);
      },
      close(): void {
        closeActivatedSurface();
      },
    });
  } catch (error) {
    closeActivatedSurface();
    throw error;
  }
}

function createApprovalRouteMutationLease(
  admission: HostedLifecycleProductionOwnerAdmission,
  route: HostedLifecycleProductionOwnerAdmission['approvalRoutes'][number],
  activationLease: HostedApprovalRuntimeActivationLease
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
    currentBinding: () =>
      invalidated || !sameHostedApprovalActivationOwner(activationLease, binding) ? null : binding,
    invalidate: () => {
      invalidated = true;
      activationLease.invalidate();
    },
  });
}
