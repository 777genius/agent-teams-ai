import { useMemo, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import {
  CheckCircle2,
  ClipboardList,
  Columns3,
  Eye,
  LayoutGrid,
  PlayCircle,
  ShieldCheck,
} from 'lucide-react';

import { KanbanColumn } from './KanbanColumn';
import { KanbanFilterPopover } from './KanbanFilterPopover';
import { KanbanTaskCard } from './KanbanTaskCard';

import type { KanbanFilterState } from './KanbanFilterPopover';
import type { Session } from '@renderer/types/data';
import type { KanbanColumnId, KanbanState, ResolvedTeamMember, TeamTask } from '@shared/types';

const COLUMN_ACCENTS: Record<
  KanbanColumnId,
  { headerBg: string; bodyBg: string; icon: React.ReactNode }
> = {
  todo: {
    headerBg: 'rgba(59, 130, 246, 0.12)',
    bodyBg: 'rgba(59, 130, 246, 0.05)',
    icon: <ClipboardList size={14} className="shrink-0 text-[var(--color-text-muted)]" />,
  },
  in_progress: {
    headerBg: 'rgba(234, 179, 8, 0.14)',
    bodyBg: 'rgba(234, 179, 8, 0.06)',
    icon: <PlayCircle size={14} className="shrink-0 text-[var(--color-text-muted)]" />,
  },
  done: {
    headerBg: 'rgba(34, 197, 94, 0.12)',
    bodyBg: 'rgba(34, 197, 94, 0.05)',
    icon: <CheckCircle2 size={14} className="shrink-0 text-[var(--color-text-muted)]" />,
  },
  review: {
    headerBg: 'rgba(139, 92, 246, 0.12)',
    bodyBg: 'rgba(139, 92, 246, 0.05)',
    icon: <Eye size={14} className="shrink-0 text-[var(--color-text-muted)]" />,
  },
  approved: {
    headerBg: 'rgba(34, 197, 94, 0.24)',
    bodyBg: 'rgba(34, 197, 94, 0.11)',
    icon: <ShieldCheck size={14} className="shrink-0 text-[var(--color-text-muted)]" />,
  },
};

interface KanbanBoardProps {
  tasks: TeamTask[];
  teamName: string;
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
  teamName,
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
            teamName={teamName}
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
          <Tooltip>
            <TooltipTrigger asChild>
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
              >
                <LayoutGrid size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Grid view</TooltipContent>
          </Tooltip>
          <Tooltip>
            <TooltipTrigger asChild>
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
              >
                <Columns3 size={14} />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Columns view</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {viewMode === 'grid' ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
          {COLUMNS.map((column) => {
            const columnTasks = grouped.get(column.id) ?? [];
            const accent = COLUMN_ACCENTS[column.id];
            return (
              <KanbanColumn
                key={column.id}
                title={column.title}
                count={columnTasks.length}
                icon={accent.icon}
                headerBg={accent.headerBg}
                bodyBg={accent.bodyBg}
              >
                {renderCards(column.id, columnTasks)}
              </KanbanColumn>
            );
          })}
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {COLUMNS.map((column) => {
            const columnTasks = grouped.get(column.id) ?? [];
            const accent = COLUMN_ACCENTS[column.id];
            return (
              <div key={column.id} className="w-64 shrink-0">
                <KanbanColumn
                  title={column.title}
                  count={columnTasks.length}
                  icon={accent.icon}
                  headerBg={accent.headerBg}
                  bodyBg={accent.bodyBg}
                >
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
