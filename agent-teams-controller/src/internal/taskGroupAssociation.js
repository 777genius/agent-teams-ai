// Low-level synchronous policy: callers own same-team catalog admission.
const GROUP_CHAT_UUID_PATTERN =
  /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i;

function normalizeTaskGroupChatId(value) {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !GROUP_CHAT_UUID_PATTERN.test(value)) {
    throw new Error('Invalid task groupChatId: expected a group UUID');
  }
  return value;
}

function applyTaskGroupChatUpdate(task, value) {
  if (value === undefined) return;
  if (value === null) delete task.groupChatId;
  else task.groupChatId = normalizeTaskGroupChatId(value);
}

module.exports = { normalizeTaskGroupChatId, applyTaskGroupChatUpdate };
