import type { CommandProvider } from '../../../core/domain/models/CommandProvider';
import type { GlobalTask } from '@shared/types';

function shortTaskId(task: GlobalTask): string {
  return task.displayId ?? task.id.slice(0, 8);
}

export function createTasksProvider(tasks: readonly GlobalTask[]): CommandProvider {
  return {
    id: 'tasks',
    match: (query) => {
      if (!query.trim()) {
        return [];
      }

      return tasks
        .filter((task) => !task.teamDeleted && task.status !== 'deleted')
        .map((task, index) => {
          const ownerSuffix = task.owner ? ` - ${task.owner}` : '';
          const teamLabel = task.teamDisplayName || task.teamName;

          return {
            id: `task:${task.teamName}:${task.id}`,
            providerId: 'tasks',
            category: 'task',
            icon: 'task',
            title: task.subject || shortTaskId(task),
            subtitle: `${teamLabel}${ownerSuffix}`,
            detail: task.description,
            badge: `#${shortTaskId(task)}`,
            keywords: [
              task.id,
              task.displayId ?? '',
              task.status,
              task.owner ?? '',
              task.teamName,
              task.teamDisplayName,
              task.projectPath ?? '',
            ],
            priority: 30 - index / 100,
            dedupeKey: `task:${task.teamName}:${task.id}`,
            intent: {
              type: 'task.open',
              teamName: task.teamName,
              taskId: task.id,
            },
          };
        });
    },
  };
}
