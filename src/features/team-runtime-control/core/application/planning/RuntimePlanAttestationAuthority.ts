import type {
  CompositeRuntimePlan,
  RuntimePlanAttestation,
  RuntimePlanAttestationBinding,
  RuntimePlanAttestationRedemption,
} from '../../../contracts';

export interface AuthoritativeRuntimePlanSourcePort {
  reconstruct(input: {
    readonly candidate: CompositeRuntimePlan;
  }): Promise<AuthoritativeRuntimePlanSnapshot | null>;
  /** Synchronous revision read makes post-reconstruction validation atomic in one JS turn. */
  currentRevision(input: { readonly candidate: CompositeRuntimePlan }): number | null;
}

export interface AuthoritativeRuntimePlanSnapshot {
  readonly plan: CompositeRuntimePlan;
  readonly revision: number;
}

export interface RuntimePlanAttestationIssuerPort {
  issue(input: {
    readonly candidate: CompositeRuntimePlan;
    readonly binding: RuntimePlanAttestationBinding;
  }): Promise<RuntimePlanAttestation | null>;
}

export interface RuntimePlanAttestationRedeemerPort {
  redeem(
    attestation: unknown,
    binding: RuntimePlanAttestationBinding
  ): Promise<RuntimePlanAttestationRedemption>;
}

export interface RuntimePlanAttestationAuthorityPort
  extends RuntimePlanAttestationIssuerPort, RuntimePlanAttestationRedeemerPort {}
