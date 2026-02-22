import { useMemo, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';
import { Columns3, LayoutGrid } from 'lucide-react';

import { KanbanColumn } from './KanbanColumn';
import { KanbanFilterPopover } from './KanbanFilterPopover';
import { KanbanTaskCard } from './KanbanTaskCard';

import type { KanbanFilterState } from './KanbanFilterPopover';
import type { Session } from '@renderer/types/data';
import type { KanbanColumnId, KanbanState, ResolvedTeamMember, TeamTask } from '@shared/types';

interface KanbanBoardProps {
  tasks: TeamTask[];
  kanbanState: KanbanState;
  filter: KanbanFilterState;
  sessions: Session[];
  leadSessionId?: string;
  members: ResolvedTeamMember[];
  onFilterChange: (filter: KanbanFilterState) => void;
  onRequestReview: (taskId: string) => void;
  onApprove: (taskId: string) => void;
  onRequestChanges: (taskId: string) => void;
  onMoveBackToDone: (taskId: string) => void;
  onStartTask: (taskId: string) => void;
  onCompleteTask: (taskId: string) => void;
  onScrollToTask?: (taskId: string) => void;
  onTaskClick?: (task: TeamTask) => void;
}

type KanbanViewMode = 'grid' | 'columns';

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
  filter,
  sessions,
  leadSessionId,
  members,
  onFilterChange,
  onRequestReview,
  onApprove,
  onRequestChanges,
  onMoveBackToDone,
  onStartTask,
  onCompleteTask,
  onScrollToTask,
  onTaskClick,
}: KanbanBoardProps): React.JSX.Element => {
  const [viewMode, setViewMode] = useState<KanbanViewMode>('grid');

  const taskMap = useMemo(() => new Map(tasks.map((t) => [t.id, t])), [tasks]);
  const grouped = useMemo(() => {
    const result = new Map<KanbanColumnId, TeamTask[]>(
      COLUMNS.map(({ id }) => [id, [] as TeamTask[]])
    );
    for (const task of tasks) {
      const column = getTaskColumn(task, kanbanState);
      if (!column) {
        continue;
      }
      result.get(column)?.push(task);
    }
    return result;
  }, [tasks, kanbanState]);

  const renderCards = (columnId: KanbanColumnId, columnTasks: TeamTask[]): React.JSX.Element => {
    if (columnTasks.length === 0) {
      return (
        <div className="rounded-md border border-dashed border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)]">
          No tasks
        </div>
      );
    }
    return (
      <>
        {columnTasks.map((task) => (
          <KanbanTaskCard
            key={task.id}
            task={task}
            columnId={columnId}
            kanbanTaskState={kanbanState.tasks[task.id]}
            hasReviewers={kanbanState.reviewers.length > 0}
            taskMap={taskMap}
            onRequestReview={onRequestReview}
            onApprove={onApprove}
            onRequestChanges={onRequestChanges}
            onMoveBackToDone={onMoveBackToDone}
            onStartTask={onStartTask}
            onCompleteTask={onCompleteTask}
            onScrollToTask={onScrollToTask}
            onTaskClick={onTaskClick}
          />
        ))}
      </>
    );
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-end gap-2">
        <KanbanFilterPopover
          filter={filter}
          sessions={sessions}
          leadSessionId={leadSessionId}
          members={members}
          onFilterChange={onFilterChange}
        />
        <div className="inline-flex rounded-md border border-[var(--color-border)]">
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-7 rounded-r-none px-2',
              viewMode === 'grid'
                ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)]'
                : 'text-[var(--color-text-muted)]'
            )}
            onClick={() => setViewMode('grid')}
            aria-label="Grid view"
            title="Grid"
          >
            <LayoutGrid size={14} />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              'h-7 rounded-l-none border-l border-[var(--color-border)] px-2',
              viewMode === 'columns'
                ? 'bg-[var(--color-surface-raised)] text-[var(--color-text)]'
                : 'text-[var(--color-text-muted)]'
            )}
            onClick={() => setViewMode('columns')}
            aria-label="Columns view"
            title="Columns"
          >
            <Columns3 size={14} />
          </Button>
        </div>
      </div>

      {viewMode === 'grid' ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
          {COLUMNS.map((column) => {
            const columnTasks = grouped.get(column.id) ?? [];
            return (
              <KanbanColumn key={column.id} title={column.title} count={columnTasks.length}>
                {renderCards(column.id, columnTasks)}
              </KanbanColumn>
            );
          })}
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {COLUMNS.map((column) => {
            const columnTasks = grouped.get(column.id) ?? [];
            return (
              <div key={column.id} className="w-64 shrink-0">
                <KanbanColumn title={column.title} count={columnTasks.length}>
                  {renderCards(column.id, columnTasks)}
                </KanbanColumn>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
