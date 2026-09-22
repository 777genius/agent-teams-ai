import type {
  HostedTaskBoardDegradedReason,
  HostedTaskBoardItem,
  HostedTaskBoardSourceGeneration,
  HostedTaskBoardTruncationReason,
  HostedTaskMutationCommand,
  HostedTaskMutationCommittedReceipt,
  HostedTaskMutationReplayReceipt,
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
 * The fingerprint is a SHA-256 digest of the complete canonical command payload. It lets the
 * atomic authority reject reuse of an idempotency key for a different browser command without
 * retaining the command's user-visible fields in its replay ledger.
 */
export interface HostedTaskBoardAuthorityMutationRequest {
  readonly command: HostedTaskMutationCommand;
  readonly payloadFingerprint: string;
}

interface HostedTaskBoardAuthorityGenerationCheckedMutationResult {
  /** The generation observed in the same transaction as the idempotency ledger and write. */
  readonly currentSourceGeneration: HostedTaskBoardSourceGeneration;
}

/**
 * This is deliberately narrower than the application admission result. The adapter consumes the
 * authority-only generation and fingerprint evidence before exposing a safe application result.
 */
export type HostedTaskBoardAuthorityMutationResult =
  | ({
      readonly kind: 'committed';
      readonly payloadFingerprint: string;
      readonly receipt: HostedTaskMutationCommittedReceipt;
    } & HostedTaskBoardAuthorityGenerationCheckedMutationResult)
  | ({
      readonly kind: 'idempotent_replay';
      readonly payloadFingerprint: string;
      readonly receipt: HostedTaskMutationReplayReceipt;
    } & HostedTaskBoardAuthorityGenerationCheckedMutationResult)
  | ({
      readonly kind: 'stale_generation';
    } & HostedTaskBoardAuthorityGenerationCheckedMutationResult)
  | ({
      readonly kind: 'stale_revision';
      readonly currentRevision: Revision;
    } & HostedTaskBoardAuthorityGenerationCheckedMutationResult)
  | ({
      readonly kind: 'conflict';
      readonly reason: 'idempotency_mismatch';
    } & HostedTaskBoardAuthorityGenerationCheckedMutationResult)
  | ({
      readonly kind: 'conflict';
      readonly reason: 'relationship_conflict';
      readonly currentRevision?: Revision;
    } & HostedTaskBoardAuthorityGenerationCheckedMutationResult)
  | ({
      readonly kind: 'conflict';
      readonly reason: 'state_conflict';
      readonly currentRevision: Revision;
    } & HostedTaskBoardAuthorityGenerationCheckedMutationResult)
  | { readonly kind: 'not_found' }
  | { readonly kind: 'unsafe_active' }
  | { readonly kind: 'unavailable'; readonly retryAfterMs?: number };

/**
 * The hosted read authority owns one generation-bound task-board observation.
 *
 * `readWindow` revalidates the QueryContext's live grant in the same authority observation that
 * selects the team generation and ordered window. Implementations compare a continuation's source
 * generation before reading candidates so source replacement cannot disclose an unrelated window.
 *
 * The exact QueryContext supplied by the caller participates in the operation. Its read surface
 * exposes no process, provider, terminal, path, or lifecycle capability.
 */
export interface HostedTaskBoardAuthorityPort {
  readWindow(
    request: HostedTaskBoardAuthorityReadWindowRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityReadWindowResult>;

  /**
   * Optional until a host composes the Core v1 mutation authority. Keeping this capability optional
   * leaves the existing read-only hosted composition unadvertised rather than exposing a route that
   * cannot safely commit. When present, one host-owned transaction revalidates the live grant,
   * compares source generation first, reads the generation-scoped replay ledger, compares the
   * supplied payload fingerprint, checks the expected revision, commits the local write, and
   * persists the receipt before returning. A generation mismatch wins before idempotency or revision
   * handling so source replacement and revision ABA cannot replay an older command.
   */
  admitTaskMutation?(
    request: HostedTaskBoardAuthorityMutationRequest,
    context: QueryContext
  ): Promise<HostedTaskBoardAuthorityMutationResult>;
}
