import { createHash } from 'node:crypto';

import { parseRuntimePermissionApprovalIngressAuthority } from '@features/team-approvals';

import { readHostedAdmissionExactRecord as readExactRecord } from './hostedAdmissionExactRecord';

import type { HostedApprovalAdmissionPin } from './hostedApprovalAdmissionPin';
import type { HostedApprovalOwnerRoute } from './hostedApprovalOwnerRouteCatalog';

export function validateHostedApprovalAdmissionSnapshotPin(
  pin: HostedApprovalAdmissionPin,
  value: unknown,
  routes?: readonly HostedApprovalOwnerRoute[]
): void {
  if (pin.state !== 'active') {
    if (value !== null) {
      throw new TypeError('hosted-lifecycle-approval-snapshot-unexpected');
    }
    return;
  }
  const snapshot = readExactRecord(value, ['schemaVersion', 'approvalGeneration', 'authorities']);
  if (
    snapshot.schemaVersion !== 1 ||
    snapshot.approvalGeneration !== pin.approvalGeneration ||
    !Array.isArray(snapshot.authorities) ||
    snapshot.authorities.length === 0 ||
    snapshot.authorities.length > 256
  ) {
    throw new TypeError('hosted-lifecycle-approval-snapshot-invalid');
  }
  const authorities = snapshot.authorities.map(parseRuntimePermissionApprovalIngressAuthority);
  const identities = authorities.map(
    (authority) =>
      `${authority.teamId}\0${authority.runId}\0${authority.laneId}\0${authority.sessionId}`
  );
  if (new Set(identities).size !== identities.length) {
    throw new TypeError('hosted-lifecycle-approval-snapshot-invalid');
  }
  const canonical = JSON.stringify({
    schemaVersion: 1,
    approvalGeneration: pin.approvalGeneration,
    authorities,
  });
  const digest = `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
  if (digest !== pin.approvalDigest) {
    throw new TypeError('hosted-lifecycle-approval-snapshot-invalid');
  }
  if (routes) validateHostedApprovalSnapshotRoutes(value, routes);
}

function validateHostedApprovalSnapshotRoutes(
  snapshot: unknown,
  routes: readonly HostedApprovalOwnerRoute[]
): void {
  const record = readExactRecord(snapshot, ['schemaVersion', 'approvalGeneration', 'authorities']);
  if (!Array.isArray(record.authorities)) {
    throw new TypeError('hosted-lifecycle-approval-snapshot-invalid');
  }
  const snapshotTeams = [
    ...new Set(
      record.authorities.map(
        (authority) => parseRuntimePermissionApprovalIngressAuthority(authority).teamId
      )
    ),
  ].toSorted();
  const routeTeams = routes.map((route) => route.teamId).toSorted();
  if (
    snapshotTeams.length !== routeTeams.length ||
    snapshotTeams.some((teamId, index) => teamId !== routeTeams[index])
  ) {
    throw new TypeError('hosted-lifecycle-owner-approval-route-snapshot-mismatch');
  }
}
