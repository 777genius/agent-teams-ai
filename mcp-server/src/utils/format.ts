export function jsonTextContent(value: unknown): { content: { type: 'text'; text: string }[] } {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify(value, null, 2),
      },
    ],
  };
}

/**
 * Strips heavy fields (comments, historyEvents, workIntervals) from a full task
 * object to produce a lightweight summary suitable for MCP tool results of
 * write operations. This prevents context bloat — a task with 14 comments can
 * be 25 KB; the summary is < 1 KB.
 *
 * Only strip from the top-level `task` field; leave other fields intact.
 */
export function taskWriteResult(result: Record<string, unknown>): Record<string, unknown> {
  const task = result.task;
  if (task == null || typeof task !== 'object') return result;

  return { ...result, task: slimTask(task as Record<string, unknown>) };
}

/**
 * Minimal task confirmation for write operations (status changes, owner
 * assignment, comments, etc.). Uses an allowlist — only fields the caller
 * needs to verify the mutation succeeded. Agents already know what they
 * modified, so description/prompt/timestamps are unnecessary here.
 */
export function slimTask(full: Record<string, unknown>): Record<string, unknown> {
  return {
    id: full.id,
    displayId: full.displayId,
    subject: full.subject,
    status: full.status,
    owner: full.owner,
    reviewState: full.reviewState,
    needsClarification: full.needsClarification,
    blockedBy: full.blockedBy,
    blocks: full.blocks,
    commentCount: Array.isArray(full.comments) ? full.comments.length : 0,
  };
}

/**
 * Fields that grow unboundedly and dominate context usage.
 * Everything else passes through — new task fields are included by default.
 */
const HEAVY_TASK_FIELDS = new Set(['comments', 'historyEvents', 'workIntervals']);

/**
 * Lightweight task representation for task_list.
 *
 * Uses a BLOCKLIST approach: strips only known heavy array fields and replaces
 * `comments` with `commentCount`. All other fields (including any future ones)
 * pass through automatically. This avoids silently dropping new fields when
 * the task schema evolves.
 */
export function slimTaskForList(full: Record<string, unknown>): Record<string, unknown> {
  const slim: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(full)) {
    if (!HEAVY_TASK_FIELDS.has(key)) {
      slim[key] = value;
    }
  }

  if (Array.isArray(full.comments)) {
    slim.commentCount = full.comments.length;
  } else {
    slim.commentCount = 0;
  }

  return slim;
}
