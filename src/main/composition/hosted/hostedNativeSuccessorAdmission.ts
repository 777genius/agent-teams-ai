import { createHash } from 'node:crypto';

import { authenticateHostedLifecycleAdmissionManifest } from './hostedLifecycleOwnerAdmissionManifest';
import { assertBootstrapBinding, type HostedLifecycleProductionOwnerAdmission,parseAdmissionPayload } from './hostedLifecycleProductionOwnerAdmission';

/** Native replacement uses the existing pinned launcher, never roots from IPC.
 * Socket path metadata is signed logical identity; ActivationV2 independently
 * authenticates the actual transferred endpoint before this becomes authority. */
export function admitHostedNativeSuccessorManifest(
  serialized: string,
  predecessor: HostedLifecycleProductionOwnerAdmission,
  serializedBootstrap: string,
): HostedLifecycleProductionOwnerAdmission {
  if (Buffer.byteLength(serialized) > 16_384) {
    throw new Error('native_successor_manifest_bounded');
  }
  const authenticated = authenticateHostedLifecycleAdmissionManifest(serialized, predecessor);
  if (authenticated.version !== 4) throw new Error('native_successor_manifest_v4_required');
  const parsed = parseAdmissionPayload(authenticated.payload, '/run/agent-teams-orchestrator/orchestrator-lifecycle.sock', 4);
  assertBootstrapBinding(parsed.bootstrapBinding, serializedBootstrap,
    predecessor.artifactDigest, predecessor.bootstrapBinding.proofKeyId);
  if ((parsed.artifact.artifactDigest !== predecessor.artifactDigest ||
    parsed.artifact.imageReference !== predecessor.imageReference ||
    parsed.artifact.artifactVersion !== predecessor.artifactVersion ||
    parsed.artifact.protocolVersion !== predecessor.protocolVersion) ||
    parsed.expectedOwnerBinding.ownerAuthority !== predecessor.ownerAuthority ||
    parsed.expectedOwnerBinding.ownerGeneration !== predecessor.expectedOwnerBinding.ownerGeneration + 1 ||
    parsed.expectedOwnerBinding.ownerSessionId === predecessor.expectedOwnerBinding.ownerSessionId ||
    JSON.stringify(parsed.bootstrapBinding) !== JSON.stringify(predecessor.bootstrapBinding) ||
    parsed.approvalAdmission.state !== 'active' || parsed.approvalRoutes.length !== 1 ||
    parsed.approvalRoutes.some(route => route.ownerGeneration !== parsed.expectedOwnerBinding.ownerGeneration ||
      route.ownerSessionId !== parsed.expectedOwnerBinding.ownerSessionId)) {
    throw new Error('native_successor_manifest_binding');
  }
  return Object.freeze({ ...predecessor, ...parsed.artifact,
    expectedOwnerBinding: parsed.expectedOwnerBinding, bootstrapBinding: parsed.bootstrapBinding,
    approvalAdmission: parsed.approvalAdmission, approvalSnapshot: parsed.approvalSnapshot,
    approvalRoutes: parsed.approvalRoutes,
    manifestDigest: `sha256:${createHash('sha256').update(serialized).digest('hex')}` as const,
  });
}
