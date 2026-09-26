import type {
  HostedMessageSourceGeneration,
  HostedTeamMessageSendReceipt,
  HostedTeamMessage,
  SendHostedTeamMessageCommand,
} from '../../../contracts/hosted';
import type { Cursor, QueryContext, Revision, TeamId } from '@shared/contracts/hosted';

export interface HostedMessagePageSourceRequest {
  readonly teamId: TeamId;
  readonly cursor: Cursor | null;
  readonly expectedSourceGeneration: HostedMessageSourceGeneration | null;
  readonly itemLimit: number;
  readonly deadlineAtMs: number;
}

/** Candidates are already in authority continuation order; the cursor resumes after its candidate. */
export interface HostedMessagePageCandidate {
  readonly message: HostedTeamMessage;
  readonly cursorAfter: Cursor;
}

export type HostedMessagePageSourceResult =
  | {
      readonly kind: 'found';
      readonly teamId: TeamId;
      readonly sourceGeneration: HostedMessageSourceGeneration;
      readonly revision: Revision;
      readonly candidates: readonly HostedMessagePageCandidate[];
      readonly hasMore: boolean;
    }
  | {
      readonly kind: 'stale_generation';
      readonly currentSourceGeneration: HostedMessageSourceGeneration;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

export interface HostedMessagePageSourcePort {
  /** A continuation must compare its generation before reading candidates from a replacement source. */
  readPage(
    request: HostedMessagePageSourceRequest,
    context: QueryContext
  ): Promise<HostedMessagePageSourceResult>;
}

export type HostedTeamMessageSendAdmissionResult =
  | { readonly kind: 'persisted'; readonly receipt: HostedTeamMessageSendReceipt }
  | { readonly kind: 'idempotent_replay'; readonly receipt: HostedTeamMessageSendReceipt }
  | { readonly kind: 'conflict'; readonly reason: 'idempotency_mismatch' }
  | { readonly kind: 'not_found' }
  /** The recipient is not an active teammate in the owner's current roster; nothing was stored. */
  | { readonly kind: 'invalid_recipient' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

/**
 * One owner operation stores and delivers a browser message. The message id is derived from the
 * team and client message id, so a retry after any restart replays the stored row instead of
 * writing a second one, and a changed command is an idempotency conflict. The receipt reports
 * runtime delivery separately from durable persistence: `delivered` only once the recipient's
 * runtime accepted it; the owner keeps an ambiguous delivery `operator_required` and never sends
 * it again automatically.
 */
export interface HostedTeamMessageSendPort {
  send(
    command: SendHostedTeamMessageCommand,
    context: QueryContext
  ): Promise<HostedTeamMessageSendAdmissionResult>;
}

export interface HostedMessageClockPort {
  now(): number;
}
