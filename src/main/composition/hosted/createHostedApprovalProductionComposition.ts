import { createHash } from 'node:crypto';

import {
  bindProductHostedProducerInstance,
  clearProductHostedProducerProvenance,
  type HostedProducerProvenance,
} from '@features/hosted-producer-provenance/main';
// eslint-disable-next-line no-restricted-imports -- Production composition consumes bounded hosted approval facets.
import {
  createHostedApprovalAdmissionAuthority,
  HostedApprovalRuntimeOrchestratorAuthority,
  type HostedApprovalRuntimeOrchestratorAuthorityOptions,
  type HostedApprovalRuntimeOrchestratorRoute,
  HostedApprovalRuntimeOrchestratorRouter,
  type HostedApprovalRuntimeWireAuthority,
  parseHostedApprovalRuntimeWireAuthority,
} from '@features/team-approvals/main/hosted';
import { parseActorId, parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';

import {
  activateHostedApprovalRuntime,
  activateHostedApprovalRuntimeOverConnectedTransport,
  assertHostedApprovalRuntimeActivationPreflight,
  closeHostedApprovalRuntimeConnectedTransport,
  HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
  HOSTED_APPROVAL_ACTIVATION_MANIFEST_FORMAT,
  type HostedActualOwnerCandidateOpenCodeSha256,
  type HostedApprovalRuntimeActivationBinding,
  type HostedApprovalRuntimeActivationLease,
  type HostedApprovalRuntimeActivationOptions,
  type HostedApprovalRuntimeActivationPublicationContract,
  type HostedApprovalRuntimeConnectedTransport,
  sameHostedApprovalActivationOwner,
} from '../../services/team/provisioning/HostedApprovalRuntimeActivationEnvelope';

import {
  bindHostedApprovalStorageGateway,
  createHostedOperatorProductionCompositionFromPlan,
  type HostedOperatorProductionComposition,
  resolveHostedOperatorProductionCompositionPlan,
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
    options: HostedApprovalRuntimeActivationOptions,
    transport?: HostedApprovalRuntimeConnectedTransport,
    expectedOpenCodeExecutableSha256?: HostedActualOwnerCandidateOpenCodeSha256
  ) => Promise<HostedApprovalRuntimeActivationLease>;
  /** Deterministic transport seam for composition regressions; production uses the real authority. */
  readonly createApprovalRuntimeAuthority?: (
    options: HostedApprovalRuntimeOrchestratorAuthorityOptions
  ) => HostedApprovalRuntimeOrchestratorRoute['authority'];
  /** Explicit sandbox-candidate handoff; never inferred from environment or runtime manifests. */
  readonly inheritedCandidateActivation?: Readonly<{
    transport: HostedApprovalRuntimeConnectedTransport;
    expectedOpenCodeExecutableSha256: HostedActualOwnerCandidateOpenCodeSha256;
  }>;
  readonly approvalActivationTimeoutMs?: number;
  readonly onApprovalOwnerLoss?: (error: Error) => void;
  readonly producerProvenance: HostedProducerProvenance;
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
  readonly createApprovalRuntimeAuthority?: CreateHostedApprovalProductionCompositionDependencies['createApprovalRuntimeAuthority'];
  readonly inheritedCandidateActivation?: CreateHostedApprovalProductionCompositionDependencies['inheritedCandidateActivation'];
  readonly approvalActivationTimeoutMs?: number;
  readonly onApprovalOwnerLoss?: (error: Error) => void;
  readonly producerProvenance?: HostedProducerProvenance;
}

