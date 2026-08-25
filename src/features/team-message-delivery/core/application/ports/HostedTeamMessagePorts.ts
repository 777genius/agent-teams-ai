import type {
  HostedMessagePersistenceReceipt,
  HostedMessageSourceGeneration,
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

export type HostedMessagePersistenceAdmissionResult =
  | { readonly kind: 'persisted'; readonly receipt: HostedMessagePersistenceReceipt }
  | { readonly kind: 'idempotent_replay'; readonly receipt: HostedMessagePersistenceReceipt }
  | { readonly kind: 'conflict'; readonly reason: 'idempotency_mismatch' }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

/**
 * This port owns one atomic durable admission keyed by the authenticated actor, team, and client
 * message ID. It never performs runtime delivery as part of the persistence transaction.
 */
export interface HostedTeamMessagePersistencePort {
  persist(
    command: SendHostedTeamMessageCommand,
    context: QueryContext
  ): Promise<HostedMessagePersistenceAdmissionResult>;
}

export interface HostedMessageRuntimeDeliveryRequest {
  readonly teamId: TeamId;
  readonly messageId: HostedMessagePersistenceReceipt['messageId'];
  readonly clientMessageId: HostedMessagePersistenceReceipt['clientMessageId'];
  readonly text: string;
}

export type HostedMessageRuntimeDeliveryResult =
  | { readonly kind: 'delivered' }
  | { readonly kind: 'pending' }
  | { readonly kind: 'operator_required' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

/**
 * Runtime delivery is intentionally a separate capability. It owns its own durable effect ledger:
 * after an ambiguous outcome, the same persisted message must keep returning `operator_required`
 * and must not be sent again automatically.
 */
export interface HostedTeamMessageRuntimeDeliveryPort {
  deliver(
    request: HostedMessageRuntimeDeliveryRequest,
    context: QueryContext
  ): Promise<HostedMessageRuntimeDeliveryResult>;
}

export interface HostedMessageClockPort {
  now(): number;
}
