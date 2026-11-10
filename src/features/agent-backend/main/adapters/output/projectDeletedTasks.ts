import { projectTaskParts, projectTeamTask } from './projectTeamSnapshot';

import type { BackendDeletedTasks } from '../../../contracts/operations';

/** Trash has its own bounded Owner pages; no private task fields leave Main. */
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

  const revision = source.revision;
  if (revision !== undefined &&
      (typeof revision !== 'string' || !/^[a-f0-9]{64}$/.test(revision)))
    throw new Error('Invalid deleted task revision');
  const nextCursor = source.nextCursor;
  if (nextCursor !== undefined && nextCursor !== null &&
      (typeof nextCursor !== 'string' ||
       !/^[1-9][0-9]{0,8}\.[a-f0-9]{64}$/.test(nextCursor)))
    throw new Error('Invalid deleted task continuation');
  if ((nextCursor !== undefined || source.taskParts !== undefined) &&
      revision === undefined)
    throw new Error('Missing deleted task revision');

  const teamName = source.teamName;
  const tasks = source.tasks.map((task) => projectTeamTask(task, teamName));
  if (tasks.some((task) => task.status !== 'deleted')) throw new Error('Invalid deleted task');
  return {
    kind: 'deleted-tasks',
    teamName,
    tasks,
    ...(revision === undefined ? {} : { revision }),
    ...(nextCursor === undefined ? {} : { nextCursor }),
    ...projectTaskParts(source),
  };
}
