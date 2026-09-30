import type {
  CompositeRuntimePlan,
  RuntimePlanAttestation,
  RuntimePlanAttestationBinding,
} from '../../../contracts';
import type { RuntimePlanAttestationIssuerPort } from './RuntimePlanAttestationAuthority';

/** Application seam used by the authoritative plan owner; candidates are never returned as proof. */
export class IssueRuntimePlanAttestation {
  constructor(private readonly issuer: RuntimePlanAttestationIssuerPort) {}

  async execute(input: {
    readonly candidate: CompositeRuntimePlan;
    readonly binding: RuntimePlanAttestationBinding;
  }): Promise<RuntimePlanAttestation | null> {
    return await this.issuer.issue(input);
  }
}
