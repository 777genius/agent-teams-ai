import { taskTextSignals } from '../controller';

/**
 * A task comment never changes board status. When the OWNER posts a
 * completion-shaped comment on their own in_progress task, the next tool call
 * must be task_complete — a memoryless model routinely treats the comment as
 * the deliverable and ends the turn, leaving the board open (the board
 * completion notice to the lead only fires from completeTask). This rides back
 * on the tool result the model is already reading mid-turn: no inbox rows, no
 * extra runtime turns, no dedup state. Mirrors message_send's
 * protocolInstruction.
 */
export function buildCommentCompletionInstruction(
  payload: Record<string, unknown>
): string | undefined {
  const task = payload.task as Record<string, unknown> | undefined;
  const comment = payload.comment as Record<string, unknown> | undefined;
  if (!task || !comment || task.status !== 'in_progress') return undefined;
  const owner = typeof task.owner === 'string' ? task.owner.trim().toLowerCase() : '';
  const author = typeof comment.author === 'string' ? comment.author.trim().toLowerCase() : '';
  if (!owner || owner !== author) return undefined;
  if (typeof comment.text !== 'string') return undefined;
  if (!taskTextSignals.isTaskCompletionClaimText(comment.text)) return undefined;
  const label =
    typeof task.displayId === 'string' && task.displayId ? task.displayId : String(task.id ?? '');
  return `Comment saved, but task #${label} is still in_progress — a comment does not change board status. If that work is finished, call task_complete { teamName, taskId, actor } NOW, before you end this turn. If it is not finished, keep working.`;
}
