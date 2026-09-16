import { createHash, createPublicKey, generateKeyPairSync, type KeyObject,sign } from 'node:crypto';

import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS } from '@features/team-approvals/main/hosted';
import { HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY_DIGEST } from '@features/team-approvals/main/hosted';

import { createHostedRouteAdmissionBinding, HOSTED_READINESS_DIMENSIONS, HOSTED_TERMINAL_READINESS, type HostedReadinessDimensionStates } from '../../../../../src/main/composition/hosted/application';
import { APPROVAL_GENERATION_TRANSITION, type ApprovalGenerationTransition,approvalGenerationTransitionSigningBytes } from '../../../../../src/main/composition/hosted/hostedApprovalGenerationTransitionContract';
import { NATIVE_ACTIVATION_HANDLE_CONTRACT, type NativeActivationHandleSelection } from '../../../../../src/main/composition/hosted/hostedNativeActivationHandleContract';
import { NATIVE_SUCCESSOR_HANDLE, type NativeSuccessorHandle,nativeSuccessorHandleSigningBytes } from '../../../../../src/main/composition/hosted/hostedNativeSuccessorHandleContract';
import { HOSTED_ACTUAL_OWNER_CANDIDATE_OPENCODE_SHA256 } from '../../../../../src/main/services/team/provisioning/HostedApprovalRuntimeActivationEnvelope';

import type { CreateHostedApprovalProductionCompositionDependencies, CreateOptionalHostedApprovalProductionCompositionDependencies } from '../../../../../src/main/composition/hosted/createHostedApprovalProductionComposition';
import type { NativeActivationSocketIdentity } from '../../../../../src/main/composition/hosted/hostedNativeActivationSocketIdentity';
import type { HostedApprovalRuntimeActivationLease, HostedApprovalRuntimeActivationOptions } from '../../../../../src/main/services/team/provisioning/HostedApprovalRuntimeActivationEnvelope';
const TEAM_ID = `team_${'1'.repeat(32)}`;
const WORKSPACE_ID = 'workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
const ARTIFACT_DIGEST = `sha256:${'4'.repeat(64)}` as const;
const WIRE_DIGEST = HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY_DIGEST;
const PROOF_KEY = '00'.repeat(32) as never;
const SNAPSHOT = Object.freeze({
  schemaVersion: 1,
  approvalGeneration: 3,
  authorities: Object.freeze([
    Object.freeze({
      deploymentId: 'deployment_activation-test',
      teamId: TEAM_ID,
      runId: `run_${'9'.repeat(32)}`,
      planGeneration: 7,
      laneId: 'primary',
      providerId: 'opencode',
      credentialGeneration: 5,
      credentialId: 'credential_activation-test',
      sessionId: 'session_activation-test',
      runtimeInstanceId: `runtime_instance_${'a'.repeat(32)}`,
      deliveryOwnerId: `member_${'b'.repeat(32)}`,
    }),
  ]),
});
const APPROVAL_DIGEST = `sha256:${createHash('sha256')
  .update(JSON.stringify(SNAPSHOT))
  .digest('hex')}` as const;
const ADMISSION_DOCUMENT = `${JSON.stringify({
  schemaVersion: 1,
  admissionGeneration: 'approval-admission-generation_3_owner_7',
  outerAuthority: {
    deploymentId: 'deployment_activation-test',
    bootId: 'boot_activation-test',
    workspaceId: WORKSPACE_ID,
    teamId: TEAM_ID,
    restoreGeneration: 4,
    mountBinding: { mountGeneration: 9, declaredRootHash: '2'.repeat(64) },
  },
  routes: [
    {
      routeId: 'route_activation-test',
      authority: SNAPSHOT.authorities[0],
      scope: {
        principalId: 'actor_activation-test',
        workspaceId: WORKSPACE_ID,
        teamId: TEAM_ID,
        authorityGeneration: 'generation_activation-test',
        restoreGeneration: 4,
      },
      memberName: 'member-activation-test',
      openCodeBinding: {
        toolApprovalMode: 'manual',
        planGeneration: 7,
        credentialGeneration: 5,
        credentialId: 'credential_activation-test',
        runtimeInstanceId: `runtime_instance_${'a'.repeat(32)}`,
        deliveryOwnerId: `member_${'b'.repeat(32)}`,
        openCodeArtifactDigest: `sha256:${HOSTED_ACTUAL_OWNER_CANDIDATE_OPENCODE_SHA256}`,
        sessionRecordFingerprint: 'c'.repeat(64),
        liveEffectFingerprint: 'd'.repeat(64),
      },
    },
  ],
  actorMembers: { 'actor_activation-test': `member_${'b'.repeat(32)}` },
})}\n`;
const ADMISSION_DOCUMENT_DIGEST = `sha256:${createHash('sha256')
  .update(ADMISSION_DOCUMENT)
  .digest('hex')}` as const;
