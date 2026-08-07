import type {
  AgentRuntimeLifecycleCallerLease,
  AgentRuntimeLifecycleEffect,
} from '../../../contracts/agent-runtime-lifecycle-acl';
import type { RuntimeCancellation } from '../ports';

export interface AgentRuntimeLifecycleAuthenticatedCaller {
  readonly bootId: string;
  readonly leaseId: string;
  readonly authority: 'external_lifecycle_orchestrator';
  readonly callerId: string;
  readonly expiresAtIso: string;
}

export interface AgentRuntimeLifecycleCallerLeaseAuthenticatorPort {
  authenticate(lease: AgentRuntimeLifecycleCallerLease): Promise<
    | {
        readonly status: 'authenticated';
        readonly caller: AgentRuntimeLifecycleAuthenticatedCaller;
      }
    | { readonly status: 'rejected' | 'unavailable' }
  >;
}

export interface AgentRuntimeLifecycleClockPort {
  nowEpochMs(): number;
}

export interface AgentRuntimeLifecycleCancellationFactoryPort {
  create(input: {
    readonly requestId: string;
    readonly operationId: string;
    readonly effect: AgentRuntimeLifecycleEffect;
  }): RuntimeCancellation;
}
