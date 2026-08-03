import type {
  HostedTaskBoardDegradedReason,
  HostedTaskBoardItem,
  HostedTaskBoardSourceGeneration,
  HostedTaskBoardTruncationReason,
} from '../../contracts/hosted';
import type { TaskId } from '../../contracts/hosted';
import type { QueryContext, Revision, TeamId } from '@shared/contracts/hosted';

export interface HostedTaskBoardAuthorityReadWindowRequest {
  readonly teamId: TeamId;
  readonly afterTaskId: TaskId | null;
  readonly expectedSourceGeneration: HostedTaskBoardSourceGeneration | null;
  readonly itemLimit: number;
  readonly byteLimit: number;
  readonly deadlineAtMs: number;
}

export type HostedTaskBoardAuthorityReadWindowResult =
  | {
      readonly kind: 'found';
      readonly teamId: TeamId;
      readonly sourceGeneration: HostedTaskBoardSourceGeneration;
      readonly revision: Revision;
      /** Items are already in canonical authority continuation order. */
      readonly items: readonly HostedTaskBoardItem[];
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

/**
 * The hosted read authority owns one generation-bound task-board observation.
 *
 * `readWindow` revalidates the QueryContext's live grant in the same authority observation that
 * selects the team generation and ordered window. Implementations compare a continuation's source
 * generation before reading candidates so source replacement cannot disclose an unrelated window.
 *
 * The exact QueryContext supplied by the caller participates in the operation. This read-only port
 * deliberately exposes no mutation, process, provider, terminal, path, or lifecycle capability.
 */
export interface HostedTaskBoardAuthorityPort {
  readWindow(
    request: HostedTaskBoardAuthorityReadWindowRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityReadWindowResult>;
}
