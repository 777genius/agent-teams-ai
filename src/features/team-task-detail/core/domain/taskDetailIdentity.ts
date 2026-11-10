import type { TaskDetailIdentity } from '../../contracts';

export function normalizeTaskDetailIdentity(input: TaskDetailIdentity): TaskDetailIdentity {
  return {
    contextId: input.contextId.trim(),
    teamName: input.teamName.trim(),
    taskId: input.taskId.trim(),
  };
}

export function isValidTaskDetailIdentity(input: TaskDetailIdentity): boolean {
  const identity = normalizeTaskDetailIdentity(input);
  return (
    identity.contextId.length > 0 && identity.teamName.length > 0 && identity.taskId.length > 0
  );
}

export function taskDetailKey(input: TaskDetailIdentity): string {
  const identity = normalizeTaskDetailIdentity(input);
  return JSON.stringify([identity.contextId, identity.teamName, identity.taskId]);
}

export function isSameTaskDetailIdentity(
  left: TaskDetailIdentity,
  right: TaskDetailIdentity
): boolean {
  return taskDetailKey(left) === taskDetailKey(right);
}
