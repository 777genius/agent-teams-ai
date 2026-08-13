import { parseTeamId, parseWorkspaceId } from '@shared/contracts/hosted';

import type {
  HostedTeamApprovalDeliveryOperatorRequiredRequest,
  HostedTeamApprovalDeliveryReconciliationRequest,
  HostedTeamApprovalDeliveryReconciliationSettleRequest,
} from '../../contracts/hostedTeamApprovalAuthorityStorageContracts';

type UnknownRecord = Record<PropertyKey, unknown>;
const DELIVERY_ID = /^approval_delivery_[A-Za-z0-9][A-Za-z0-9._-]{0,231}$/;
const GENERATION = /^generation_[A-Za-z0-9][A-Za-z0-9._-]{0,245}$/;
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const RECONCILIATION_REF = /^approval-reconciliation_[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const MAX_BOUNDARY_LEASE_DURATION_MS = 5 * 60 * 1_000;
const MAX_RECONCILIATION_LEASE_DURATION_MS = 5 * 60 * 1_000;

function exact(value: unknown, keys: readonly string[], label: string): UnknownRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${label}-invalid`);
  }
  const input = value as UnknownRecord;
  const actual = Reflect.ownKeys(input);
  if (
    actual.length !== keys.length ||
    actual.some((key) => typeof key !== 'string' || !keys.includes(key)) ||
    !keys.every((key) => Object.hasOwn(input, key))
  ) {
    throw new TypeError(`${label}-invalid`);
  }
  return input;
}

function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1)
    throw new TypeError(`${label}-invalid`);
  return value as number;
}

function nonNegative(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0)
    throw new TypeError(`${label}-invalid`);
  return value as number;
}

function identifier(value: unknown, pattern: RegExp, label: string): string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`${label}-invalid`);
  return value;
}

function reconciliation(value: unknown): HostedTeamApprovalDeliveryReconciliationRequest {
  const input = exact(
    value,
    [
      'workspaceId',
      'authorityGeneration',
      'restoreGeneration',
      'partition',
      'deliveryId',
      'approvalGeneration',
      'deliveryGeneration',
      'reconciliationRef',
      'ownerId',
      'leaseToken',
      'leaseDurationMs',
      'deadlineAtMs',
    ],
    'hosted-team-approval-storage-delivery-reconciliation-request'
  );
  const partition = exact(
    input.partition,
    ['teamId', 'runId'],
    'hosted-team-approval-storage-delivery-partition'
  );
  return Object.freeze({
    workspaceId: parseWorkspaceId(input.workspaceId),
    authorityGeneration: identifier(input.authorityGeneration, GENERATION, 'authority-generation'),
    restoreGeneration: nonNegative(input.restoreGeneration, 'restore-generation'),
    partition: Object.freeze({
      teamId: parseTeamId(partition.teamId),
      runId: identifier(partition.runId, IDENTIFIER, 'run-id'),
    }),
    deliveryId: identifier(input.deliveryId, DELIVERY_ID, 'delivery-id'),
    approvalGeneration: identifier(input.approvalGeneration, GENERATION, 'approval-generation'),
    deliveryGeneration: positive(input.deliveryGeneration, 'delivery-generation'),
    reconciliationRef: identifier(
      input.reconciliationRef,
      RECONCILIATION_REF,
      'reconciliation-ref'
    ),
    ownerId: identifier(input.ownerId, IDENTIFIER, 'reconciliation-owner'),
    leaseToken: identifier(input.leaseToken, IDENTIFIER, 'reconciliation-lease-token'),
    leaseDurationMs: (() => {
      const duration = positive(input.leaseDurationMs, 'reconciliation-lease-duration');
      if (duration > MAX_RECONCILIATION_LEASE_DURATION_MS)
        throw new TypeError('reconciliation-lease-duration-invalid');
      return duration;
    })(),
    deadlineAtMs: positive(input.deadlineAtMs, 'deadline'),
  });
}

export function parseHostedTeamApprovalDeliveryOperatorRequiredRequest(
  value: unknown
): HostedTeamApprovalDeliveryOperatorRequiredRequest {
  const input = exact(
    value,
    [
      'workspaceId',
      'authorityGeneration',
      'restoreGeneration',
      'partition',
      'deliveryId',
      'approvalGeneration',
      'deliveryGeneration',
      'ownerId',
      'leaseToken',
      'deadlineAtMs',
      'reconciliationRef',
      'boundaryLeaseDurationMs',
    ],
    'hosted-team-approval-storage-delivery-operator-required-request'
  );
  const base = reconciliation({
    workspaceId: input.workspaceId,
    authorityGeneration: input.authorityGeneration,
    restoreGeneration: input.restoreGeneration,
    partition: input.partition,
    deliveryId: input.deliveryId,
    approvalGeneration: input.approvalGeneration,
    deliveryGeneration: input.deliveryGeneration,
    reconciliationRef: input.reconciliationRef,
    ownerId: input.ownerId,
    leaseToken: input.leaseToken,
    leaseDurationMs: 1,
    deadlineAtMs: input.deadlineAtMs,
  });
  return Object.freeze({
    ...base,
    ownerId: identifier(input.ownerId, IDENTIFIER, 'delivery-owner'),
    leaseToken: identifier(input.leaseToken, IDENTIFIER, 'delivery-lease-token'),
    boundaryLeaseDurationMs: (() => {
      const duration = positive(input.boundaryLeaseDurationMs, 'delivery-boundary-lease-duration');
      if (duration > MAX_BOUNDARY_LEASE_DURATION_MS) {
        throw new TypeError('delivery-boundary-lease-duration-invalid');
      }
      return duration;
    })(),
  });
}

export const parseHostedTeamApprovalDeliveryReconciliationRequest = reconciliation;

export function parseHostedTeamApprovalDeliveryReconciliationSettleRequest(
  value: unknown
): HostedTeamApprovalDeliveryReconciliationSettleRequest {
  const input = exact(
    value,
    [
      'workspaceId',
      'authorityGeneration',
      'restoreGeneration',
      'partition',
      'deliveryId',
      'approvalGeneration',
      'deliveryGeneration',
      'reconciliationRef',
      'deadlineAtMs',
      'outcome',
      'ownerId',
      'leaseToken',
    ],
    'hosted-team-approval-storage-delivery-reconciliation-settle-request'
  );
  const { outcome, ...base } = input;
  if (outcome !== 'delivered' && outcome !== 'not_delivered') {
    throw new TypeError('hosted-team-approval-storage-delivery-reconciliation-outcome-invalid');
  }
  const { leaseDurationMs: _, ...settle } = reconciliation({ ...base, leaseDurationMs: 1 });
  return Object.freeze({ ...settle, outcome });
}