const ACTIVATION_KEYS = generateKeyPairSync('ed25519');
const ACTIVATION_SPKI = createPublicKey(ACTIVATION_KEYS.privateKey).export({
  format: 'der',
  type: 'spki',
});
const ACTIVATION_PUBLIC_KEY_DIGEST = `sha256:${createHash('sha256')
  .update(ACTIVATION_SPKI)
  .digest('hex')}` as const;

function dependencies(
  activateApprovalRuntime: (
    options: HostedApprovalRuntimeActivationOptions
  ) => Promise<HostedApprovalRuntimeActivationLease>
): CreateHostedApprovalProductionCompositionDependencies {
  return {
    authentication: { authenticatedPrincipalFor: () => null },
    runtimeInstance: createRuntimeInstanceContext({
      deploymentId: 'deployment_activation-test',
      bootId: 'boot_activation-test',
      claudeRoot: { kind: 'claude', reference: 'isolated:claude' },
      appDataRoot: { kind: 'app-data', reference: 'isolated:app-data' },
      workspaceRoots: [{ kind: 'workspace', reference: 'isolated:workspace' }],
      tempRoot: { kind: 'temp', reference: 'isolated:temp' },
      logsRoot: { kind: 'logs', reference: 'isolated:logs' },
    }),
    expectedDeploymentId: 'deployment_activation-test',
    actorId: 'actor_activation-test',
    mountBinding: {
      workspaceId: WORKSPACE_ID,
      bootId: 'boot_activation-test',
      mountGeneration: 9,
      declaredRootHash: '2'.repeat(64),
    } as never,
    restoreGeneration: 4,
    teamIdentities: {
      getTeamIdentity: (async (teamId: string) =>
        Object.freeze({
          teamId,
          state: 'active',
          workspaceBinding: Object.freeze({ workspaceId: WORKSPACE_ID, generation: 9 }),
        })
      ),
    } as never,
    approvalStorage: {
      hostedTeamApprovalObserve: (() => undefined as never),
      hostedTeamApprovalReadPending: (() => undefined as never),
      hostedTeamApprovalReadPreview: (() => undefined as never),
      hostedTeamApprovalDecide: (() => undefined as never),
      hostedTeamApprovalAuditTimeouts: (async () => ({
        resolvedCount: 0,
        nextAuditTimeMs: null,
      })),
      hostedTeamApprovalClaimDeliveries: (async () => Object.freeze([])),
      hostedTeamApprovalAcknowledgeDelivery: (() => undefined as never),
      hostedTeamApprovalMarkDeliveryOperatorRequired: (() => undefined as never),
      hostedTeamApprovalReadDeliveryReconciliation: (async () => ({
        kind: 'not_found' as const,
      })),
      hostedTeamApprovalSettleDeliveryReconciliation: (() => undefined as never),
    },
    producerProvenance: {
      role: 'product-producer',
      controllerNonce: 'controller_activation-test',
      runId: 'run_activation-test',
      emit: (() => undefined as never),
      bindInvalidation: (() => undefined as never),
      poison: ((reason: string) => { throw new Error(reason); }),
      close: (() => undefined as never),
    },
    createApprovalRuntimeAuthority: (options) => ({
      claimPermissionApprovalIngressEffects: (async () => {
        if (options.lease.currentBinding() === null) {
          throw new Error('test-route-binding-unavailable');
        }
        return Object.freeze([]);
      }),
      acknowledgePermissionApprovalIngressEffect: (async () => ({
        status: 'acknowledged' as const,
      })),
      resolvePersistedIngressAuthority: (async () => ({ status: 'unavailable' as const })),
      deliverRuntimePermissionDecision: (async (request) => ({
        status: 'delivered' as const,
        reconciliationRef: request.reconciliationRef,
      })),
      reconcileRuntimePermissionDecision: (async () => ({ status: 'delivered' as const })),
      close: (() => undefined as never),
    }),
    routeAdmissionBinding: {} as never,
    ownerAdmission: {
      artifactDigest: ARTIFACT_DIGEST,
      imageReference: `example.invalid/owner@${ARTIFACT_DIGEST}`,
      artifactVersion: '1.0.0',
      protocolVersion: 2,
      launcherPublicKey: 'x'.repeat(43),
      launcherKeyId: '8'.repeat(64),
      ownerAuthority: 'owner-authority_activation-test',
      expectedOwnerBinding: {
        ownerAuthority: 'owner-authority_activation-test',
        ownerGeneration: 7,
        ownerSessionId: 'owner-session_activation-test',
        socketIdentity: { device: '11', inode: '12', uid: 1000, gid: 1000, mode: 0o600 },
      },
      bootstrapBinding: {
        deploymentId: 'deployment_activation-test',
        bootId: 'boot_activation-test',
        workspaceId: WORKSPACE_ID,
        mountGeneration: 9,
        bootstrapDigest: '1'.repeat(64),
        ownerArtifactDigest: ARTIFACT_DIGEST,
        proofKeyId: '0'.repeat(64),
      },
      manifestDigest: `sha256:${'6'.repeat(64)}`,
      releasePinDigest: `sha256:${'7'.repeat(64)}`,
      approvalAdmission: {
        state: 'active',
        approvalGeneration: 3,
        approvalDigest: APPROVAL_DIGEST,
        ownerGeneration: 7,
      },
      approvalSnapshot: SNAPSHOT,
      approvalRoutes: [
        {
          teamId: TEAM_ID,
          workspaceId: WORKSPACE_ID,
          ownerGeneration: 7,
          ownerSessionId: 'owner-session_activation-test',
          socketPath: '/run/agent-teams-orchestrator/approval-test.sock',
          socketIdentity: { device: '11', inode: '12', uid: 1000, gid: 1000, mode: 0o600 },
          artifactDigest: ARTIFACT_DIGEST,
          approvalGeneration: 3,
          approvalDigest: APPROVAL_DIGEST,
          wireCapabilityDigest: WIRE_DIGEST,
        },
      ],
    } as never,
    ownerProofKey: PROOF_KEY,
    activationPublication: {
      admissionDocument: ADMISSION_DOCUMENT,
      admissionDocumentDigest: ADMISSION_DOCUMENT_DIGEST,
      signingIdentity: {
        privateKey: ACTIVATION_KEYS.privateKey,
        publicKeySpkiDer: ACTIVATION_SPKI,
        publicKeyDigest: ACTIVATION_PUBLIC_KEY_DIGEST,
        contractDigest: `sha256:${'9'.repeat(64)}` as const,
      },
    },
    activateApprovalRuntime,
  };
}


