import type { CompositeRuntimePlan, CompositeRuntimePlanHash, LaneId } from './runtimePlan';

export const RUNTIME_PLAN_ATTESTATION_VERSION = 1 as const;

export type RuntimePlanAttestationOperation =
  | 'preflight'
  | 'launch'
  | 'observe'
  | 'stop'
  | 'recover';

/**
 * Boot-local bearer proof for one exact reconstructed plan operation. The random token is only a
 * lookup key: every visible binding is checked against issuer-owned state during redemption.
 */
export interface RuntimePlanAttestation {
  readonly attestationVersion: typeof RUNTIME_PLAN_ATTESTATION_VERSION;
  readonly token: string;
  readonly authorityId: string;
  readonly bootId: string;
  readonly planHash: CompositeRuntimePlanHash;
  readonly laneId: LaneId;
  readonly operation: RuntimePlanAttestationOperation;
  readonly operationId: string;
  readonly issuedAtIso: string;
  readonly expiresAtIso: string;
}

export interface RuntimePlanAttestationBinding {
  readonly authorityId: string;
  readonly bootId: string;
  readonly laneId: LaneId;
  readonly operation: RuntimePlanAttestationOperation;
  readonly operationId: string;
}

export type RuntimePlanAttestationRedemption =
  | { readonly status: 'redeemed'; readonly plan: CompositeRuntimePlan }
  | {
      readonly status: 'rejected';
      readonly reason: 'unknown' | 'expired' | 'consumed' | 'binding_mismatch' | 'unavailable';
    };
