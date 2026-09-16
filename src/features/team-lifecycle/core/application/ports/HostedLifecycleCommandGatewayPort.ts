import type {
  HostedLifecycleCommand,
  HostedLifecycleCommandPublicResult,
  HostedLifecycleConflictReason,
  HostedLifecycleControlStateRequest,
  HostedLifecycleControlStateResult,
  HostedLifecyclePrepareRequest,
  HostedLifecyclePrepareResult,
  HostedLifecycleProgressRequest,
  HostedLifecycleProgressResult,
} from '../../../contracts/hosted-lifecycle-commands';
import type {
  ActorId,
  BootId,
  DeploymentId,
  QueryContext,
  Revision,
  TeamId,
  WorkspaceId,
} from '@shared/contracts/hosted';

declare const hostedLifecycleAuthorityBrand: unique symbol;

export type HostedLifecycleGrantId = string & {
  readonly [hostedLifecycleAuthorityBrand]: 'HostedLifecycleGrantId';
};
export type HostedLifecycleAuthorizationGeneration = string & {
  readonly [hostedLifecycleAuthorityBrand]: 'HostedLifecycleAuthorizationGeneration';
};

/** Browser admission evidence that the external owner must compare at the effect boundary. */
export interface HostedLifecycleOwnerEffectFence {
  /** Fresh random revision of the exact user-to-workspace grant (regrant changes it). */
  readonly grantRevision: string;
  /** Exact checksum of the canonical committed team identity used for attribution. */
  readonly identityChecksum: string;
}

/**
 * Opaque authority snapshot issued by the external orchestrator. It is never sent to a browser.
 * Every field is an ABA fence and the complete snapshot must be compared together.
 */
export interface HostedLifecycleCommandAuthorization {
  readonly grantId: HostedLifecycleGrantId;
  readonly authorizationGeneration: HostedLifecycleAuthorizationGeneration;
  readonly deploymentId: DeploymentId;
  readonly bootId: BootId;
  readonly resourceRevision: Revision;
  readonly actorId: ActorId;
  readonly workspaceId: WorkspaceId;
  readonly teamId: TeamId;
  readonly restoreGeneration: number;
  readonly mountGeneration: number;
  readonly ownerEffectFence: HostedLifecycleOwnerEffectFence;
}

export type HostedLifecycleCommandAuthorizationResult =
  | {
      readonly kind: 'authorized';
      readonly authorization: HostedLifecycleCommandAuthorization;
    }
  | {
      readonly kind: 'conflict';
      readonly reason: HostedLifecycleConflictReason;
      readonly currentRevision: Revision | null;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'operator_required' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs: number | null };

export type HostedLifecycleCommandGatewayExecutionResult =
  | {
      readonly kind: 'result';
      readonly result: HostedLifecycleCommandPublicResult;
      readonly authorization: HostedLifecycleCommandAuthorization;
    }
  | { readonly kind: 'started' }
  | { readonly kind: 'operator_required' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs: number | null };

export type HostedLifecycleCommandRevalidationResult =
  | {
      readonly kind: 'valid';
      readonly authorization: HostedLifecycleCommandAuthorization;
    }
  | {
      readonly kind: 'conflict';
      readonly reason: HostedLifecycleConflictReason;
      readonly currentRevision: Revision | null;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'operator_required' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs: number | null };

/**
 * Injected anti-corruption layer for the one external lifecycle/process owner.
 *
 * `execute` is one orchestrator-owned compare-and-commit operation. Before it persists or starts any
 * external effect, the orchestrator must atomically compare the exact grant, authorization
 * generation, boot identity, and resource revision from `authorization`. The web process never
 * owns a lifecycle repository, provider adapter, process supervisor, or recovery loop.
 */
export interface HostedLifecycleCommandGatewayPort {
  getControlState(
    request: HostedLifecycleControlStateRequest,
    context: QueryContext
  ): Promise<HostedLifecycleControlStateResult>;

  prepareProvisioning?(
    request: HostedLifecyclePrepareRequest,
    context: QueryContext
  ): Promise<HostedLifecyclePrepareResult>;

  getProvisioningStatus?(
    request: HostedLifecycleProgressRequest,
    context: QueryContext
  ): Promise<HostedLifecycleProgressResult>;

  authorize(
    command: HostedLifecycleCommand,
    context: QueryContext
  ): Promise<HostedLifecycleCommandAuthorizationResult>;

  revalidate(
    command: HostedLifecycleCommand,
    authorization: HostedLifecycleCommandAuthorization,
    context: QueryContext
  ): Promise<HostedLifecycleCommandRevalidationResult>;

  execute(
    command: HostedLifecycleCommand,
    authorization: HostedLifecycleCommandAuthorization,
    context: QueryContext
  ): Promise<HostedLifecycleCommandGatewayExecutionResult>;
}