/** Test-only keys and storage/permission-port fixture; the production constructor
 * and the socket ActivationV2 exchange are not replaced. */
export function generationFixture(launcherPrivateKey?: KeyObject) {
  const base = dependencies(async () => { throw new Error('unused activation seam'); });
  const launcher = launcherPrivateKey ? { privateKey: launcherPrivateKey, publicKey: createPublicKey(launcherPrivateKey) } : generateKeyPairSync('ed25519');
  const publicKey = launcher.publicKey.export({ format: 'jwk' }).x!;
  const bootstrap = JSON.stringify({ format: 'test-bootstrap', issuedAtMs: 1, expiresAtMs: 9999999999999,
    actorId: base.actorId, authorizedScope: {}, deploymentId: base.runtimeInstance.deploymentId,
    bootId: base.runtimeInstance.bootId, workspaceId: WORKSPACE_ID, runtimeInstance: base.runtimeInstance,
    workspaceManifest: { version: 1, registrations: [{ workspaceId: WORKSPACE_ID, mountBinding: base.mountBinding }] },
  });
  const bootstrapBinding = { ...base.ownerAdmission.bootstrapBinding,
    bootstrapDigest: createHash('sha256').update(bootstrap).digest('hex') };
  const owner = (generation: number) => {
    const ownerSessionId = `owner-session_generation-${generation}`;
    return { ...base.ownerAdmission, launcherPublicKey: publicKey,
      launcherKeyId: createHash('sha256').update(Buffer.from(publicKey, 'base64url')).digest('hex'),
      bootstrapBinding,
      expectedOwnerBinding: { ...base.ownerAdmission.expectedOwnerBinding, ownerGeneration: generation, ownerSessionId },
      approvalAdmission: { state: 'active' as const, approvalGeneration: 3,
        approvalDigest: APPROVAL_DIGEST, ownerGeneration: generation },
      approvalRoutes: base.ownerAdmission.approvalRoutes.map(route => ({ ...route, ownerGeneration: generation, ownerSessionId })),
    };
  };
  const document = (generation: number) => ADMISSION_DOCUMENT.replace('generation_3_owner_7', `generation_3_owner_${generation}`);
  const selection = (generation: number): NativeActivationHandleSelection => ({ contract: NATIVE_ACTIVATION_HANDLE_CONTRACT,
    ownerProcessStartToken: String(generation).repeat(64), bootstrapV2HeaderSha256: '2'.repeat(64),
    bootstrapDigest: bootstrapBinding.bootstrapDigest, ownerGeneration: generation,
    ownerSessionId: owner(generation).expectedOwnerBinding.ownerSessionId,
    expectedOpenCodeExecutableSha256: HOSTED_ACTUAL_OWNER_CANDIDATE_OPENCODE_SHA256 });
  const initial = owner(1);
  const manifest = (generation: number) => {
    const next = owner(generation);
    const payload = JSON.stringify({ format: 'agent-teams.hosted-lifecycle-owner-admission-payload/v4',
      artifact: { artifactDigest: next.artifactDigest, imageReference: next.imageReference,
        artifactVersion: next.artifactVersion, protocolVersion: next.protocolVersion },
      ownerBinding: next.expectedOwnerBinding, bootstrapBinding, socketPath: '/run/agent-teams-orchestrator/orchestrator-lifecycle.sock',
      approvalAdmission: next.approvalAdmission, approvalSnapshot: next.approvalSnapshot, approvalRoutes: next.approvalRoutes });
    return JSON.stringify({ format: 'agent-teams.hosted-lifecycle-owner-admission/v4', payload,
      authentication: { algorithm: 'ed25519', launcherKeyId: next.launcherKeyId,
        signature: sign(null, Buffer.from(`agent-teams.hosted-lifecycle-owner-admission/v4\0${payload}`), launcher.privateKey).toString('base64url') } });
  };
  const ticket = (generation = 2, overrides: Partial<ApprovalGenerationTransition> = {}) => {
    const value: ApprovalGenerationTransition = { contract: APPROVAL_GENERATION_TRANSITION, predecessorManifestDigest: initial.manifestDigest,
      predecessorProcessStartToken: selection(1).ownerProcessStartToken, successorGeneration: generation,
      successorSessionId: owner(generation).expectedOwnerBinding.ownerSessionId, successorBootstrapDigest: bootstrapBinding.bootstrapDigest,
      admissionDocument: document(generation), signature: '', ...overrides };
    return { ...value, signature: sign(null, approvalGenerationTransitionSigningBytes(value), launcher.privateKey).toString('base64url') };
  };
  const input: CreateOptionalHostedApprovalProductionCompositionDependencies = {
    authentication: base.authentication, expectedDeploymentId: base.expectedDeploymentId,
    actorId: base.actorId, restoreGeneration: base.restoreGeneration,
    routeDependencies: { runtimeInstance: base.runtimeInstance, mountBinding: base.mountBinding, teamIdentities: base.teamIdentities },
    approvalStorage: base.approvalStorage, routeAdmissionBinding: base.routeAdmissionBinding,
    ownerAdmission: initial, ownerProofKey: base.ownerProofKey,
    activationPublication: { ...base.activationPublication, admissionDocument: document(1),
      admissionDocumentDigest: `sha256:${createHash('sha256').update(document(1)).digest('hex')}` },
    createApprovalRuntimeAuthority: base.createApprovalRuntimeAuthority,
  };
  const successor = (selected: ReturnType<typeof selection>, endpointIdentity: NativeActivationSocketIdentity, transition = ticket()) => {
    const envelope: NativeSuccessorHandle = { contract: NATIVE_SUCCESSOR_HANDLE, selection: selected, endpointIdentity, successorManifest: manifest(selected.ownerGeneration),
      transitionSha256: createHash('sha256').update(approvalGenerationTransitionSigningBytes(transition)).digest('hex'), signature: '' };
    return { ...envelope, signature: sign(null, nativeSuccessorHandleSigningBytes(envelope), launcher.privateKey).toString('base64url') };
  };
  const createRouteAdmission = (isReady: () => boolean) => createHostedRouteAdmissionBinding({
    routes: HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS,
    readiness: { readiness: async () => ({ revision: 1,
      dimensions: { ...Object.fromEntries(HOSTED_READINESS_DIMENSIONS.map(dimension => [dimension,
        { dimension, status: isReady() ? 'ready' : 'not_ready', reasons: [] }])), terminal: HOSTED_TERMINAL_READINESS } as HostedReadinessDimensionStates }) },
  });
  return { input, selection, ticket, successor, manifest, bootstrap, createRouteAdmission, writer: base.producerProvenance, proofKey: base.ownerProofKey };
}
