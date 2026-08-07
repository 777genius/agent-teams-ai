import {
  type ExecutionBackendRegistry,
  hasValidLaneExecutionMutationBinding,
  type LaneExecutionReadinessReceipt,
  parseLaneExecutionRef,
} from '../backends';

import type {
  AgentRuntimeLifecycleEffect,
  AgentRuntimeLifecycleEffectOutcome,
  AgentRuntimeLifecycleRejectionReason,
  AgentRuntimeLifecycleRequest,
  AgentRuntimeLifecycleResponse,
} from '../../../contracts/agent-runtime-lifecycle-acl';
import type { RuntimeCancellation } from '../ports';
import type {
  AgentRuntimeLifecycleCallerLeaseAuthenticatorPort,
  AgentRuntimeLifecycleCancellationFactoryPort,
  AgentRuntimeLifecycleClockPort,
} from './ports';

export interface DispatchAgentRuntimeLifecycleEffectDeps {
  readonly bootId: string;
  readonly registry: ExecutionBackendRegistry;
  readonly callerLeaseAuthenticator: AgentRuntimeLifecycleCallerLeaseAuthenticatorPort;
  readonly cancellationFactory: AgentRuntimeLifecycleCancellationFactoryPort;
  readonly clock: AgentRuntimeLifecycleClockPort;
}

/**
 * Executes exactly one already-planned lane effect through its registered
 * backend. Lifecycle command semantics remain outside this boundary.
 */
export class DispatchAgentRuntimeLifecycleEffect {
  constructor(private readonly deps: DispatchAgentRuntimeLifecycleEffectDeps) {
    if (!isBoundedIdentifier(deps.bootId, 512)) {
      throw new TypeError('agent-runtime-lifecycle-boot-id-invalid');
    }
  }

  async execute(request: AgentRuntimeLifecycleRequest): Promise<AgentRuntimeLifecycleResponse> {
    if (!isCallerAuthorityShapeValid(request)) {
      return reject(request, 'invalid_request');
    }
    const rejected = await this.authenticate(request);
    if (rejected) return rejected;
    if (!hasValidLaneExecutionMutationBinding(request)) {
      return reject(request, 'invalid_request');
    }

    // Operation/cancellation resolution is deliberately after caller authentication.
    // The returned owner is authoritative; it is never derived from the presented lease.
    let cancellation: RuntimeCancellation;
    try {
      cancellation = this.cancellation(request);
    } catch {
      return reject(request, 'unavailable');
    }
    const leaseRejected = this.validateEffectLease(request, cancellation);
    if (leaseRejected) return leaseRejected;

    let resolved: ReturnType<ExecutionBackendRegistry['resolve']>;
    try {
      resolved = this.deps.registry.resolve(request.plan, request.laneId);
    } catch {
      return reject(request, 'unavailable');
    }
    if (resolved.status === 'rejected') {
      return reject(request, resolved.reason);
    }

    try {
      switch (request.effect) {
        case 'preflight':
          return complete(
            request,
            await resolved.backend.preflight({
              scope: resolved.scope,
              cancellation,
            })
          );
        case 'launch':
          return complete(
            request,
            await resolved.backend.launch({
              scope: resolved.scope,
              cancellation,
              operationId: request.operationId,
              effectLease: request.effectLease,
              readiness: request.readiness as LaneExecutionReadinessReceipt,
            })
          );
        case 'observe':
          return complete(
            request,
            await resolved.backend.observe({
              scope: resolved.scope,
              executionRef: parseLaneExecutionRef(request.executionRef),
            })
          );
        case 'stop':
          return complete(
            request,
            await resolved.backend.stop({
              scope: resolved.scope,
              cancellation,
              operationId: request.operationId,
              effectLease: request.effectLease,
              executionRef: parseLaneExecutionRef(request.executionRef),
              mode: request.mode,
            })
          );
        case 'recover':
          return complete(
            request,
            await resolved.backend.recover({
              scope: resolved.scope,
              cancellation,
              operationId: request.operationId,
              effectLease: request.effectLease,
            })
          );
      }
    } catch {
      return reject(request, 'unavailable');
    }
  }

  private cancellation(request: AgentRuntimeLifecycleRequest) {
    return this.deps.cancellationFactory.create({
      requestId: request.requestId,
      operationId: request.operationId,
      effect: request.effect,
    });
  }

