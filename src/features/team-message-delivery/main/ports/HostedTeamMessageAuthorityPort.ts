import type {
  HostedMessageSourceGeneration,
  HostedTeamMessage,
  SendHostedTeamMessageCommand,
} from '../../contracts/hosted';
import type { HostedTeamMessageSendAdmissionResult } from '../../core/application/ports/HostedTeamMessagePorts';
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
 * The hosted authority is limited to one team-scoped read and one send. It deliberately exposes no
 * process, storage, or external-engine representation. `sendMessage` stores and delivers in one
 * owner operation keyed by the team and client message ID: a matching retry replays its receipt,
 * a changed command is an idempotency conflict, and an ambiguous delivery stays
 * operator-required instead of being sent again.
 */
export interface HostedTeamMessageAuthorityPort {
  readWindow(
    request: HostedTeamMessageAuthorityReadWindowRequest,
    context: QueryContext
  ): Promise<HostedTeamMessageAuthorityReadWindowResult>;
  sendMessage(
    command: SendHostedTeamMessageCommand,
    context: QueryContext
  ): Promise<HostedTeamMessageSendAdmissionResult>;
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
  'sendMessage'
> {
  /** Binds the request's exact durable grant revision to the final owner effect boundary. */
  bindGrantFence(context: QueryContext, fence: HostedMutationGrantFence): void;
}
