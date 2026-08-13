import type {
  HostedTeamApprovalAuthorityScope,
  HostedTeamApprovalStorageDecision,
} from '@features/internal-storage/contracts';
import type { RuntimeIngressPermissionOutboxPort } from '@features/team-runtime-control';
import type { RuntimePermissionApprovalIngressAuthority } from '@features/team-runtime-control/contracts';

/** The bridge can only claim and acknowledge committed ingress effects. */
export type HostedRuntimePermissionIngressEffectPort = Pick<
  RuntimeIngressPermissionOutboxPort,
  'claimPermissionApprovalIngressEffects' | 'acknowledgePermissionApprovalIngressEffect'
>;

/** A small clock seam keeps lease and deadline checks deterministic. */
export interface HostedTeamApprovalRuntimeBridgeClockPort {
  now(): number;
}

/**
 * Resolves an approval scope from the immutable authority copied into the
 * committed ingress effect. Implementations must not use a provider body,
 * runtime-selected principal, or a caller-selected team/run/lane/provider.
 */
export interface HostedRuntimePermissionIngressAuthorityPort {
  resolvePersistedIngressAuthority(authority: RuntimePermissionApprovalIngressAuthority): Promise<
    | { readonly status: 'resolved'; readonly scope: HostedTeamApprovalAuthorityScope }
    | {
        readonly status: 'stale_generation' | 'wrong_lane' | 'unavailable';
      }
  >;
}

/**
 * Narrow external-lifecycle handoff for a durable approval decision. The
 * lifecycle owner re-binds deliveryRef to its persisted ingress authority and
 * treats providerDeliveryId as an idempotency key before answering a provider.
 */
export interface HostedApprovalDecisionExternalLifecycleDeliveryPort {
  deliverRuntimePermissionDecision(request: {
    readonly providerDeliveryId: string;
    readonly principal:
      | Readonly<{ readonly kind: 'operator'; readonly actorId: string }>
      | Readonly<{ readonly kind: 'system_timeout' }>;
    readonly deliveryRef: string;
    readonly approvalId: string;
    readonly approvalGeneration: string;
    readonly decision: HostedTeamApprovalStorageDecision;
    readonly partition: Readonly<{ teamId: string; runId: string }>;
    readonly requestId: string;
  }): Promise<
    | { readonly status: 'delivered' | 'idempotent_replay' }
    | {
        readonly status:
          | 'stale_generation'
          | 'expired'
          | 'wrong_lane'
          | 'self_approval'
          | 'unavailable';
      }
  >;
}
