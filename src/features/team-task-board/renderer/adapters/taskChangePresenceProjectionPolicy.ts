import {
  buildTaskChangePresenceKey,
  buildTaskChangeRequestOptions,
} from '@renderer/utils/taskChangeRequest';

import type { TeamViewSnapshot } from '@shared/types';

export interface TaskChangeInvalidation {
  cacheKeys: string[];
  taskIds: string[];
}

export function collectTaskChangeInvalidation(
  teamName: string,
  previousTasks: TeamViewSnapshot['tasks'],
  nextTasks: TeamViewSnapshot['tasks']
): TaskChangeInvalidation {
  const nextKeys = new Set(
    nextTasks.map((task) =>
      buildTaskChangePresenceKey(teamName, task.id, buildTaskChangeRequestOptions(task))
    )
  );
  const cacheKeys: string[] = [];
  const taskIds = new Set<string>();

  for (const task of previousTasks) {
    const previousKey = buildTaskChangePresenceKey(
      teamName,
      task.id,
      buildTaskChangeRequestOptions(task)
    );
    if (!nextKeys.has(previousKey)) {
      cacheKeys.push(previousKey);
      taskIds.add(task.id);
    }
  }

  return { cacheKeys, taskIds: [...taskIds] };
}

export function preserveKnownTaskChangePresence(
  teamName: string,
  previousTasks: TeamViewSnapshot['tasks'] | null | undefined,
  nextTasks: TeamViewSnapshot['tasks']
): TeamViewSnapshot['tasks'] {
  if (!Array.isArray(previousTasks) || previousTasks.length === 0 || nextTasks.length === 0) {
    return nextTasks;
  }

  const previousTaskById = new Map(previousTasks.map((task) => [task.id, task]));
  let changed = false;

  const mergedTasks = nextTasks.map((task) => {
    if (task.changePresence && task.changePresence !== 'unknown') {
      return task;
    }

    const previousTask = previousTaskById.get(task.id);
    if (!previousTask?.changePresence || previousTask.changePresence === 'unknown') {
      return task;
    }

    const previousKey = buildTaskChangePresenceKey(
      teamName,
      previousTask.id,
      buildTaskChangeRequestOptions(previousTask)
    );
    const nextKey = buildTaskChangePresenceKey(
      teamName,
      task.id,
      buildTaskChangeRequestOptions(task)
    );
    if (previousKey !== nextKey) {
      return task;
    }

    changed = true;
    return { ...task, changePresence: previousTask.changePresence };
  });

  return changed ? mergedTasks : nextTasks;
}
