import { isDeepStrictEqual } from 'node:util';

// Closed schema names only: never copy task text, arbitrary metadata keys or values.
const FIELDS = ['id', 'displayId', 'subject', 'description', 'descriptionTaskRefs', 'groupChatId',
  'activeForm', 'prompt', 'promptTaskRefs', 'owner', 'createdBy', 'status', 'workIntervals',
  'reviewIntervals', 'historyEvents', 'blocks', 'blockedBy', 'related', 'createdAt', 'updatedAt',
  'projectPath', 'comments', 'needsClarification', 'deletedAt', 'attachments', 'reviewState',
  'sourceMessageId', 'sourceMessage'] as const;

export function projectTaskPersistenceDifference(before: Record<string, unknown>, after: Record<string, unknown>) {
  const changed = [...new Set([...Object.keys(before), ...Object.keys(after)])]
    .filter(key => !isDeepStrictEqual(before[key], after[key]));
  return {
    changedFields: FIELDS.filter(key => changed.includes(key)),
    otherChangedFieldCount: changed.filter(key => !FIELDS.some(field => field === key)).length,
    commentCountBefore: Array.isArray(before.comments) ? before.comments.length : 0,
    commentCountAfter: Array.isArray(after.comments) ? after.comments.length : 0,
  };
}
