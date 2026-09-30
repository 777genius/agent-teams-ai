import { validateTaskId, validateTeamName } from '../guards';

import type { TaskRef } from '@shared/types';

export function validateTaskRefs(
  value: unknown
): { valid: true; value: TaskRef[] | undefined } | { valid: false; error: string } {
  if (value === undefined) {
    return { valid: true, value: undefined };
  }
  if (!Array.isArray(value)) {
    return { valid: false, error: 'taskRefs must be an array' };
  }

  const taskRefs: TaskRef[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== 'object') {
      return { valid: false, error: 'taskRefs entries must be objects' };
    }
    const row = entry as Partial<TaskRef>;
    const taskId = typeof row.taskId === 'string' ? row.taskId.trim() : '';
    const displayId = typeof row.displayId === 'string' ? row.displayId.trim() : '';
    const teamName = typeof row.teamName === 'string' ? row.teamName.trim() : '';
    if (!taskId || !displayId || !teamName) {
      return { valid: false, error: 'Each taskRef must include taskId, displayId, and teamName' };
    }
    const validatedTaskId = validateTaskId(taskId);
    if (!validatedTaskId.valid) {
      return { valid: false, error: validatedTaskId.error ?? 'Invalid taskRef taskId' };
    }
    const validatedTeamName = validateTeamName(teamName);
    if (!validatedTeamName.valid) {
      return { valid: false, error: validatedTeamName.error ?? 'Invalid taskRef teamName' };
    }
    taskRefs.push({
      taskId: validatedTaskId.value!,
      displayId,
      teamName: validatedTeamName.value!,
    });
  }

  return { valid: true, value: taskRefs };
}
