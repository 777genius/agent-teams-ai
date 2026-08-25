import { HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY_DIGEST } from '@shared/contracts/hostedApprovalWireCapability';

import { readHostedAdmissionExactRecord as readExactRecord } from './hostedAdmissionExactRecord';
import { parseHostedAdmissionSocketIdentity } from './hostedAdmissionSocketIdentity';
import { HOSTED_LIFECYCLE_OWNER_GENERATION_LIMIT } from './hostedLifecycleOwnerHighWaterBinding';

import type { HostedApprovalAdmissionPin } from './hostedApprovalAdmissionPin';
import type {
  OrchestratorLifecycleBootstrapBinding,
  OrchestratorSocketIdentity,
} from './hostedLifecycleOrchestratorReadiness';

const OWNER_SESSION_PATTERN = /^owner-session_[A-Za-z0-9][A-Za-z0-9._-]{7,127}$/u;

export interface HostedApprovalOwnerRoute {
  readonly teamId: string;
  readonly workspaceId: string;
  readonly ownerGeneration: number;
  readonly ownerSessionId: string;
  readonly socketPath: string;
  readonly socketIdentity: OrchestratorSocketIdentity;
  readonly artifactDigest: `sha256:${string}`;
  readonly approvalGeneration: number;
  readonly approvalDigest: `sha256:${string}`;
  readonly wireCapabilityDigest: typeof HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY_DIGEST;
}

export function parseHostedApprovalOwnerRoutes(
  value: unknown,
  expected: Readonly<{
    artifactDigest: `sha256:${string}`;
    bootstrapBinding: OrchestratorLifecycleBootstrapBinding;
    approvalAdmission: HostedApprovalAdmissionPin;
  }>
): readonly HostedApprovalOwnerRoute[] {
  const approvalAdmission = expected.approvalAdmission;
  if (
    approvalAdmission.state !== 'active' ||
    !Array.isArray(value) ||
    value.length === 0 ||
    value.length > 256
  ) {
    throw new TypeError('hosted-lifecycle-owner-approval-routes-invalid');
  }
  const routes = value.map((candidate) => {
    const route = readExactRecord(candidate, [
      'teamId',
      'workspaceId',
      'ownerGeneration',
      'ownerSessionId',
      'socketPath',
      'socketIdentity',
      'artifactDigest',
      'approvalGeneration',
      'approvalDigest',
      'wireCapabilityDigest',
    ]);
    const socketIdentity = parseHostedAdmissionSocketIdentity(route.socketIdentity);
    if (
      typeof route.teamId !== 'string' ||
      !/^team_[0-9a-f]{32}$/u.test(route.teamId) ||
      route.workspaceId !== expected.bootstrapBinding.workspaceId ||
      !Number.isSafeInteger(route.ownerGeneration) ||
      (route.ownerGeneration as number) < 1 ||
      (route.ownerGeneration as number) >= HOSTED_LIFECYCLE_OWNER_GENERATION_LIMIT ||
      typeof route.ownerSessionId !== 'string' ||
      !OWNER_SESSION_PATTERN.test(route.ownerSessionId) ||
      typeof route.socketPath !== 'string' ||
      route.artifactDigest !== expected.artifactDigest ||
      route.approvalGeneration !== approvalAdmission.approvalGeneration ||
      route.approvalDigest !== approvalAdmission.approvalDigest ||
      route.wireCapabilityDigest !== HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY_DIGEST
    ) {
      throw new TypeError('hosted-lifecycle-owner-approval-route-binding-invalid');
    }
    return Object.freeze({
      teamId: route.teamId,
      workspaceId: route.workspaceId,
      ownerGeneration: route.ownerGeneration as number,
      ownerSessionId: route.ownerSessionId,
      socketPath: route.socketPath,
      socketIdentity,
      artifactDigest: route.artifactDigest,
      approvalGeneration: route.approvalGeneration,
      approvalDigest: route.approvalDigest,
      wireCapabilityDigest: HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY_DIGEST,
    });
  });
  const teamIds = routes.map((route) => route.teamId);
  const sorted = [...teamIds].sort((left, right) => left.localeCompare(right));
  const socketPaths = routes.map((route) => route.socketPath);
  const socketIdentities = routes.map(
    (route) => `${route.socketIdentity.device}:${route.socketIdentity.inode}`
  );
  if (
    new Set(teamIds).size !== teamIds.length ||
    new Set(socketPaths).size !== socketPaths.length ||
    new Set(socketIdentities).size !== socketIdentities.length ||
    teamIds.some((teamId, index) => teamId !== sorted[index])
  ) {
    throw new TypeError('hosted-lifecycle-owner-approval-routes-order-invalid');
  }
  return Object.freeze(routes);
}
