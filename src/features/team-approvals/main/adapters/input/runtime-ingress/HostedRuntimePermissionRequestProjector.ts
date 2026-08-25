import {
  RuntimeIngressPermissionOutbox,
  type RuntimeIngressPermissionOutboxRecord,
} from '@features/team-runtime-control';
import {
  deriveRuntimePermissionApprovalIdentity,
  parseRuntimePermissionApprovalPayload,
} from '@features/team-runtime-control/contracts';

import type { HostedTeamApprovalPendingIngressPort } from '../../../ports/HostedTeamApprovalAuthorityStoragePort';
import type {
  HostedRuntimePermissionIngressAuthorityPort,
  HostedTeamApprovalRuntimeBridgeClockPort,
} from '../../../ports/HostedTeamApprovalRuntimeBridgePorts';
import type { HostedTeamApprovalPendingStorageRecord } from '@features/internal-storage/contracts';

const MAX_BATCH_SIZE = 100;

export interface HostedRuntimePermissionProjectionRequest {
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly leaseDurationMs: number;
  readonly limit: number;
  readonly deadlineAtMs: number;
}

export interface HostedRuntimePermissionProjectionResult {
  readonly claimed: number;
  readonly projected: number;
  readonly acknowledged: number;
  readonly retained: number;
}

function currentTime(clock: HostedTeamApprovalRuntimeBridgeClockPort): number | null {
  try {
    const value = clock.now();
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  } catch {
    return null;
  }
}

function isIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,191}$/.test(value);
}

function isOpenRequest(request: HostedRuntimePermissionProjectionRequest, now: number): boolean {
  return (
    isIdentifier(request.ownerId) &&
    isIdentifier(request.leaseToken) &&
    Number.isSafeInteger(request.leaseDurationMs) &&
    request.leaseDurationMs > 0 &&
    Number.isSafeInteger(request.limit) &&
    request.limit > 0 &&
    request.limit <= MAX_BATCH_SIZE &&
    Number.isSafeInteger(request.deadlineAtMs) &&
    request.deadlineAtMs > now
  );
}

function ownsOpenLease(
  record: RuntimeIngressPermissionOutboxRecord,
  request: HostedRuntimePermissionProjectionRequest,
  now: number
): boolean {
  const lease = record.lease;
  return (
    lease !== null &&
    lease.ownerId === request.ownerId &&
    lease.leaseToken === request.leaseToken &&
    Date.parse(lease.leaseExpiresAtIso) > now
  );
}

function pendingRecordFor(
  record: RuntimeIngressPermissionOutboxRecord,
  scope: HostedTeamApprovalPendingStorageRecord['scope'],
  deadlineAtMs: number
): HostedTeamApprovalPendingStorageRecord {
  const payload = parseRuntimePermissionApprovalPayload(JSON.parse(record.payloadJson) as unknown);
  const identity = deriveRuntimePermissionApprovalIdentity({
    teamId: record.authority.teamId,
    runId: record.authority.runId,
    requestId: record.commandId,
    effectRef: record.effectRef,
  });
  const requestedAtMs = Date.parse(record.observedAtIso);
  const observedAtMs = Date.parse(record.acceptedAtIso);
  if (
    !Number.isSafeInteger(requestedAtMs) ||
    requestedAtMs < 0 ||
    !Number.isSafeInteger(observedAtMs) ||
    observedAtMs < requestedAtMs
  ) {
    throw new TypeError('runtime-permission-projection-observed-at-invalid');
  }
  return Object.freeze({
    scope,
    runId: identity.runId,
    requestId: identity.requestId,
    approvalId: identity.approvalId,
    approvalGeneration: identity.approvalGeneration,
    category: payload.category,
    summary: payload.summary,
    requestedAtMs,
    expiresAtMs: payload.expiresAtMs,
    preview: payload.preview,
    deliveryRef: payload.deliveryRef,
    observedAtMs,
    deadlineAtMs,
  });
}

/**
 * Projects committed runtime.permission-request effects through the durable
 * pending ingress. It never calls a provider and acknowledges an effect only
 * after the idempotent pending record has been persisted.
 */
export class HostedRuntimePermissionRequestProjector {
  constructor(
    private readonly outbox: RuntimeIngressPermissionOutbox,
    private readonly pendingIngress: HostedTeamApprovalPendingIngressPort,
    private readonly authority: HostedRuntimePermissionIngressAuthorityPort,
    private readonly clock: HostedTeamApprovalRuntimeBridgeClockPort
  ) {}

  async project(
    request: HostedRuntimePermissionProjectionRequest
  ): Promise<HostedRuntimePermissionProjectionResult> {
    const startedAtMs = currentTime(this.clock);
    if (startedAtMs === null || !isOpenRequest(request, startedAtMs)) {
      throw new Error('hosted-runtime-permission-projection-unavailable');
    }
    const records = await this.outbox.claim({
      ownerId: request.ownerId,
      leaseToken: request.leaseToken,
      leaseDurationMs: request.leaseDurationMs,
      limit: request.limit,
    });
    let projected = 0;
    let acknowledged = 0;
    for (const record of records) {
      const beforeProjection = currentTime(this.clock);
      if (
        beforeProjection === null ||
        beforeProjection >= request.deadlineAtMs ||
        !ownsOpenLease(record, request, beforeProjection)
      ) {
        continue;
      }
      try {
        const payload = parseRuntimePermissionApprovalPayload(
          JSON.parse(record.payloadJson) as unknown
        );
        if (payload.expiresAtMs !== null && payload.expiresAtMs <= beforeProjection) continue;
        const resolved = await this.authority.resolvePersistedIngressAuthority(record.authority);
        if (resolved.status !== 'resolved' || resolved.scope.teamId !== record.authority.teamId) {
          continue;
        }
        const beforeObserve = currentTime(this.clock);
        if (
          beforeObserve === null ||
          beforeObserve >= request.deadlineAtMs ||
          !ownsOpenLease(record, request, beforeObserve)
        ) {
          continue;
        }
        const pending = pendingRecordFor(record, resolved.scope, request.deadlineAtMs);
        const observed = await this.pendingIngress.observePending(pending);
        if (
          observed.runId !== pending.runId ||
          observed.requestId !== pending.requestId ||
          observed.approvalId !== pending.approvalId ||
          observed.approvalGeneration !== pending.approvalGeneration
        ) {
          continue;
        }
        projected += 1;
        const beforeAcknowledge = currentTime(this.clock);
        if (
          beforeAcknowledge === null ||
          beforeAcknowledge >= request.deadlineAtMs ||
          !ownsOpenLease(record, request, beforeAcknowledge) ||
          record.lease === null
        ) {
          continue;
        }
        const result = await this.outbox.acknowledge({
          outboxId: record.outboxId,
          generation: record.lease.generation,
          ownerId: request.ownerId,
          leaseToken: request.leaseToken,
        });
        if (result.status === 'acknowledged' || result.status === 'already_acknowledged') {
          acknowledged += 1;
        }
      } catch {
        // Preserve the lease-backed effect for recovery; no partial projection is acknowledged.
      }
    }
    return Object.freeze({
      claimed: records.length,
      projected,
      acknowledged,
      retained: records.length - acknowledged,
    });
  }
}
