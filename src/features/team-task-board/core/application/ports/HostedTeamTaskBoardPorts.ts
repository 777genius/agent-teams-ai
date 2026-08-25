import type {
  HostedTaskBoardColumn,
  HostedTaskBoardDegradedReason,
  HostedTaskBoardItem,
  HostedTaskBoardSourceGeneration,
  HostedTaskBoardTruncationReason,
  HostedTaskMutationCommand,
  HostedTaskMutationCommittedReceipt,
  HostedTaskMutationReplayReceipt,
} from '../../../contracts/hosted';
import type { Cursor, QueryContext, Revision, TeamId } from '@shared/contracts/hosted';

export interface HostedTaskBoardPageSourceRequest {
  readonly teamId: TeamId;
  readonly cursor: Cursor | null;
  readonly expectedSourceGeneration: HostedTaskBoardSourceGeneration | null;
  readonly itemLimit: number;
  readonly byteLimit: number;
  readonly deadlineAtMs: number;
}

/**
 * Candidates are in source continuation order. `cursorAfter` must resume immediately after its
 * candidate in that same order; consumers must not reorder candidates independently of cursors.
 */
export interface HostedTaskBoardPageCandidate {
  readonly item: HostedTaskBoardItem;
  readonly cursorAfter: Cursor;
}

export type HostedTaskBoardPageSourceResult =
  | {
      readonly kind: 'found';
      readonly teamId: TeamId;
      readonly sourceGeneration: HostedTaskBoardSourceGeneration;
      readonly revision: Revision;
      readonly candidates: readonly HostedTaskBoardPageCandidate[];
      readonly hasMore: boolean;
      readonly truncatedBy: HostedTaskBoardTruncationReason | null;
      readonly degradedReasons: readonly HostedTaskBoardDegradedReason[];
    }
  | {
      readonly kind: 'stale_generation';
      readonly currentSourceGeneration: HostedTaskBoardSourceGeneration;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

export interface HostedTaskBoardPageSourcePort {
  /**
   * For a continuation, compare `expectedSourceGeneration` in the same source observation used for
   * the page and return `stale_generation` before reading candidates when it differs.
   */
  readPage(
    request: HostedTaskBoardPageSourceRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardPageSourceResult>;
}

export interface HostedTaskBoardClockPort {
  now(): number;
}

export type HostedTaskMutationAdmissionResult =
  | {
      readonly kind: 'committed';
      readonly receipt: HostedTaskMutationCommittedReceipt;
    }
  | {
      readonly kind: 'idempotent_replay';
      readonly receipt: HostedTaskMutationReplayReceipt;
    }
  | {
      readonly kind: 'stale_generation';
      readonly currentSourceGeneration: HostedTaskBoardSourceGeneration;
    }
  | { readonly kind: 'stale_revision'; readonly currentRevision: Revision }
  | {
      readonly kind: 'conflict';
      readonly reason: 'idempotency_mismatch';
      readonly currentRevision?: never;
    }
  | {
      readonly kind: 'conflict';
      readonly reason: 'relationship_conflict';
      readonly currentRevision?: Revision;
    }
  | {
      readonly kind: 'conflict';
      readonly reason: 'state_conflict';
      readonly currentRevision: Revision;
    }
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unsafe_active' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

/**
 * The hosted envelope has one mutation dependency. Its implementation owns writer admission,
 * idempotency, compare-and-commit, and the durable receipt needed for safe browser recovery.
 * It must atomically compare `expectedSourceGeneration` before idempotency or revision admission so
 * replacement/restart and revision ABA return `stale_generation` without admitting the command.
 */
export interface HostedTaskMutationAdmissionPort {
  admit(
    command: HostedTaskMutationCommand,
    context: QueryContext
  ): Promise<HostedTaskMutationAdmissionResult>;
}

export interface HostedTaskBoardColumnOrder {
  readonly column: HostedTaskBoardColumn;
  readonly order: number;
}
