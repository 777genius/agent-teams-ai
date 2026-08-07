import { createHash, timingSafeEqual } from 'node:crypto';

import {
  type AgentRuntimeLifecycleCallerLeaseAuthenticatorPort,
  type AgentRuntimeLifecycleCancellationFactoryPort,
  type AgentRuntimeLifecycleClockPort,
  DispatchAgentRuntimeLifecycleEffect,
} from '../../core/application/agent-runtime-lifecycle';
import {
  type AgentRuntimeLifecycleSocketListenerPort,
  AgentRuntimeLifecycleSocketServer,
  isValidListenerSecurityBinding,
} from '../adapters/input/agent-runtime-lifecycle';

import type { AgentRuntimeLifecycleCallerLease } from '../../contracts/agent-runtime-lifecycle-acl';
import type { ExecutionBackendRegistry } from '../../core/application/backends';

export interface CreateAgentRuntimeLifecycleAclDeps {
  readonly bootId: string;
  readonly callerLease: AgentRuntimeLifecycleCallerLease;
  readonly registry: ExecutionBackendRegistry;
  readonly listener: AgentRuntimeLifecycleSocketListenerPort;
  readonly clock?: AgentRuntimeLifecycleClockPort;
  /** Authoritative lookup owned by the external lifecycle command context. */
  readonly cancellationFactory: AgentRuntimeLifecycleCancellationFactoryPort;
}

/** The only lifecycle surface exposed to the application shell. */
export interface AgentRuntimeLifecycleAcl {
  start(): Promise<void>;
  stop(): Promise<void>;
}

/**
 * Composes an unmounted machine-only effect endpoint. The application shell is
 * responsible for supplying a private listener and explicitly starting it.
 */
export function createAgentRuntimeLifecycleAcl(
  deps: CreateAgentRuntimeLifecycleAclDeps
): AgentRuntimeLifecycleAcl {
  const expectedLease = freezeLease(deps.callerLease);
  if (!isValidCallerLease(expectedLease)) {
    throw new TypeError('agent-runtime-lifecycle-caller-lease-invalid');
  }
  if (expectedLease.bootId !== deps.bootId) {
    throw new TypeError('agent-runtime-lifecycle-caller-lease-boot-mismatch');
  }
  if (
    !isValidListenerSecurityBinding(deps.listener.securityBinding) ||
    deps.listener.securityBinding.bootId !== deps.bootId
  ) {
    throw new TypeError('agent-runtime-lifecycle-listener-security-binding-mismatch');
  }
  if (typeof deps.cancellationFactory?.create !== 'function') {
    throw new TypeError('agent-runtime-lifecycle-cancellation-authority-missing');
  }
  const authenticator = createFixedCallerLeaseAuthenticator(expectedLease);
  const dispatch = new DispatchAgentRuntimeLifecycleEffect({
    bootId: deps.bootId,
    registry: deps.registry,
    callerLeaseAuthenticator: authenticator,
    cancellationFactory: deps.cancellationFactory,
    clock: deps.clock ?? { nowEpochMs: () => Date.now() },
  });
  const server = new AgentRuntimeLifecycleSocketServer({ listener: deps.listener, dispatch });
  return Object.freeze({
    start: () => server.start(),
    stop: () => server.stop(),
  });
}

function createFixedCallerLeaseAuthenticator(
  expected: AgentRuntimeLifecycleCallerLease
): AgentRuntimeLifecycleCallerLeaseAuthenticatorPort {
  return Object.freeze({
    authenticate: async (presented: AgentRuntimeLifecycleCallerLease) => {
      const tokenMatches = equalSecret(presented.token, expected.token);
      if (
        !tokenMatches ||
        presented.kind !== expected.kind ||
        presented.bootId !== expected.bootId ||
        presented.leaseId !== expected.leaseId ||
        presented.authority !== expected.authority ||
        presented.callerId !== expected.callerId ||
        presented.issuedAtIso !== expected.issuedAtIso ||
        presented.expiresAtIso !== expected.expiresAtIso
      ) {
        return { status: 'rejected' as const };
      }
      return {
        status: 'authenticated' as const,
        caller: Object.freeze({
          bootId: expected.bootId,
          leaseId: expected.leaseId,
          authority: expected.authority,
          callerId: expected.callerId,
          expiresAtIso: expected.expiresAtIso,
        }),
      };
    },
  });
}

function equalSecret(left: string, right: string): boolean {
  const leftDigest = createHash('sha256').update(left, 'utf8').digest();
  const rightDigest = createHash('sha256').update(right, 'utf8').digest();
  return timingSafeEqual(leftDigest, rightDigest);
}

function freezeLease(lease: AgentRuntimeLifecycleCallerLease): AgentRuntimeLifecycleCallerLease {
  return Object.freeze({ ...lease });
}

function isValidCallerLease(lease: AgentRuntimeLifecycleCallerLease): boolean {
  const identifier = /^[A-Za-z0-9][A-Za-z0-9._:@/-]{0,511}$/;
  const token = /^[A-Za-z0-9_-]{32,512}$/;
  return (
    lease.kind === 'agent-runtime-lifecycle-caller-lease/v1' &&
    lease.authority === 'external_lifecycle_orchestrator' &&
    identifier.test(lease.bootId) &&
    identifier.test(lease.leaseId) &&
    identifier.test(lease.callerId) &&
    token.test(lease.token) &&
    isCanonicalTimestamp(lease.issuedAtIso) &&
    isCanonicalTimestamp(lease.expiresAtIso) &&
    Date.parse(lease.expiresAtIso) > Date.parse(lease.issuedAtIso)
  );
}

function isCanonicalTimestamp(value: string): boolean {
  return Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value;
}