  private async authenticate(
    request: AgentRuntimeLifecycleRequest
  ): Promise<AgentRuntimeLifecycleResponse | null> {
    const now = this.deps.clock.nowEpochMs();
    if (!Number.isFinite(now)) return reject(request, 'unavailable');
    if (request.callerLease.bootId !== this.deps.bootId) {
      return reject(request, 'caller_lease_boot_mismatch');
    }
    const issuedAt = Date.parse(request.callerLease.issuedAtIso);
    const expiresAt = Date.parse(request.callerLease.expiresAtIso);
    if (
      !Number.isFinite(issuedAt) ||
      !Number.isFinite(expiresAt) ||
      expiresAt <= issuedAt ||
      now < issuedAt ||
      now >= expiresAt
    ) {
      return reject(request, 'caller_lease_expired');
    }

    let authentication: Awaited<
      ReturnType<AgentRuntimeLifecycleCallerLeaseAuthenticatorPort['authenticate']>
    >;
    try {
      authentication = await this.deps.callerLeaseAuthenticator.authenticate(request.callerLease);
    } catch {
      return reject(request, 'unavailable');
    }
    if (authentication.status !== 'authenticated') {
      return reject(
        request,
        authentication.status === 'unavailable' ? 'unavailable' : 'unauthenticated'
      );
    }
    const caller = authentication.caller;
    if (
      caller.bootId !== this.deps.bootId ||
      caller.bootId !== request.callerLease.bootId ||
      caller.leaseId !== request.callerLease.leaseId ||
      caller.authority !== 'external_lifecycle_orchestrator' ||
      caller.authority !== request.callerLease.authority ||
      caller.callerId !== request.callerLease.callerId ||
      caller.expiresAtIso !== request.callerLease.expiresAtIso
    ) {
      return reject(request, 'unauthenticated');
    }
    return null;
  }

  private validateEffectLease(
    request: AgentRuntimeLifecycleRequest,
    cancellation: RuntimeCancellation
  ): AgentRuntimeLifecycleResponse | null {
    const now = this.deps.clock.nowEpochMs();
    const issuedAt = Date.parse(request.callerLease.issuedAtIso);
    const expiresAt = Date.parse(request.callerLease.expiresAtIso);
    if (
      !Number.isFinite(now) ||
      !isBoundedIdentifier(cancellation.cancellationId, 512) ||
      request.effectLease.ownerId !== cancellation.cancellationId ||
      Date.parse(request.effectLease.claimedAtIso) < issuedAt ||
      now < Date.parse(request.effectLease.claimedAtIso) ||
      now >= Date.parse(request.effectLease.expiresAtIso) ||
      Date.parse(request.effectLease.expiresAtIso) > expiresAt
    ) {
      return reject(request, 'effect_lease_binding_mismatch');
    }
    return null;
  }
}

function complete(
  request: AgentRuntimeLifecycleRequest,
  outcome: unknown
): AgentRuntimeLifecycleResponse {
  return Object.freeze({
    protocolVersion: 1,
    requestId: request.requestId,
    effect: request.effect,
    status: 'completed',
    outcome: outcome as AgentRuntimeLifecycleEffectOutcome,
  }) as AgentRuntimeLifecycleResponse;
}

function isCallerAuthorityShapeValid(request: AgentRuntimeLifecycleRequest): boolean {
  const callerLease = request?.callerLease;
  return (
    isBoundedIdentifier(request?.requestId, 512) &&
    typeof callerLease === 'object' &&
    callerLease !== null &&
    callerLease.kind === 'agent-runtime-lifecycle-caller-lease/v1' &&
    callerLease.authority === 'external_lifecycle_orchestrator' &&
    isBoundedIdentifier(callerLease.bootId, 512) &&
    isBoundedIdentifier(callerLease.leaseId, 512) &&
    isBoundedIdentifier(callerLease.callerId, 512) &&
    isBoundedIdentifier(callerLease.token, 512) &&
    isCanonicalTimestamp(callerLease.issuedAtIso) &&
    isCanonicalTimestamp(callerLease.expiresAtIso)
  );
}

function reject(
  request: Pick<AgentRuntimeLifecycleRequest, 'requestId' | 'effect'>,
  reason: AgentRuntimeLifecycleRejectionReason
): AgentRuntimeLifecycleResponse {
  return Object.freeze({
    protocolVersion: 1,
    requestId: request.requestId,
    effect: request.effect,
    status: 'rejected',
    reason,
  });
}

function isBoundedIdentifier(value: unknown, maximumLength: number): value is string {
  if (typeof value !== 'string' || value.length < 1 || value.length > maximumLength) return false;
  for (let index = 0; index < value.length; index += 1) {
    const codePoint = value.charCodeAt(index);
    if (codePoint <= 31 || codePoint === 127) return false;
  }
  return true;
}

function isCanonicalTimestamp(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    Number.isFinite(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function rejectInvalidAgentRuntimeLifecycleFrame(
  requestId: string,
  effect: AgentRuntimeLifecycleEffect | null
): AgentRuntimeLifecycleResponse {
  return Object.freeze({
    protocolVersion: 1,
    requestId,
    effect,
    status: 'rejected',
    reason: 'invalid_request',
  });
}
