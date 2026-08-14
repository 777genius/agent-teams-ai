import {
  deriveRuntimePermissionApprovalIdentity,
  isExactRuntimePermissionApprovalIngressAuthority,
  parseRuntimePermissionApprovalIngressAuthority,
  parseRuntimePermissionApprovalPayload,
  type RuntimePermissionApprovalIngressAuthority,
} from '../../../contracts/runtimePermissionApproval';
import { isRuntimeIngressIsoInstant } from '../../domain/runtime-ingress';

import type { RuntimeIngressPermissionOutboxPort } from './ports';

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/;
const OUTBOX_ID = /^runtime_permission:effect:[a-f0-9]{64}$/;

/** The store owns short-lived claims so a caller cannot pin an effect forever. */
export const RUNTIME_INGRESS_PERMISSION_OUTBOX_MAX_LEASE_DURATION_MS = 5 * 60 * 1_000;

/** A store-local clock; provider and bridge clocks cannot choose lease timestamps. */
export interface RuntimeIngressPermissionOutboxClockPort {
  now(): number;
}

export interface RuntimeIngressPermissionOutboxLease {
  readonly generation: number;
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly claimedAtIso: string;
  readonly leaseExpiresAtIso: string;
}

/**
 * A committed ingress effect, retained until its idempotent pending projection
 * has been acknowledged. Its authority is a persisted credential/session copy,
 * never parsed from the provider body.
 */
export interface RuntimeIngressPermissionOutboxRecord {
  readonly outboxVersion: 1;
  readonly outboxId: string;
  readonly commandId: string;
  readonly effectRef: string;
  readonly deliveryRef: string;
  readonly authority: RuntimePermissionApprovalIngressAuthority;
  readonly payloadJson: string;
  readonly observedAtIso: string;
  readonly acceptedAtIso: string;
  readonly lease: RuntimeIngressPermissionOutboxLease | null;
  readonly acknowledgedAtIso: string | null;
}

export interface RuntimeIngressPermissionOutboxClaimRequest {
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly leaseDurationMs: number;
  readonly limit: number;
}

export interface RuntimeIngressPermissionOutboxAcknowledgeRequest {
  readonly outboxId: string;
  readonly generation: number;
  readonly ownerId: string;
  readonly leaseToken: string;
}

export type RuntimeIngressPermissionOutboxAcknowledgeResult =
  | { readonly status: 'acknowledged' | 'already_acknowledged' }
  | { readonly status: 'conflict' | 'unavailable' };

function isIdentifier(value: unknown): value is string {
  return typeof value === 'string' && IDENTIFIER.test(value);
}

function isPositiveInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) > 0;
}

function isLease(value: unknown): value is RuntimeIngressPermissionOutboxLease {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 5 ||
    !['generation', 'ownerId', 'leaseToken', 'claimedAtIso', 'leaseExpiresAtIso'].every((key) =>
      Object.hasOwn(record, key)
    ) ||
    !isPositiveInteger(record.generation) ||
    !isIdentifier(record.ownerId) ||
    !isIdentifier(record.leaseToken) ||
    !isRuntimeIngressIsoInstant(record.claimedAtIso) ||
    !isRuntimeIngressIsoInstant(record.leaseExpiresAtIso)
  ) {
    return false;
  }
  const claimedAtMs = Date.parse(record.claimedAtIso);
  const leaseExpiresAtMs = Date.parse(record.leaseExpiresAtIso);
  return (
    leaseExpiresAtMs > claimedAtMs &&
    leaseExpiresAtMs - claimedAtMs <= RUNTIME_INGRESS_PERMISSION_OUTBOX_MAX_LEASE_DURATION_MS
  );
}

