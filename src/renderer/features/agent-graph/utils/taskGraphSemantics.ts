import type { KanbanColumnId, KanbanTaskState, TeamTask, TeamTaskWithKanban } from '@shared/types';

type TaskColumnInput = Pick<TeamTaskWithKanban, 'status' | 'reviewState' | 'kanbanColumn'>;
type TaskReviewerInput = Pick<TeamTaskWithKanban, 'reviewer' | 'reviewState' | 'kanbanColumn'>;
type TaskBlockInput = Pick<TeamTask, 'blockedBy'>;
type TaskBlockState = Pick<TeamTask, 'status'>;

export function resolveTaskGraphColumn(task: TaskColumnInput): KanbanColumnId {
  if (task.reviewState === 'approved') return 'approved';
  if (task.reviewState === 'review' || task.reviewState === 'needsFix') return 'review';
  if (task.kanbanColumn === 'review' || task.kanbanColumn === 'approved') {
    return task.kanbanColumn;
  }
  if (task.status === 'in_progress') return 'in_progress';
  if (task.status === 'completed') return 'done';
  return 'todo';
}

export function isTaskInReviewCycle(task: TaskColumnInput): boolean {
  return (
    task.reviewState === 'review' ||
    task.reviewState === 'needsFix' ||
    task.kanbanColumn === 'review'
  );
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
  const blockedBy = task.blockedBy?.filter((taskId) => taskId.length > 0) ?? [];
  if (blockedBy.length === 0) {
    return false;
  }

  return blockedBy.some((taskId) => {
    const blocker = taskStateById.get(taskId);
    return !blocker || (blocker.status !== 'completed' && blocker.status !== 'deleted');
  });
}
