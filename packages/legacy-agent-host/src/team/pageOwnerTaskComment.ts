import { TeamOwnerError } from './contracts.js';
import { pageOwnerReadDetail } from './pageOwnerTaskDetail.js';
import { json } from './TeamReviewCommands.js';

import type { JsonValue } from '../contracts.js';
import type { TeamGrant } from './contracts.js';

/** The canonical controller has already resolved short Task/comment references.
 * Sign those resolved identities and preserve the complete comment and context.
 */
export function pageOwnerTaskComment(options: {
  principalId: string;
  grant: TeamGrant;
  key: string;
  teamName: string;
  value: unknown;
  cursor?: string;
}): JsonValue {
  const source = json(options.value);
  const row = (value: JsonValue | undefined): Record<string, JsonValue> => {
    if (!value || typeof value !== 'object' || Array.isArray(value))
      throw new TeamOwnerError('hold');
    return value;
  };
  const result = row(source);
  const taskId = row(result.task).id;
  const commentId = row(result.comment).id;
  if (typeof taskId !== 'string' || !taskId || typeof commentId !== 'string' || !commentId)
    throw new TeamOwnerError('hold');
  return pageOwnerReadDetail({
    ...options, value: source,
    taskId, commentId,
  });
}