export function isRuntimeIngressPermissionOutboxRecord(
  value: unknown
): value is RuntimeIngressPermissionOutboxRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 11 ||
    ![
      'outboxVersion',
      'outboxId',
      'commandId',
      'effectRef',
      'deliveryRef',
      'authority',
      'payloadJson',
      'observedAtIso',
      'acceptedAtIso',
      'lease',
      'acknowledgedAtIso',
    ].every((key) => Object.hasOwn(record, key)) ||
    record.outboxVersion !== 1 ||
    typeof record.outboxId !== 'string' ||
    !OUTBOX_ID.test(record.outboxId) ||
    !isIdentifier(record.commandId) ||
    typeof record.effectRef !== 'string' ||
    record.outboxId !== `runtime_permission:${record.effectRef}` ||
    typeof record.deliveryRef !== 'string' ||
    typeof record.payloadJson !== 'string' ||
    !isRuntimeIngressIsoInstant(record.observedAtIso) ||
    !isRuntimeIngressIsoInstant(record.acceptedAtIso) ||
    (record.lease !== null && !isLease(record.lease)) ||
    (record.acknowledgedAtIso !== null && !isRuntimeIngressIsoInstant(record.acknowledgedAtIso))
  ) {
    return false;
  }
  try {
    const authority = parseRuntimePermissionApprovalIngressAuthority(record.authority);
    const payload = parseRuntimePermissionApprovalPayload(
      JSON.parse(record.payloadJson) as unknown
    );
    deriveRuntimePermissionApprovalIdentity({
      teamId: authority.teamId,
      runId: authority.runId,
      requestId: record.commandId,
      effectRef: record.effectRef,
    });
    if (
      payload.deliveryRef !== record.deliveryRef ||
      authority.teamId !== (record.authority as RuntimePermissionApprovalIngressAuthority).teamId ||
      !isExactRuntimePermissionApprovalIngressAuthority(
        authority,
        record.authority as RuntimePermissionApprovalIngressAuthority
      )
    ) {
      return false;
    }
  } catch {
    return false;
  }
  const observedAtMs = Date.parse(record.observedAtIso);
  const acceptedAtMs = Date.parse(record.acceptedAtIso);
  const acknowledgedAtMs =
    record.acknowledgedAtIso === null ? null : Date.parse(record.acknowledgedAtIso);
  return (
    acceptedAtMs >= observedAtMs &&
    (acknowledgedAtMs === null || (acknowledgedAtMs >= acceptedAtMs && record.lease !== null))
  );
}

export function isRuntimeIngressPermissionOutboxClaimRequest(
  value: unknown
): value is RuntimeIngressPermissionOutboxClaimRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (
    Object.keys(record).length !== 4 ||
    !['ownerId', 'leaseToken', 'leaseDurationMs', 'limit'].every((key) =>
      Object.hasOwn(record, key)
    ) ||
    !isIdentifier(record.ownerId) ||
    !isIdentifier(record.leaseToken) ||
    !Number.isSafeInteger(record.leaseDurationMs) ||
    (record.leaseDurationMs as number) < 1 ||
    (record.leaseDurationMs as number) > RUNTIME_INGRESS_PERMISSION_OUTBOX_MAX_LEASE_DURATION_MS ||
    !Number.isSafeInteger(record.limit) ||
    (record.limit as number) < 1 ||
    (record.limit as number) > 100
  ) {
    return false;
  }
  return true;
}

export function isRuntimeIngressPermissionOutboxAcknowledgeRequest(
  value: unknown
): value is RuntimeIngressPermissionOutboxAcknowledgeRequest {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 4 &&
    ['outboxId', 'generation', 'ownerId', 'leaseToken'].every((key) =>
      Object.hasOwn(record, key)
    ) &&
    typeof record.outboxId === 'string' &&
    OUTBOX_ID.test(record.outboxId) &&
    isPositiveInteger(record.generation) &&
    isIdentifier(record.ownerId) &&
    isIdentifier(record.leaseToken)
  );
}

/** Compares the immutable provider-delivery intent, never a mutable lease/ack. */
export function areRuntimeIngressPermissionOutboxIntentsExact(
  left: RuntimeIngressPermissionOutboxRecord,
  right: RuntimeIngressPermissionOutboxRecord
): boolean {
  return (
    left.outboxVersion === right.outboxVersion &&
    left.outboxId === right.outboxId &&
    left.commandId === right.commandId &&
    left.effectRef === right.effectRef &&
    left.deliveryRef === right.deliveryRef &&
    isExactRuntimePermissionApprovalIngressAuthority(left.authority, right.authority) &&
    left.payloadJson === right.payloadJson &&
    left.observedAtIso === right.observedAtIso &&
    left.acceptedAtIso === right.acceptedAtIso
  );
}

/**
 * Small fail-closed application facade. The durable store owns locking and
 * state transitions; callers use this port rather than reaching into ingress
 * snapshots or selecting an authority from provider payloads.
 */
export class RuntimeIngressPermissionOutbox {
  constructor(private readonly store: RuntimeIngressPermissionOutboxPort) {}

  async claim(
    request: RuntimeIngressPermissionOutboxClaimRequest
  ): Promise<readonly RuntimeIngressPermissionOutboxRecord[]> {
    if (!isRuntimeIngressPermissionOutboxClaimRequest(request)) return Object.freeze([]);
    try {
      const records = await this.store.claimPermissionApprovalIngressEffects(request);
      return Object.freeze(records.filter(isRuntimeIngressPermissionOutboxRecord));
    } catch {
      return Object.freeze([]);
    }
  }

  async acknowledge(
    request: RuntimeIngressPermissionOutboxAcknowledgeRequest
  ): Promise<RuntimeIngressPermissionOutboxAcknowledgeResult> {
    if (!isRuntimeIngressPermissionOutboxAcknowledgeRequest(request)) {
      return Object.freeze({ status: 'conflict' });
    }
    try {
      return await this.store.acknowledgePermissionApprovalIngressEffect(request);
    } catch {
      return Object.freeze({ status: 'unavailable' });
    }
  }
}
