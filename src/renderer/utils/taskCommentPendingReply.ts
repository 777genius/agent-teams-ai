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
 * 3. If ANY responder posted a comment AFTER the user's latest comment → not awaiting.
 *    Any comment type counts as a response (regular, review_approved, review_request).
 * 4. If NO responder has replied → isAwaiting = true, awaitingFrom lists all responders.
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

  // Check if ANY responder has replied after the user's comment.
  // The indicator hides as soon as at least one responder (owner OR lead) replies.
  for (const responder of responders) {
    const hasReplied = comments.some((c) => {
      if (c.author !== responder) return false;
      const ts = Date.parse(c.createdAt);
      return Number.isFinite(ts) && ts > latestUserCommentMs;
    });
    if (hasReplied) return NO_AWAITING;
  }

  return {
    isAwaiting: true,
    awaitingFrom: Array.from(responders),
    userCommentAtMs: latestUserCommentMs,
  };
}
