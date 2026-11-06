import { projectTeamTask } from './projectTeamSnapshot';

import type { BackendDeletedTasks } from '../../../contracts/operations';

/** Trash is a separate bounded read; active snapshots never absorb retained deleted tasks. */
export function projectDeletedTasks(value: unknown): BackendDeletedTasks {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new Error('Invalid deleted tasks');
  const source = value as Record<string, unknown>;
  if (
    Buffer.byteLength(JSON.stringify(source)) > 512 * 1024 ||
    source.kind !== 'deleted-tasks' ||
    typeof source.teamName !== 'string' ||
    !source.teamName ||
    source.teamName.includes('\0') ||
    !Array.isArray(source.tasks)
  )
    throw new Error('Invalid deleted tasks');
  const teamName = source.teamName;
  const tasks = source.tasks.map((task) => projectTeamTask(task, teamName));
  if (tasks.some((task) => task.status !== 'deleted')) throw new Error('Invalid deleted task');
  return { kind: 'deleted-tasks', teamName, tasks };
}
