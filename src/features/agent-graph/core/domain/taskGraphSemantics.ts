import {
  getTeamTaskWorkflowColumn,
  isTeamTaskBlockedByUnfinishedDependency,
  isTeamTaskNeedsFixActionable,
} from '@shared/utils/teamTaskState';

import type { KanbanColumnId, KanbanTaskState, TeamTask, TeamTaskWithKanban } from '@shared/types';

type TaskColumnInput = Pick<
  TeamTaskWithKanban,
  'status' | 'reviewState' | 'kanbanColumn' | 'deletedAt'
>;
type TaskReviewerInput = Pick<TeamTaskWithKanban, 'reviewer' | 'reviewState' | 'kanbanColumn'>;
type TaskBlockInput = Pick<TeamTask, 'blockedBy'>;
type TaskBlockState = Pick<
  TeamTaskWithKanban,
  'status' | 'reviewState' | 'kanbanColumn' | 'deletedAt'
>;

export function resolveTaskGraphColumn(task: TaskColumnInput): KanbanColumnId {
  const workflowColumn = getTeamTaskWorkflowColumn(task);
  if (workflowColumn) return workflowColumn;
  if (isTeamTaskNeedsFixActionable(task)) return 'review';
  if (task.status === 'in_progress') return 'in_progress';
  if (task.status === 'completed') return 'done';
  return 'todo';
}

export function isTaskInReviewCycle(task: TaskColumnInput): boolean {
  return isTeamTaskNeedsFixActionable(task) || getTeamTaskWorkflowColumn(task) === 'review';
}

export function resolveTaskReviewer(
  task: TaskReviewerInput,
  kanbanTaskState?: Pick<KanbanTaskState, 'reviewer'>
): string | null {
  const reviewer = task.reviewer?.trim() || kanbanTaskState?.reviewer?.trim() || '';
  return reviewer.length > 0 ? reviewer : null;
}

export function isTaskBlocked(
  task: TaskBlockInput,
  taskStateById: ReadonlyMap<string, TaskBlockState>
): boolean {
  return isTeamTaskBlockedByUnfinishedDependency(task, taskStateById);
}
