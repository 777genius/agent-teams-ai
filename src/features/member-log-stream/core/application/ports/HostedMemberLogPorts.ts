import type {
  HostedMemberLogEntry,
  HostedMemberLogSelectionId,
  HostedMemberLogSourceGeneration,
} from '../../../contracts/hosted';
import type { Cursor, MemberId, QueryContext, Revision, TeamId } from '@shared/contracts/hosted';

/**
 * The browser's selection id is an opaque locator, not authority. The implementation must resolve
 * it from a production-owned grant bound to `context` before choosing any team, member, or source.
 */
export interface HostedMemberLogAuthorityReadRequest {
  readonly selectionId: HostedMemberLogSelectionId;
  readonly cursor: Cursor | null;
  readonly expectedSourceGeneration: HostedMemberLogSourceGeneration | null;
  /** The authority may return at most this many candidates in its continuation order. */
  readonly itemLimit: number;
  /** Applies to the final browser-safe projection, including its envelope. */
  readonly byteLimit: number;
  readonly deadlineAtMs: number;
}

export interface HostedMemberLogAuthorityCandidate {
  /** Raw authority text is normalized and redacted by the use case before it can reach HTTP. */
  readonly entry: HostedMemberLogEntry;
  readonly cursorAfter: Cursor;
}

export type HostedMemberLogAuthorityReadResult =
  | {
      readonly kind: 'found';
      readonly selectionId: HostedMemberLogSelectionId;
      readonly teamId: TeamId;
      readonly memberId: MemberId;
      readonly sourceGeneration: HostedMemberLogSourceGeneration;
      readonly revision: Revision;
      readonly candidates: readonly HostedMemberLogAuthorityCandidate[];
      readonly hasMore: boolean;
    }
  | {
      readonly kind: 'stale_generation';
      readonly currentSourceGeneration: HostedMemberLogSourceGeneration;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

/**
 * Production-trusted hosted member-log authority. It revalidates the live grant in `context`,
 * resolves `selectionId` server-side, and scopes continuation state to that resolved selection.
 * Caller supplied workspace paths, team ids, member names, and member ids are deliberately absent.
 */
export interface HostedMemberLogAuthorityPort {
  readPage(
    request: HostedMemberLogAuthorityReadRequest,
    context: QueryContext
  ): Promise<HostedMemberLogAuthorityReadResult>;
}

export interface HostedMemberLogClockPort {
  now(): number;
}
