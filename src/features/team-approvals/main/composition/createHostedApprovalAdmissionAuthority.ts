import { createHash } from 'node:crypto';

import {
  isExactRuntimePermissionApprovalIngressAuthority,
  parseRuntimePermissionApprovalIngressAuthority,
} from '@features/team-runtime-control/contracts';

import type { RuntimePermissionApprovalIngressAuthority } from '@features/team-runtime-control/contracts';
import type { HostedApprovalAdmissionPin } from '@main/composition/hosted/hostedLifecycleProductionOwnerAdmission';

export interface HostedApprovalAdmissionSnapshot {
  readonly schemaVersion: 1;
  readonly approvalGeneration: number;
  readonly authorities: readonly RuntimePermissionApprovalIngressAuthority[];
}

export interface HostedApprovalAdmissionAuthority {
  getAdmittedIngressAuthority(
    candidate: RuntimePermissionApprovalIngressAuthority
  ): Promise<RuntimePermissionApprovalIngressAuthority | null>;
}

/**
 * Resolves only authorities whose canonical snapshot is pinned by the launcher-signed lifecycle
 * admission. Owner-writable JSON without the signed digest is never an authority source.
 */
export function createHostedApprovalAdmissionAuthority(input: {
  readonly pin: HostedApprovalAdmissionPin;
  readonly snapshot: unknown;
}): HostedApprovalAdmissionAuthority | null {
  if (input.pin.state !== 'active') return null;
  const snapshot = parseSnapshot(input.snapshot);
  if (
    snapshot.approvalGeneration !== input.pin.approvalGeneration ||
    canonicalDigest(snapshot) !== input.pin.approvalDigest
  ) {
    return null;
  }
  return Object.freeze({
    async getAdmittedIngressAuthority(candidate: RuntimePermissionApprovalIngressAuthority) {
      return (
        snapshot.authorities.find((authority) =>
          isExactRuntimePermissionApprovalIngressAuthority(authority, candidate)
        ) ?? null
      );
    },
  });
}

function parseSnapshot(value: unknown): HostedApprovalAdmissionSnapshot {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('hosted-approval-admission-snapshot-invalid');
  }
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 3 ||
    record.schemaVersion !== 1 ||
    !Number.isSafeInteger(record.approvalGeneration) ||
    (record.approvalGeneration as number) < 1 ||
    !Array.isArray(record.authorities)
  ) {
    throw new TypeError('hosted-approval-admission-snapshot-invalid');
  }
  const authorities = record.authorities.map(parseRuntimePermissionApprovalIngressAuthority);
  const identities = new Set<string>();
  for (const authority of authorities) {
    const identity = `${authority.teamId}\0${authority.runId}\0${authority.laneId}\0${authority.sessionId}`;
    if (identities.has(identity))
      throw new TypeError('hosted-approval-admission-snapshot-duplicate');
    identities.add(identity);
  }
  return Object.freeze({
    schemaVersion: 1,
    approvalGeneration: record.approvalGeneration as number,
    authorities: Object.freeze(authorities),
  });
}

function canonicalDigest(snapshot: HostedApprovalAdmissionSnapshot): `sha256:${string}` {
  const body = JSON.stringify(snapshot);
  return `sha256:${createHash('sha256').update(body).digest('hex')}`;
}
