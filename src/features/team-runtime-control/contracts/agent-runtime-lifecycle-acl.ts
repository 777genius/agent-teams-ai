import type { CompositeRuntimePlan, LaneId } from './runtimePlan';

/** Private, machine-to-machine protocol. It is not an operator command surface. */
export const AGENT_RUNTIME_LIFECYCLE_ACL_PROTOCOL_VERSION = 1 as const;
export const AGENT_RUNTIME_LIFECYCLE_ACL_MAX_FRAME_BYTES = 1024 * 1024;

export const AGENT_RUNTIME_LIFECYCLE_EFFECTS = Object.freeze([
  'preflight',
  'launch',
  'observe',
  'stop',
  'recover',
] as const);
export type AgentRuntimeLifecycleEffect = (typeof AGENT_RUNTIME_LIFECYCLE_EFFECTS)[number];

/**
 * A short-lived authority issued to the one external lifecycle orchestrator for
 * the current application boot. The token is presented only over the private
 * machine channel and is never exposed through browser transports.
 */
export interface AgentRuntimeLifecycleCallerLease {
  readonly kind: 'agent-runtime-lifecycle-caller-lease/v1';
  readonly bootId: string;
  readonly leaseId: string;
  readonly authority: 'external_lifecycle_orchestrator';
  readonly callerId: string;
  readonly token: string;
  readonly issuedAtIso: string;
  readonly expiresAtIso: string;
}

/** Exact external-effect claim. Mutating backends durably enforce this binding. */
export interface AgentRuntimeLifecycleEffectLease {
  readonly token: string;
  readonly fence: number;
  readonly ownerId: string;
  readonly claimedAtIso: string;
  readonly expiresAtIso: string;
}

export interface AgentRuntimeLifecycleReadinessReceipt {
  readonly backend: 'provisioning_cli' | 'opencode';
  readonly bindingId: string;
  readonly laneId: LaneId;
  readonly planHash: `sha256:${string}`;
  readonly bindingRevision: number;
  readonly providerRevisions: readonly {
    readonly providerId: 'anthropic' | 'codex' | 'gemini' | 'opencode';
    readonly capabilityRevision: number;
  }[];
}

interface AgentRuntimeLifecycleRequestBase {
  readonly protocolVersion: typeof AGENT_RUNTIME_LIFECYCLE_ACL_PROTOCOL_VERSION;
  readonly requestId: string;
  readonly callerLease: AgentRuntimeLifecycleCallerLease;
  readonly operationId: string;
  readonly effectLease: AgentRuntimeLifecycleEffectLease;
  /** The orchestrator supplies the already accepted immutable plan. */
  readonly plan: CompositeRuntimePlan;
  readonly laneId: LaneId;
}

export interface AgentRuntimeLifecyclePreflightRequest extends AgentRuntimeLifecycleRequestBase {
  readonly effect: 'preflight';
}

export interface AgentRuntimeLifecycleLaunchRequest extends AgentRuntimeLifecycleRequestBase {
  readonly effect: 'launch';
  readonly readiness: AgentRuntimeLifecycleReadinessReceipt;
}

export interface AgentRuntimeLifecycleObserveRequest extends AgentRuntimeLifecycleRequestBase {
  readonly effect: 'observe';
  readonly executionRef: string;
}

export interface AgentRuntimeLifecycleStopRequest extends AgentRuntimeLifecycleRequestBase {
  readonly effect: 'stop';
  readonly executionRef: string;
  readonly mode: 'graceful' | 'immediate';
}

export interface AgentRuntimeLifecycleRecoverRequest extends AgentRuntimeLifecycleRequestBase {
  readonly effect: 'recover';
}

export type AgentRuntimeLifecycleRequest =
  | AgentRuntimeLifecyclePreflightRequest
  | AgentRuntimeLifecycleLaunchRequest
  | AgentRuntimeLifecycleObserveRequest
  | AgentRuntimeLifecycleStopRequest
  | AgentRuntimeLifecycleRecoverRequest;

export type AgentRuntimeLifecycleRejectionReason =
  | 'invalid_request'
  | 'unauthenticated'
  | 'caller_lease_expired'
  | 'caller_lease_boot_mismatch'
  | 'effect_lease_binding_mismatch'
  | 'invalid_plan'
  | 'lane_not_found'
  | 'backend_not_registered'
  | 'provider_not_owned'
  | 'backend_rejected'
  | 'unavailable';

export type AgentRuntimeLifecycleEffectOutcome =
  | { readonly status: 'ready'; readonly readiness: AgentRuntimeLifecycleReadinessReceipt }
  | { readonly status: 'ready' }
  | { readonly status: 'launched' | 'already_launched'; readonly executionRef: string }
  | { readonly status: 'starting' | 'degraded' | 'stopping' }
  | { readonly status: 'exited'; readonly outcome: 'success' | 'failure' | 'unknown' }
  | { readonly status: 'stopped' | 'already_stopped' | 'cancelled' }
  | { readonly status: 'not_started' }
  | { readonly status: 'recovered'; readonly executionRef: string }
  | { readonly status: 'operator_required' }
  | {
      readonly status: 'rejected';
      readonly reason:
        | 'cancelled'
        | 'invalid_plan'
        | 'unsupported'
        | 'unavailable'
        | 'capability_mismatch'
        | 'readiness_mismatch'
        | 'stale_plan'
        | 'not_owned';
    };

export type AgentRuntimeLifecycleResponse =
  | {
      readonly protocolVersion: typeof AGENT_RUNTIME_LIFECYCLE_ACL_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly effect: AgentRuntimeLifecycleEffect;
      readonly status: 'completed';
      readonly outcome: AgentRuntimeLifecycleEffectOutcome;
    }
  | {
      readonly protocolVersion: typeof AGENT_RUNTIME_LIFECYCLE_ACL_PROTOCOL_VERSION;
      readonly requestId: string;
      readonly effect: AgentRuntimeLifecycleEffect | null;
      readonly status: 'rejected';
      readonly reason: AgentRuntimeLifecycleRejectionReason;
    };