export async function createOptionalHostedApprovalProductionComposition(
  dependencies: CreateOptionalHostedApprovalProductionCompositionDependencies
): Promise<HostedOperatorProductionComposition | null> {
  const inheritedCandidate = dependencies.inheritedCandidateActivation;
  const candidateActivation =
    inheritedCandidate === undefined
      ? undefined
      : Object.freeze({
          transport: Object.freeze({ socket: inheritedCandidate.transport.socket }),
          expectedOpenCodeExecutableSha256: inheritedCandidate.expectedOpenCodeExecutableSha256,
        });
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
    if (candidateActivation !== undefined) {
      closeHostedApprovalRuntimeConnectedTransport(candidateActivation.transport);
    }
    return null;
  }
  if (dependencies.producerProvenance === undefined) {
    if (candidateActivation !== undefined) {
      closeHostedApprovalRuntimeConnectedTransport(candidateActivation.transport);
    }
    throw new TypeError('hosted-production-producer-provenance-required');
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
    ...(dependencies.createApprovalRuntimeAuthority === undefined
      ? {}
      : { createApprovalRuntimeAuthority: dependencies.createApprovalRuntimeAuthority }),
    ...(candidateActivation === undefined
      ? {}
      : { inheritedCandidateActivation: candidateActivation }),
    ...(dependencies.approvalActivationTimeoutMs === undefined
      ? {}
      : { approvalActivationTimeoutMs: dependencies.approvalActivationTimeoutMs }),
    ...(dependencies.onApprovalOwnerLoss === undefined
      ? {}
      : { onApprovalOwnerLoss: dependencies.onApprovalOwnerLoss }),
    producerProvenance: dependencies.producerProvenance,
  });
}

/**
 * Mounts approvals only from the launcher-signed v4 route catalog. Every runtime effect is routed
 * from its immutable team partition; browser state and process-global team selection are absent.
 */
export async function createHostedApprovalProductionComposition(
  dependencies: CreateHostedApprovalProductionCompositionDependencies
): Promise<HostedOperatorProductionComposition> {
  if (dependencies.producerProvenance === undefined) {
    throw new TypeError('hosted-production-producer-provenance-required');
  }
  const inheritedCandidate = dependencies.inheritedCandidateActivation;
  const candidateActivation =
    inheritedCandidate === undefined
      ? undefined
      : Object.freeze({
          transport: Object.freeze({ socket: inheritedCandidate.transport.socket }),
          expectedOpenCodeExecutableSha256: inheritedCandidate.expectedOpenCodeExecutableSha256,
        });
  try {
    return await createHostedApprovalProductionCompositionAfterPrechecks(
      dependencies,
      candidateActivation
    );
  } catch (error) {
    if (candidateActivation !== undefined) {
      closeHostedApprovalRuntimeConnectedTransport(candidateActivation.transport);
    }
    throw error;
  }
}

