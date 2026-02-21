import { KanbanColumn } from './KanbanColumn';
import { KanbanTaskCard } from './KanbanTaskCard';

import type { KanbanColumnId, KanbanState, TeamTask } from '@shared/types';

interface KanbanBoardProps {
  tasks: TeamTask[];
  kanbanState: KanbanState;
  onRequestReview: (taskId: string) => void;
  onApprove: (taskId: string) => void;
  onRequestChanges: (taskId: string) => void;
  onMoveBackToDone: (taskId: string) => void;
  onCompleteTask: (taskId: string) => void;
  onScrollToTask?: (taskId: string) => void;
}

const COLUMNS: { id: KanbanColumnId; title: string }[] = [
  { id: 'todo', title: 'TODO' },
  { id: 'in_progress', title: 'IN PROGRESS' },
  { id: 'done', title: 'DONE' },
  { id: 'review', title: 'REVIEW' },
  { id: 'approved', title: 'APPROVED' },
];

function getTaskColumn(task: TeamTask, kanbanState: KanbanState): KanbanColumnId | null {
  const explicit = kanbanState.tasks[task.id];
  if (explicit?.column) {
    return explicit.column;
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

export const KanbanBoard = ({
  tasks,
  kanbanState,
  onRequestReview,
  onApprove,
  onRequestChanges,
  onMoveBackToDone,
  onCompleteTask,
  onScrollToTask,
}: KanbanBoardProps): React.JSX.Element => {
  const taskMap = new Map(tasks.map((t) => [t.id, t]));
  const grouped = new Map<KanbanColumnId, TeamTask[]>(
    COLUMNS.map(({ id }) => [id, [] as TeamTask[]])
  );

  for (const task of tasks) {
    const column = getTaskColumn(task, kanbanState);
    if (!column) {
      continue;
    }
    grouped.get(column)?.push(task);
  }

  return (
    <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
      {COLUMNS.map((column) => {
        const columnTasks = grouped.get(column.id) ?? [];
        return (
          <KanbanColumn key={column.id} title={column.title} count={columnTasks.length}>
            {columnTasks.length === 0 ? (
              <div className="rounded-md border border-dashed border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)]">
                No tasks
              </div>
            ) : (
              columnTasks.map((task) => (
                <KanbanTaskCard
                  key={task.id}
                  task={task}
                  columnId={column.id}
                  kanbanTaskState={kanbanState.tasks[task.id]}
                  hasReviewers={kanbanState.reviewers.length > 0}
                  taskMap={taskMap}
                  onRequestReview={onRequestReview}
                  onApprove={onApprove}
                  onRequestChanges={onRequestChanges}
                  onMoveBackToDone={onMoveBackToDone}
                  onCompleteTask={onCompleteTask}
                  onScrollToTask={onScrollToTask}
                />
              ))
            )}
          </KanbanColumn>
        );
      })}
    </div>
  );
};
