import { createHash } from 'node:crypto';

import {
  parseRuntimePermissionApprovalIngressAuthority,
  type RuntimePermissionApprovalIngressAuthority,
} from '@features/team-approvals';

import type { AuthoritativeHostedApprovalRuntimeBinding } from './HostedApprovalRuntimeAdmissionPublisher';

export function buildHostedApprovalAuthoritySnapshot(
  binding: AuthoritativeHostedApprovalRuntimeBinding,
  approvalGeneration: number
): Readonly<{
  schemaVersion: 1;
  approvalGeneration: number;
  authorities: readonly RuntimePermissionApprovalIngressAuthority[];
}> {
  return Object.freeze({
    schemaVersion: 1,
    approvalGeneration,
    authorities: Object.freeze(
      [...binding.routes]
        .toSorted((left, right) =>
          left.routeId < right.routeId ? -1 : left.routeId > right.routeId ? 1 : 0
        )
        .map((route) => parseRuntimePermissionApprovalIngressAuthority(route.authority))
    ),
  });
}

export function digestHostedApprovalAuthoritySnapshot(
  binding: AuthoritativeHostedApprovalRuntimeBinding,
  approvalGeneration: number
): `sha256:${string}` {
  const body = JSON.stringify(buildHostedApprovalAuthoritySnapshot(binding, approvalGeneration));
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}
