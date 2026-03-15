import type { TaskComment } from '@shared/types';

export interface AwaitingReplyResult {
  /** Whether the user is awaiting a reply from task responders. */
  isAwaiting: boolean;
  /** Names of responders who haven't replied yet. */
  awaitingFrom: string[];
  /** Timestamp (ms) of the last user comment that triggered the awaiting state. */
  userCommentAtMs: number;
}

const NO_AWAITING: AwaitingReplyResult = {
  isAwaiting: false,
  awaitingFrom: [],
  userCommentAtMs: 0,
};

/**
 * Determines whether the human user is awaiting a reply on task comments.
 *
 * Logic:
 * 1. Find the latest comment authored by "user".
 * 2. Collect the set of expected responders (task owner + task creator), deduplicated.
 * 3. For each responder, check if they posted a comment AFTER the user's latest comment.
 *    Any comment type counts as a response (regular, review_approved, review_request).
 * 4. If at least one responder has NOT replied → isAwaiting = true.
 *
 * Edge cases:
 * - No user comments → not awaiting.
 * - owner/createdBy are undefined or empty → not awaiting (no one to wait for).
 * - owner === createdBy → single responder.
 * - User posted multiple comments in a row → still awaiting (based on latest user comment).
 */
export function computeAwaitingReply(
  comments: TaskComment[] | undefined,
  taskOwner: string | undefined,
  taskCreatedBy: string | undefined
): AwaitingReplyResult {
  if (!comments || comments.length === 0) return NO_AWAITING;

  // Build responder set (deduplicated, non-empty, non-"user")
  const responders = new Set<string>();
  if (taskOwner && taskOwner !== 'user') responders.add(taskOwner);
  if (taskCreatedBy && taskCreatedBy !== 'user') responders.add(taskCreatedBy);
  if (responders.size === 0) return NO_AWAITING;

  // Find the latest "user" comment by createdAt
  let latestUserCommentMs = 0;
  for (const comment of comments) {
    if (comment.author !== 'user') continue;
    const ts = Date.parse(comment.createdAt);
    if (Number.isFinite(ts) && ts > latestUserCommentMs) {
      latestUserCommentMs = ts;
    }
  }
  if (latestUserCommentMs === 0) return NO_AWAITING;

  // Check which responders have NOT replied after the user's comment
  const awaitingFrom: string[] = [];
  for (const responder of responders) {
    const hasReplied = comments.some((c) => {
      if (c.author !== responder) return false;
      const ts = Date.parse(c.createdAt);
      return Number.isFinite(ts) && ts > latestUserCommentMs;
    });
    if (!hasReplied) {
      awaitingFrom.push(responder);
    }
  }

  if (awaitingFrom.length === 0) return NO_AWAITING;

  return {
    isAwaiting: true,
    awaitingFrom,
    userCommentAtMs: latestUserCommentMs,
  };
}