async function createHostedApprovalProductionCompositionAfterPrechecks(
  dependencies: CreateHostedApprovalProductionCompositionDependencies,
  candidateActivation:
    | CreateHostedApprovalProductionCompositionDependencies['inheritedCandidateActivation']
    | undefined
): Promise<HostedOperatorProductionComposition> {
  const admission = dependencies.ownerAdmission;
  const runtimeInstance = Object.freeze({
    ...dependencies.runtimeInstance,
    claudeRoot: Object.freeze({ ...dependencies.runtimeInstance.claudeRoot }),
    appDataRoot: Object.freeze({ ...dependencies.runtimeInstance.appDataRoot }),
    workspaceRoots: Object.freeze(
      dependencies.runtimeInstance.workspaceRoots.map((root) => Object.freeze({ ...root }))
    ),
    tempRoot: Object.freeze({ ...dependencies.runtimeInstance.tempRoot }),
    logsRoot: Object.freeze({ ...dependencies.runtimeInstance.logsRoot }),
  });
  const expectedDeploymentId = dependencies.expectedDeploymentId;
  const actorId = dependencies.actorId;
  const mountBinding = Object.freeze({ ...dependencies.mountBinding });
  const restoreGeneration = dependencies.restoreGeneration;
  const listTeamIdentities = dependencies.teamIdentities.listTeamIdentities;
  const teamIdentities = Object.freeze({
    getTeamIdentity: dependencies.teamIdentities.getTeamIdentity.bind(dependencies.teamIdentities),
    listTeamIdentities:
      typeof listTeamIdentities === 'function'
        ? listTeamIdentities.bind(dependencies.teamIdentities)
        : async () => Object.freeze([]),
  });
  const routeAuthority = captureHostedApprovalRouteAuthority(dependencies, admission);
  const authentication = Object.freeze({
    authenticatedPrincipalFor: dependencies.authentication.authenticatedPrincipalFor.bind(
      dependencies.authentication
    ),
  });
  const approvalStorage = bindHostedApprovalStorageGateway(dependencies.approvalStorage);
  const ownerProofKey = dependencies.ownerProofKey;
  const approvalActivationTimeoutMs = dependencies.approvalActivationTimeoutMs;
  const onApprovalOwnerLoss = dependencies.onApprovalOwnerLoss;
  const producerProvenance = dependencies.producerProvenance;
  const createApprovalRuntimeAuthority =
    dependencies.createApprovalRuntimeAuthority ??
    ((options: HostedApprovalRuntimeOrchestratorAuthorityOptions) =>
      new HostedApprovalRuntimeOrchestratorAuthority(options));
  const approvalAdmission = Object.freeze({ ...admission.approvalAdmission });
  const bootstrapBinding = Object.freeze({ ...admission.bootstrapBinding });
  const routeCatalog = routeAuthority.routeCatalog;
  const expectedOwnerBinding = routeAuthority.expectedOwnerBinding;
  const ownerAuthority = admission.ownerAuthority;
  if (producerProvenance !== undefined) {
    bindProductHostedProducerInstance(producerProvenance, {
      deploymentId: runtimeInstance.deploymentId,
      bootId: runtimeInstance.bootId,
      ownerAuthority,
      ownerGeneration: expectedOwnerBinding.ownerGeneration,
      ownerSessionId: expectedOwnerBinding.ownerSessionId,
    });
  }
  const signedManifest = Object.freeze({
    format: HOSTED_APPROVAL_ACTIVATION_MANIFEST_FORMAT,
    manifestDigest: admission.manifestDigest,
    releasePinDigest: admission.releasePinDigest,
    launcherKeyId: admission.launcherKeyId,
  });
  if (candidateActivation !== undefined && routeCatalog.length !== 1) {
    throw new TypeError('hosted-approval-production-inherited-activation-route-count-invalid');
  }
  const workspaceId = parseWorkspaceId(bootstrapBinding.workspaceId);
  if (
    routeCatalog.length === 0 ||
    admission.approvalSnapshot === null ||
    approvalAdmission.state !== 'active' ||
    runtimeInstance.deploymentId !== bootstrapBinding.deploymentId ||
    runtimeInstance.bootId !== bootstrapBinding.bootId ||
    mountBinding.workspaceId !== workspaceId ||
    mountBinding.bootId !== runtimeInstance.bootId ||
    mountBinding.mountGeneration !== bootstrapBinding.mountGeneration
  ) {
    throw new TypeError('hosted-approval-production-admission-binding-invalid');
  }

  const privateAuthority = createHostedApprovalAdmissionAuthority({
    pin: approvalAdmission,
    snapshot: admission.approvalSnapshot,
  });
  if (privateAuthority === null) {
    throw new TypeError('hosted-approval-production-private-authority-invalid');
  }
  const activationPublication = Object.freeze({
    admissionDocument: dependencies.activationPublication.admissionDocument,
    admissionDocumentDigest: dependencies.activationPublication.admissionDocumentDigest,
    signingIdentity: Object.freeze({
      privateKey: dependencies.activationPublication.signingIdentity.privateKey,
      publicKeySpkiDer: new Uint8Array(
        dependencies.activationPublication.signingIdentity.publicKeySpkiDer
      ),
      publicKeyDigest: dependencies.activationPublication.signingIdentity.publicKeyDigest,
      contractDigest: dependencies.activationPublication.signingIdentity.contractDigest,
    }),
  });

  const wireAuthority: HostedApprovalRuntimeWireAuthority = parseHostedApprovalRuntimeWireAuthority(
    Object.freeze({
      actorId: parseActorId(actorId),
      deploymentId: runtimeInstance.deploymentId,
      bootId: runtimeInstance.bootId,
      restoreGeneration,
      workspaceId,
      mountBinding: Object.freeze({
        mountGeneration: mountBinding.mountGeneration,
        declaredRootHash: mountBinding.declaredRootHash,
      }),
    })
  );
  const approvalTeamIds = Object.freeze(routeCatalog.map((route) => parseTeamId(route.teamId)));
  const routeAdmissionBinding = Object.freeze({
    routeCatalog: dependencies.routeAdmissionBinding.routeCatalog,
    routeAdmission: dependencies.routeAdmissionBinding.routeAdmission,
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
    if (producerProvenance !== undefined) {
      producerProvenance.close();
      clearProductHostedProducerProvenance(producerProvenance);
    }
  };
  producerProvenance?.bindInvalidation(() => closeActivatedSurface());
  const activation: NonNullable<
    CreateHostedApprovalProductionCompositionDependencies['activateApprovalRuntime']
  > =
    dependencies.activateApprovalRuntime ??
    ((options: HostedApprovalRuntimeActivationOptions) =>
      candidateActivation === undefined
        ? activateHostedApprovalRuntime(options)
        : activateHostedApprovalRuntimeOverConnectedTransport(
            options,
            candidateActivation.transport,
            candidateActivation.expectedOpenCodeExecutableSha256
          ));
  const activationRequests = routeCatalog.map((route) => {
    const ownerBinding = Object.freeze({
      ownerAuthority,
      ownerGeneration: route.ownerGeneration,
      ownerSessionId: route.ownerSessionId,
      socketIdentity: Object.freeze({ ...route.socketIdentity }),
    });
    const binding: HostedApprovalRuntimeActivationBinding = Object.freeze({
      deploymentId: runtimeInstance.deploymentId,
      bootId: runtimeInstance.bootId,
      workspaceId: route.workspaceId,
      teamId: route.teamId,
      restoreGeneration,
      mountBinding: Object.freeze({
        mountGeneration: mountBinding.mountGeneration,
        declaredRootHash: mountBinding.declaredRootHash,
      }),
      ownerBinding,
      socketPath: route.socketPath,
      approvalGeneration: route.approvalGeneration,
      admissionOwnerGeneration: approvalAdmission.ownerGeneration,
      approvalDigest: route.approvalDigest,
      admissionDocumentDigest: activationPublication.admissionDocumentDigest,
      artifactDigest: route.artifactDigest,
      activationCapability: HOSTED_APPROVAL_ACTIVATION_CAPABILITY,
      wireCapabilityDigest: route.wireCapabilityDigest,
      signedManifest,
    });
    const options: HostedApprovalRuntimeActivationOptions = Object.freeze({
      binding,
      admissionDocument: activationPublication.admissionDocument,
      proofKey: ownerProofKey,
      signingIdentity: activationPublication.signingIdentity,
      ...(approvalActivationTimeoutMs === undefined
        ? {}
        : { timeoutMs: approvalActivationTimeoutMs }),
      onOwnerLoss: () => {
        closeActivatedSurface();
        onApprovalOwnerLoss?.(new Error('hosted-approval-production-activation-owner-lost'));
      },
    });
    assertHostedApprovalRuntimeActivationPreflight(
      options,
      candidateActivation?.expectedOpenCodeExecutableSha256
    );
    return Object.freeze({ ownerBinding, options });
  });
  const operatorPlan = await resolveHostedOperatorProductionCompositionPlan({
    runtimeInstance,
    expectedDeploymentId,
    workspaceId,
    mountGeneration: mountBinding.mountGeneration,
    restoreGeneration,
    teamIds: approvalTeamIds,
    teamIdentities,
  });
  routeAuthority.assertCurrent();
  const activationResults = await Promise.allSettled(
    activationRequests.map((request) =>
      activation(
        request.options,
        candidateActivation?.transport,
        candidateActivation?.expectedOpenCodeExecutableSha256
      )
    )
  );
  try {
    routeAuthority.assertCurrent();
    const rejected = activationResults.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected'
    );
    if (rejected !== undefined) throw rejected.reason;
    for (const [index, result] of activationResults.entries()) {
      if (result.status !== 'fulfilled') throw result.reason;
      const request = activationRequests[index];
      if (
        request === undefined ||
        closed ||
        !sameHostedApprovalActivationOwner(result.value, request.ownerBinding)
      ) {
        result.value.invalidate();
        throw new Error('hosted-approval-production-activation-ready-invalid');
      }
      activationLeases.push(result.value);
    }
  } catch (error) {
    for (const result of activationResults) {
      if (result.status === 'fulfilled') result.value.invalidate();
    }
    closeActivatedSurface();
    throw error;
  }
  try {
    routeAuthority.assertCurrent();
    const routes = routeCatalog.map((route, index) => {
      const teamId = approvalTeamIds[index];
      if (teamId === undefined) {
        throw new Error('hosted-approval-production-route-plan-missing');
      }
      const activationLease = activationLeases[index];
      const request = activationRequests[index];
      if (!activationLease || request === undefined) {
        throw new Error('hosted-approval-production-activation-lease-missing');
      }
      const authority = createApprovalRuntimeAuthority({
        lease: createApprovalRouteMutationLease(
          route.socketPath,
          request.ownerBinding,
          activationLease
        ),
        ownerProofKey,
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
    const createdOperator = createHostedOperatorProductionCompositionFromPlan(
      {
        authentication,
        runtimeInstance,
        expectedDeploymentId,
        workspaceId,
        mountGeneration: mountBinding.mountGeneration,
        restoreGeneration,
        teamIdentities,
        approvalStorage,
        approvalRuntime: {
          teamIds: operatorPlan.approvalTeamIds,
          ownerId: `approval-owner:${expectedOwnerBinding.ownerSessionId}`,
          leaseToken: `approval-lease:${expectedOwnerBinding.ownerGeneration}:${expectedOwnerBinding.ownerSessionId}`,
          ingressEffectOutbox: createdRouter,
          ingressAuthority: createdRouter,
          externalDecisionDelivery: createdRouter,
          externalDecisionReconciliation: createdRouter,
        },
        routeAdmissionBinding,
        producerProvenance,
      },
      operatorPlan
    );
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

interface HostedApprovalRouteAuthorityTransaction {
  readonly version: HostedApprovalRouteAuthorityVersion;
  readonly routeCatalog: HostedLifecycleProductionOwnerAdmission['approvalRoutes'];
  readonly expectedOwnerBinding: HostedLifecycleProductionOwnerAdmission['expectedOwnerBinding'];
  assertCurrent(): void;
}

interface HostedApprovalRouteAuthorityVersion {
  readonly routeDigest: string;
  readonly authentication: CreateHostedApprovalProductionCompositionDependencies['authentication'];
  readonly authenticatedPrincipalFor: CreateHostedApprovalProductionCompositionDependencies['authentication']['authenticatedPrincipalFor'];
  readonly approvalStorage: HostedTeamApprovalAuthorityStorageGateway;
  readonly approvalStorageMethods: Pick<
    HostedTeamApprovalAuthorityStorageGateway,
    (typeof HOSTED_APPROVAL_STORAGE_GATEWAY_METHODS)[number]
  >;
}

const HOSTED_APPROVAL_STORAGE_GATEWAY_METHODS = Object.freeze([
  'hostedTeamApprovalObserve',
  'hostedTeamApprovalReadPending',
  'hostedTeamApprovalReadPreview',
  'hostedTeamApprovalDecide',
  'hostedTeamApprovalClaimDeliveries',
  'hostedTeamApprovalAcknowledgeDelivery',
  'hostedTeamApprovalMarkDeliveryOperatorRequired',
  'hostedTeamApprovalReadDeliveryReconciliation',
  'hostedTeamApprovalSettleDeliveryReconciliation',
  'hostedTeamApprovalAuditTimeouts',
] as const satisfies readonly (keyof HostedTeamApprovalAuthorityStorageGateway)[]);

function captureHostedApprovalRouteAuthority(
  dependencies: CreateHostedApprovalProductionCompositionDependencies,
  admission: HostedLifecycleProductionOwnerAdmission
): HostedApprovalRouteAuthorityTransaction {
  const routeArray = admission.approvalRoutes;
  const routeReferences = Object.freeze([...routeArray]);
  const socketReferences = Object.freeze(routeArray.map((route) => route.socketIdentity));
  const ownerBindingReference = admission.expectedOwnerBinding;
  const ownerSocketReference = ownerBindingReference.socketIdentity;
  const approvalSnapshotReference = admission.approvalSnapshot;
  const authenticationReference = dependencies.authentication;
  const approvalStorageReference = dependencies.approvalStorage;
  const approvalStorageMethodReferences = Object.freeze(
    Object.fromEntries(
      HOSTED_APPROVAL_STORAGE_GATEWAY_METHODS.map((method) => [
        method,
        approvalStorageReference[method],
      ])
    ) as Pick<
      HostedTeamApprovalAuthorityStorageGateway,
      (typeof HOSTED_APPROVAL_STORAGE_GATEWAY_METHODS)[number]
    >
  );
  const version: HostedApprovalRouteAuthorityVersion = Object.freeze({
    routeDigest: hostedApprovalRouteAuthorityVersion(admission),
    authentication: authenticationReference,
    authenticatedPrincipalFor: authenticationReference.authenticatedPrincipalFor,
    approvalStorage: approvalStorageReference,
    approvalStorageMethods: approvalStorageMethodReferences,
  });
  const routeCatalog = Object.freeze(
    routeArray.map((route) =>
      Object.freeze({
        ...route,
        socketIdentity: Object.freeze({ ...route.socketIdentity }),
      })
    )
  );
  const expectedOwnerBinding = Object.freeze({
    ...ownerBindingReference,
    socketIdentity: Object.freeze({ ...ownerSocketReference }),
  });
  return Object.freeze({
    version,
    routeCatalog,
    expectedOwnerBinding,
    assertCurrent(): void {
      if (
        dependencies.ownerAdmission !== admission ||
        dependencies.authentication !== version.authentication ||
        dependencies.authentication.authenticatedPrincipalFor !==
          version.authenticatedPrincipalFor ||
        dependencies.approvalStorage !== version.approvalStorage ||
        HOSTED_APPROVAL_STORAGE_GATEWAY_METHODS.some(
          (method) =>
            dependencies.approvalStorage[method] !== version.approvalStorageMethods[method]
        ) ||
        admission.approvalRoutes !== routeArray ||
        admission.expectedOwnerBinding !== ownerBindingReference ||
        admission.expectedOwnerBinding.socketIdentity !== ownerSocketReference ||
        admission.approvalSnapshot !== approvalSnapshotReference ||
        routeArray.length !== routeReferences.length ||
        routeReferences.some(
          (route, index) =>
            routeArray[index] !== route ||
            routeArray[index]?.socketIdentity !== socketReferences[index]
        ) ||
        hostedApprovalRouteAuthorityVersion(admission) !== version.routeDigest
      ) {
        throw new Error('hosted-approval-production-route-binding-invalid');
      }
    },
  });
}

function hostedApprovalRouteAuthorityVersion(
  admission: HostedLifecycleProductionOwnerAdmission
): string {
  return createHash('sha256')
    .update(
      JSON.stringify({
        manifestDigest: admission.manifestDigest,
        releasePinDigest: admission.releasePinDigest,
        ownerAuthority: admission.ownerAuthority,
        expectedOwnerBinding: admission.expectedOwnerBinding,
        approvalAdmission: admission.approvalAdmission,
        approvalSnapshot: admission.approvalSnapshot,
        approvalRoutes: admission.approvalRoutes,
      })
    )
    .digest('hex');
}

function createApprovalRouteMutationLease(
  socketPath: string,
  binding: HostedApprovalRuntimeActivationBinding['ownerBinding'],
  activationLease: HostedApprovalRuntimeActivationLease
): TeamLifecycleCommandMutationLease {
  let invalidated = false;
  return Object.freeze({
    socketPath,
    currentBinding: () =>
      invalidated || !sameHostedApprovalActivationOwner(activationLease, binding) ? null : binding,
    invalidate: () => {
      invalidated = true;
      activationLease.invalidate();
    },
  });
}
