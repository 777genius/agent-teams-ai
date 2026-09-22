import {
  decodeCompositeRuntimePlan,
  IssueRuntimePlanAttestation,
} from '../../core/application/planning';
import { InMemoryRuntimePlanAttestationAuthority } from '../infrastructure/planning/InMemoryRuntimePlanAttestationAuthority';

import type { CompositeRuntimePlan } from '../../contracts';
import type { RuntimePlanAttestationAuthorityPort } from '../../core/application/planning';

export interface HostedRuntimeAuthority extends RuntimePlanAttestationAuthorityPort {
  readonly authorityId: string;
  readonly bootId: string;
  /** Composition-owned planner hook; transport callers never receive it. */
  rememberReconstructedPlan(plan: CompositeRuntimePlan): void;
}

export interface HostedRuntimeAuthorityMount {
  hostedRuntimeAuthority?: HostedRuntimeAuthority;
}

export interface HostedRuntimeAuthorityCrypto {
  randomUuid(): string;
  randomBytes(length: number): Uint8Array;
  base64UrlEncode(value: Uint8Array): string;
  secureEqual(left: string, right: string): boolean;
}

/** Mounts the one boot-local authority at the main-process feature composition boundary. */
export function mountHostedRuntimeAuthority(
  target: HostedRuntimeAuthorityMount,
  crypto: HostedRuntimeAuthorityCrypto
): HostedRuntimeAuthority {
  if (target.hostedRuntimeAuthority !== undefined) {
    throw new Error('hosted-runtime-authority-already-mounted');
  }
  const authorityId = `runtime-authority:${crypto.randomUuid()}`;
  const bootId = `runtime-boot:${crypto.randomUuid()}`;
  const plans = new Map<
    CompositeRuntimePlan['teamId'],
    { readonly plan: CompositeRuntimePlan; readonly revision: number }
  >();
  const authority = new InMemoryRuntimePlanAttestationAuthority({
    authorityId,
    bootId,
    plans: {
      reconstruct: async ({ candidate }) => {
        const snapshot = plans.get(candidate.teamId);
        return snapshot && samePlanIdentity(snapshot.plan, candidate) ? snapshot : null;
      },
      currentRevision: ({ candidate }) => {
        const snapshot = plans.get(candidate.teamId);
        return snapshot && samePlanIdentity(snapshot.plan, candidate) ? snapshot.revision : null;
      },
    },
    crypto,
  });
  const issueAttestation = new IssueRuntimePlanAttestation(authority);
  const mounted = Object.freeze({
    authorityId,
    bootId,
    issue: issueAttestation.execute.bind(issueAttestation),
    redeem: authority.redeem.bind(authority),
    rememberReconstructedPlan: (value: CompositeRuntimePlan) => {
      const plan = decodeCompositeRuntimePlan(value);
      const previous = plans.get(plan.teamId);
      if (previous && samePlanIdentity(previous.plan, plan)) return;
      plans.set(plan.teamId, {
        plan,
        revision: (previous?.revision ?? 0) + 1,
      });
    },
  });
  target.hostedRuntimeAuthority = mounted;
  return mounted;
}

function samePlanIdentity(left: CompositeRuntimePlan, right: CompositeRuntimePlan): boolean {
  return (
    left.teamId === right.teamId &&
    left.runId === right.runId &&
    left.generation === right.generation &&
    left.planHash === right.planHash
  );
}
