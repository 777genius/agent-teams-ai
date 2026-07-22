import type {
  CompositeRuntimePlan,
  CompositeRuntimePlanHash,
  LaneId,
  ProcessExecutionUnit,
  RuntimeBackendBindingId,
  RuntimeExecutionBackendKind,
  RuntimePlanLaneBinding,
} from '../../../contracts';
import type { RuntimeCancellation } from '../ports';
import type { TeamProviderId } from '@shared/types';

declare const laneExecutionRefBrand: unique symbol;

export type LaneExecutionRef = string & {
  readonly [laneExecutionRefBrand]: 'LaneExecutionRef';
};

export const LANE_EXECUTION_OPERATION_REJECTION_REASONS = Object.freeze([
  'cancelled',
  'invalid_plan',
  'unsupported',
  'unavailable',
  'capability_mismatch',
  'readiness_mismatch',
  'stale_plan',
  'not_owned',
] as const);
export type LaneExecutionOperationRejectionReason =
  (typeof LANE_EXECUTION_OPERATION_REJECTION_REASONS)[number];

export type LaneExecutionPlanRejectionReason =
  | 'invalid_plan'
  | 'backend_mismatch'
  | 'unsupported_provider';

export interface LaneExecutionScope {
  /** A fully decoded, immutable plan. Backends may execute it but may not re-plan it. */
  readonly plan: CompositeRuntimePlan;
  readonly lane: RuntimePlanLaneBinding;
  readonly executionUnit: ProcessExecutionUnit;
  /** Stable lane-owner-first provider order derived from the accepted plan. */
  readonly requiredProviderIds: readonly TeamProviderId[];
}

export interface LaneExecutionProviderCapability {
  readonly backend: RuntimeExecutionBackendKind;
  readonly bindingId: RuntimeBackendBindingId;
  readonly bindingRevision: number;
  readonly providerId: TeamProviderId;
  readonly capabilityRevision: number;
  readonly supported: boolean;
  readonly readiness: 'ready' | 'not_ready';
}

export interface LaneExecutionReadinessReceipt {
  readonly backend: RuntimeExecutionBackendKind;
  readonly bindingId: RuntimeBackendBindingId;
  readonly laneId: LaneId;
  readonly planHash: CompositeRuntimePlanHash;
  readonly bindingRevision: number;
  readonly providerRevisions: readonly {
    readonly providerId: TeamProviderId;
    readonly capabilityRevision: number;
  }[];
}

export type LaneExecutionPlanValidationOutcome =
  | { readonly status: 'accepted' }
  | { readonly status: 'rejected'; readonly reason: LaneExecutionPlanRejectionReason };

export interface LaneExecutionRequest {
  readonly scope: LaneExecutionScope;
}

export interface CancellableLaneExecutionRequest extends LaneExecutionRequest {
  readonly cancellation: RuntimeCancellation;
}

export type LaneExecutionPreflightDecision =
  | { readonly status: 'ready' }
  | {
      readonly status: 'rejected';
      readonly reason: LaneExecutionOperationRejectionReason;
    };

export type LaneExecutionPreflightOutcome =
  | {
      readonly status: 'ready';
      readonly readiness: LaneExecutionReadinessReceipt;
    }
  | {
      readonly status: 'rejected';
      readonly reason: LaneExecutionOperationRejectionReason;
    };

export interface LaunchLaneExecutionRequest extends CancellableLaneExecutionRequest {
  readonly readiness: LaneExecutionReadinessReceipt;
}

export type LaneExecutionLaunchOutcome =
  | {
      readonly status: 'launched' | 'already_launched';
      readonly executionRef: LaneExecutionRef;
    }
  | { readonly status: 'operator_required' }
  | {
      readonly status: 'rejected';
      readonly reason: LaneExecutionOperationRejectionReason;
    };

export interface ObserveLaneExecutionRequest extends LaneExecutionRequest {
  readonly executionRef: LaneExecutionRef;
}

export type LaneExecutionObserveOutcome =
  | { readonly status: 'starting' | 'ready' | 'degraded' | 'stopping' }
  | { readonly status: 'exited'; readonly outcome: 'success' | 'failure' | 'unknown' }
  | { readonly status: 'operator_required' }
  | {
      readonly status: 'rejected';
      readonly reason: LaneExecutionOperationRejectionReason;
    };

export interface StopLaneExecutionRequest extends CancellableLaneExecutionRequest {
  readonly executionRef: LaneExecutionRef;
  readonly mode: 'graceful' | 'immediate';
}

export type LaneExecutionStopOutcome =
  | { readonly status: 'stopped' | 'already_stopped' | 'cancelled' }
  | { readonly status: 'operator_required' }
  | {
      readonly status: 'rejected';
      readonly reason: LaneExecutionOperationRejectionReason;
    };

export type LaneExecutionRecoverOutcome =
  | { readonly status: 'not_started' | 'cancelled' }
  | { readonly status: 'recovered'; readonly executionRef: LaneExecutionRef }
  | { readonly status: 'operator_required' }
  | {
      readonly status: 'rejected';
      readonly reason: LaneExecutionOperationRejectionReason;
    };

/**
 * The provider-neutral lifecycle surface for one immutable planner lane.
 * Implementations delegate to an existing execution authority and never own planning or spawning.
 */
export interface LaneExecutionBackend {
  readonly backend: RuntimeExecutionBackendKind;
  readonly supportedProviderIds: readonly TeamProviderId[];

  validatePlan(scope: LaneExecutionScope): LaneExecutionPlanValidationOutcome;
  preflight(request: CancellableLaneExecutionRequest): Promise<LaneExecutionPreflightOutcome>;
  launch(request: LaunchLaneExecutionRequest): Promise<LaneExecutionLaunchOutcome>;
  observe(request: ObserveLaneExecutionRequest): Promise<LaneExecutionObserveOutcome>;
  stop(request: StopLaneExecutionRequest): Promise<LaneExecutionStopOutcome>;
  recover(request: CancellableLaneExecutionRequest): Promise<LaneExecutionRecoverOutcome>;
}

const LANE_EXECUTION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

export function parseLaneExecutionRef(value: unknown): LaneExecutionRef {
  if (typeof value !== 'string' || !LANE_EXECUTION_REF_PATTERN.test(value)) {
    throw new TypeError('lane-execution-ref-invalid');
  }
  return value as LaneExecutionRef;
}

export function isLaneExecutionOperationRejectionReason(
  value: unknown
): value is LaneExecutionOperationRejectionReason {
  return (LANE_EXECUTION_OPERATION_REJECTION_REASONS as readonly unknown[]).includes(value);
}
