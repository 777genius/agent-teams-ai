import {
  buildTaskChangePresenceKey,
  buildTaskChangeRequestOptions,
} from '@renderer/utils/taskChangeRequest';

import type { TeamViewSnapshot } from '@shared/types';

export function collectTaskChangeInvalidationState(
  teamName: string,
  prevTasks: TeamViewSnapshot['tasks'],
  nextTasks: TeamViewSnapshot['tasks']
): { cacheKeys: string[]; taskIds: string[] } {
  const nextKeys = new Set(
    nextTasks.map((task) =>
      buildTaskChangePresenceKey(teamName, task.id, buildTaskChangeRequestOptions(task))
    )
  );
  const invalidationKeys: string[] = [];
  const invalidationTaskIds = new Set<string>();
  for (const task of prevTasks) {
    const previousKey = buildTaskChangePresenceKey(
      teamName,
      task.id,
      buildTaskChangeRequestOptions(task)
    );
    if (!nextKeys.has(previousKey)) {
      invalidationKeys.push(previousKey);
      invalidationTaskIds.add(task.id);
    }
  }
  return {
    cacheKeys: invalidationKeys,
    taskIds: [...invalidationTaskIds],
  };
}

export function preserveKnownTaskChangePresence(
  teamName: string,
  prevTasks: TeamViewSnapshot['tasks'] | null | undefined,
  nextTasks: TeamViewSnapshot['tasks']
): TeamViewSnapshot['tasks'] {
  if (!Array.isArray(prevTasks) || prevTasks.length === 0 || nextTasks.length === 0) {
    return nextTasks;
  }

  const prevTaskById = new Map(prevTasks.map((task) => [task.id, task]));
  let changed = false;

  const mergedTasks = nextTasks.map((task) => {
    if (task.changePresence && task.changePresence !== 'unknown') {
      return task;
    }

    const previousTask = prevTaskById.get(task.id);
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
    return {
      ...task,
      changePresence: previousTask.changePresence,
    };
  });

  return changed ? mergedTasks : nextTasks;
}
