import type {
  HostedMessageSourceGeneration,
  HostedTeamMessage,
  SendHostedTeamMessageCommand,
} from '../../contracts/hosted';
import type {
  HostedMessagePersistenceAdmissionResult,
  HostedMessageRuntimeDeliveryRequest,
  HostedMessageRuntimeDeliveryResult,
} from '../../core/application/ports/HostedTeamMessagePorts';
import type { QueryContext, Revision, TeamId } from '@shared/contracts/hosted';

export interface HostedTeamMessageAuthorityReadWindowRequest {
  readonly teamId: TeamId;
  readonly afterMessageId: HostedTeamMessage['messageId'] | null;
  readonly expectedSourceGeneration: HostedMessageSourceGeneration | null;
  readonly itemLimit: number;
  readonly deadlineAtMs: number;
}

export type HostedTeamMessageAuthorityReadWindowResult =
  | {
      readonly kind: 'found';
      readonly teamId: TeamId;
      readonly sourceGeneration: HostedMessageSourceGeneration;
      readonly revision: Revision;
      /** Messages are in the authority's continuation order. */
      readonly messages: readonly HostedTeamMessage[];
      readonly hasMore: boolean;
    }
  | {
      readonly kind: 'stale_generation';
      readonly currentSourceGeneration: HostedMessageSourceGeneration;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

/**
 * The hosted authority is limited to one team-scoped read, one durable send admission, and one
 * persisted-message runtime delivery request. It deliberately exposes no process, storage, or
 * external-engine representation. `persistMessage` atomically binds the authenticated actor,
 * team, and client message ID; a matching retry replays its receipt and a changed command is an
 * idempotency conflict. `deliverPersistedMessage` owns the durable ambiguity ledger and never
 * automatically re-sends an operator-required message.
 */
export interface HostedTeamMessageAuthorityPort {
  readWindow(
    request: HostedTeamMessageAuthorityReadWindowRequest,
    context: QueryContext
  ): Promise<HostedTeamMessageAuthorityReadWindowResult>;
  persistMessage(
    command: SendHostedTeamMessageCommand,
    context: QueryContext
  ): Promise<HostedMessagePersistenceAdmissionResult>;
  deliverPersistedMessage(
    request: HostedMessageRuntimeDeliveryRequest,
    context: QueryContext
  ): Promise<HostedMessageRuntimeDeliveryResult>;
  /** Optional final-effect grant fence supplied only by an admitted mutation owner. */
  bindGrantFence?(context: QueryContext, fence: HostedMutationGrantFence): void;
}

export interface HostedMutationGrantFence {
  /** Immutable browser-admission evidence forwarded to the external effect owner. */
  readonly ownerEffectFence: Readonly<{
    readonly grantRevision: string;
    readonly identityChecksum: string;
  }>;
  revalidate(): Promise<boolean>;
}

/** Mutation-only authority supplied by the already-admitted external lifecycle owner. */
export interface HostedTeamMessageMutationAuthorityPort extends Pick<
  HostedTeamMessageAuthorityPort,
  'persistMessage' | 'deliverPersistedMessage'
> {
  /** Binds the request's exact durable grant revision to the final owner effect boundary. */
  bindGrantFence(context: QueryContext, fence: HostedMutationGrantFence): void;
}
