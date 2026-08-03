import type {
  HostedLifecycleCommand,
  HostedLifecycleCommandPublicResult,
  HostedLifecycleConflictReason,
} from '../../../contracts/hosted-lifecycle-commands';
import type { BootId, QueryContext, Revision } from '@shared/contracts/hosted';

declare const hostedLifecycleAuthorityBrand: unique symbol;

export type HostedLifecycleGrantId = string & {
  readonly [hostedLifecycleAuthorityBrand]: 'HostedLifecycleGrantId';
};
export type HostedLifecycleAuthorizationGeneration = string & {
  readonly [hostedLifecycleAuthorityBrand]: 'HostedLifecycleAuthorizationGeneration';
};

/**
 * Opaque authority snapshot issued by the external orchestrator. It is never sent to a browser.
 * Every field is an ABA fence and all four fields must be compared together.
 */
export interface HostedLifecycleCommandAuthorization {
  readonly grantId: HostedLifecycleGrantId;
  readonly authorizationGeneration: HostedLifecycleAuthorizationGeneration;
  readonly bootId: BootId;
  readonly resourceRevision: Revision;
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
  | { readonly kind: 'unavailable'; readonly retryAfterMs: number | null };

export type HostedLifecycleCommandGatewayExecutionResult =
  | {
      readonly kind: 'result';
      readonly result: HostedLifecycleCommandPublicResult;
      readonly authorization: HostedLifecycleCommandAuthorization;
    }
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
