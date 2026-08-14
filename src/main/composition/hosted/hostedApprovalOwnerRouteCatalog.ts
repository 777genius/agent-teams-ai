import { HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY_DIGEST } from '@shared/contracts/hostedApprovalWireCapability';

import { readHostedAdmissionExactRecord as readExactRecord } from './hostedAdmissionExactRecord';
import {
  parseHostedAdmissionSocketIdentity,
  sameHostedAdmissionSocketIdentity,
} from './hostedAdmissionSocketIdentity';

import type { HostedApprovalAdmissionPin } from './hostedApprovalAdmissionPin';
import type {
  OrchestratorLifecycleBootstrapBinding,
  OrchestratorLifecycleOwnerBinding,
  OrchestratorSocketIdentity,
} from './hostedLifecycleOrchestratorReadiness';

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
    ownerBinding: OrchestratorLifecycleOwnerBinding;
    bootstrapBinding: OrchestratorLifecycleBootstrapBinding;
    approvalAdmission: HostedApprovalAdmissionPin;
    socketPath: string;
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
      route.ownerGeneration !== expected.ownerBinding.ownerGeneration ||
      route.ownerSessionId !== expected.ownerBinding.ownerSessionId ||
      route.socketPath !== expected.socketPath ||
      !sameHostedAdmissionSocketIdentity(socketIdentity, expected.ownerBinding.socketIdentity) ||
      route.artifactDigest !== expected.artifactDigest ||
      route.approvalGeneration !== approvalAdmission.approvalGeneration ||
      route.approvalDigest !== approvalAdmission.approvalDigest ||
      route.wireCapabilityDigest !== HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY_DIGEST
    ) {
      throw new TypeError('hosted-lifecycle-owner-approval-route-binding-invalid');
    }
    return Object.freeze({
      teamId: route.teamId,
      workspaceId: route.workspaceId as string,
      ownerGeneration: route.ownerGeneration as number,
      ownerSessionId: route.ownerSessionId as string,
      socketPath: route.socketPath as string,
      socketIdentity,
      artifactDigest: route.artifactDigest as `sha256:${string}`,
      approvalGeneration: route.approvalGeneration as number,
      approvalDigest: route.approvalDigest as `sha256:${string}`,
      wireCapabilityDigest: HOSTED_APPROVAL_RUNTIME_WIRE_CAPABILITY_DIGEST,
    });
  });
  const teamIds = routes.map((route) => route.teamId);
  const sorted = [...teamIds].sort((left, right) => left.localeCompare(right));
  if (
    new Set(teamIds).size !== teamIds.length ||
    teamIds.some((teamId, index) => teamId !== sorted[index])
  ) {
    throw new TypeError('hosted-lifecycle-owner-approval-routes-order-invalid');
  }
  return Object.freeze(routes);
}
