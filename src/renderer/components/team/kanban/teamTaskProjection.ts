import { isTeamTaskDeleted } from '@shared/utils/teamTaskState';

import { UNASSIGNED_OWNER } from './KanbanFilterPopover';

import type { KanbanFilterState } from './KanbanFilterPopover';
import type { TeamGroupChatDTO } from '@features/team-group-chats/contracts';
import type { KanbanColumnId, KanbanState, TeamTask, TeamTaskWithKanban } from '@shared/types';

export interface TaskGroupOption {
  id: string;
  name?: string;
  archived: boolean;
  unavailable: boolean;
  count: number;
}

/** Counts the whole nondeleted catalog, before session, owner or search filters. */
export function buildTaskGroupOptions(
  tasks: readonly TeamTaskWithKanban[],
  groups: readonly TeamGroupChatDTO[],
  catalogReady: boolean,
  selectedId: string | null
): TaskGroupOption[] {
  const counts = new Map<string, number>();
  for (const task of tasks) {
    if (task.groupChatId && !isTeamTaskDeleted(task))
      counts.set(task.groupChatId, (counts.get(task.groupChatId) ?? 0) + 1);
  }
  if (selectedId && !counts.has(selectedId)) counts.set(selectedId, 0);
  return Array.from(counts, ([id, count]) => {
    const group = groups.find((item) => item.id === id);
    return {
      id,
      count,
      name: group?.name,
      archived: !!group?.archivedAt,
      unavailable: catalogReady && !group,
    };
  });
}

export function projectTeamTasks(
  tasks: readonly TeamTaskWithKanban[],
  filter: KanbanFilterState,
  timeWindow: { start: number; end: number } | null
): TeamTaskWithKanban[] {
  return tasks.filter((task) => {
    if (isTeamTaskDeleted(task)) return false;
    if (filter.groupChatId && task.groupChatId !== filter.groupChatId) return false;
    if (timeWindow && task.createdAt) {
      const timestamp = new Date(task.createdAt).getTime();
      if (!(timestamp >= timeWindow.start && timestamp < timeWindow.end)) return false;
    }
    if (filter.selectedOwners.size && !filter.selectedOwners.has(task.owner || UNASSIGNED_OWNER))
      return false;
    return true;
  });
}

export function getTaskColumn(task: TeamTask, kanbanState: KanbanState): KanbanColumnId | null {
  // Kanban state is authoritative for review/approved placement.
  // When clearKanban removes a task, the entry is deleted — so we must NOT
  // fall back to task.reviewState, otherwise the task reappears in approved/review.
  const kanbanEntry = kanbanState.tasks[task.id];
  if (kanbanEntry?.column) {
    return kanbanEntry.column;
  }

  if (task.status === 'pending') {
    return 'todo';
  }
  if (task.status === 'in_progress') {
    return 'in_progress';
  }
  if (task.status === 'completed') {
    return 'done';
  }
  return null;
}
