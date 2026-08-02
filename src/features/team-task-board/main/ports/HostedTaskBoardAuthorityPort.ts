import type {
  HostedTaskBoardDegradedReason,
  HostedTaskBoardItem,
  HostedTaskBoardSourceGeneration,
  HostedTaskBoardTruncationReason,
  HostedTaskMutationCommand,
} from '../../contracts/hosted';
import type { TaskId } from '../../contracts/hosted';
import type { HostedTaskMutationAdmissionResult } from '../../core/application/ports/HostedTeamTaskBoardPorts';
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

export type HostedTaskBoardAuthorityCompareAndCommitResult = HostedTaskMutationAdmissionResult;

/**
 * The production authority is the only owner of task-board read and mutation admission.
 *
 * `readWindow` revalidates the QueryContext's live grant in the same authority observation that
 * selects the team generation and ordered window. `compareAndCommit` performs one serialized
 * transaction: live-grant admission, generation comparison, idempotency/body comparison, revision
 * comparison, the task mutation (including both endpoints of a relationship), and durable receipt
 * publication. Generation comparison precedes idempotency and revision lookup so a replaced source
 * cannot disclose or replay an earlier generation's command.
 *
 * Implementations must not split either operation into an authorization check followed by a later
 * read or write. The exact QueryContext supplied by the caller participates in each operation.
 */
export interface HostedTaskBoardAuthorityPort {
  readWindow(
    request: HostedTaskBoardAuthorityReadWindowRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityReadWindowResult>;

  compareAndCommit(
    command: HostedTaskMutationCommand,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityCompareAndCommitResult>;
}
