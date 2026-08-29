import {
  type OrchestratorLifecycleOwnerBinding,
  type OrchestratorLifecycleOwnerProofKey,
  type OrchestratorSocketIdentity,
  sameOrchestratorLifecycleOwnerBinding,
} from '@main/composition/hosted/hostedLifecycleOrchestratorReadiness';

import type { HostedApprovalRuntimeActivationSigningIdentity } from './HostedApprovalRuntimeProductionComposition';
import type { Socket } from 'node:net';

export interface HostedApprovalRuntimeActivationBinding {
  readonly deploymentId: string;
  readonly bootId: string;
  readonly workspaceId: string;
  readonly teamId: string;
  readonly restoreGeneration: number;
  readonly mountBinding: Readonly<{ mountGeneration: number; declaredRootHash: string }>;
  readonly ownerBinding: OrchestratorLifecycleOwnerBinding;
  readonly socketPath: string;
  readonly approvalGeneration: number;
  readonly admissionOwnerGeneration: number;
  readonly approvalDigest: `sha256:${string}`;
  readonly admissionDocumentDigest: `sha256:${string}`;
  readonly ownerArtifactDigest?: `sha256:${string}`;
  /** Internal manifest-v4 mapping compatibility; never serialized on the wire. */
  readonly artifactDigest?: `sha256:${string}`;
  readonly activationCapability: 'agent-teams.hosted-approval-activation-v2';
  readonly wireCapabilityDigest: `sha256:${string}`;
  readonly signedManifest: Readonly<{
    format: 'agent-teams.hosted-lifecycle-owner-admission/v4';
    manifestDigest: `sha256:${string}`;
    releasePinDigest: `sha256:${string}`;
    launcherKeyId: string;
  }>;
}

export interface HostedApprovalRuntimeActivationLease {
  isReady(): boolean;
  currentBinding(): OrchestratorLifecycleOwnerBinding | null;
  invalidate(): void;
}

export interface HostedApprovalRuntimeActivationOptions {
  readonly binding: HostedApprovalRuntimeActivationBinding;
  readonly admissionDocument: string;
  readonly proofKey: OrchestratorLifecycleOwnerProofKey;
  readonly signingIdentity: HostedApprovalRuntimeActivationSigningIdentity;
  readonly timeoutMs?: number;
  readonly onOwnerLoss: () => void;
  readonly inspectSocketIdentity?: (path: string) => Promise<OrchestratorSocketIdentity>;
  readonly connect?: (options: { readonly path: string }) => Socket;
  readonly generateChallenge?: () => string;
}

export type HostedActualOwnerCandidateOpenCodeSha256 =
  'cffecbe3ff685de84d7fa028e552c42d15a7c720a8f8d5d1cddd265110e5eb88';

/** Ownership of this authenticated connection transfers to the activation lease. */
export interface HostedApprovalRuntimeConnectedTransport {
  readonly socket: Socket;
}

export function sameHostedApprovalActivationOwner(
  lease: HostedApprovalRuntimeActivationLease,
  expected: OrchestratorLifecycleOwnerBinding
): boolean {
  const current = lease.currentBinding();
  return current !== null && sameOrchestratorLifecycleOwnerBinding(current, expected);
}
