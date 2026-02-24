import { useCallback, useMemo, useState } from 'react';

import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
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
import type { DragEndEvent } from '@dnd-kit/core';
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
  /** Вызывается после изменения порядка задач в колонке (drag-and-drop). */
  onColumnOrderChange?: (columnId: KanbanColumnId, orderedTaskIds: string[]) => void;
  /** Слот слева в одной строке с фильтром и переключателем вида (например, поле поиска). */
  toolbarLeft?: React.ReactNode;
  /** Opens the create-task dialog with pre-set startImmediately value. */
  onAddTask?: (startImmediately: boolean) => void;
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

/** Сортирует задачи колонки по сохранённому порядку; задачи без порядка — в конце. */
function sortColumnTasksByOrder(columnTasks: TeamTask[], order?: string[]): TeamTask[] {
  if (!order?.length) {
    return columnTasks;
  }
  const byId = new Map(columnTasks.map((t) => [t.id, t]));
  const ordered: TeamTask[] = [];
  const seen = new Set<string>();
  for (const id of order) {
    const task = byId.get(id);
    if (task) {
      ordered.push(task);
      seen.add(id);
    }
  }
  for (const task of columnTasks) {
    if (!seen.has(task.id)) {
      ordered.push(task);
    }
  }
  return ordered;
}

interface SortableKanbanTaskCardProps {
  task: TeamTask;
  columnId: KanbanColumnId;
  teamName: string;
  kanbanState: KanbanState;
  taskMap: Map<string, TeamTask>;
  members: ResolvedTeamMember[];
  onRequestReview: (taskId: string) => void;
  onApprove: (taskId: string) => void;
  onRequestChanges: (taskId: string) => void;
  onMoveBackToDone: (taskId: string) => void;
  onStartTask: (taskId: string) => void;
  onCompleteTask: (taskId: string) => void;
  onScrollToTask?: (taskId: string) => void;
  onTaskClick?: (task: TeamTask) => void;
}

const SortableKanbanTaskCard = ({
  task,
  columnId,
  teamName,
  kanbanState,
  taskMap,
  members,
  onRequestReview,
  onApprove,
  onRequestChanges,
  onMoveBackToDone,
  onStartTask,
  onCompleteTask,
  onScrollToTask,
  onTaskClick,
}: SortableKanbanTaskCardProps): React.JSX.Element => {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: task.id,
    data: { type: 'kanban-task', columnId, taskId: task.id },
  });

  const style: React.CSSProperties = {
    transform: CSS.Transform.toString(transform),
    transition,
    opacity: isDragging ? 0.5 : 1,
  };

  return (
    // eslint-disable-next-line react/jsx-props-no-spreading -- dnd-kit useSortable requires spreading attributes/listeners
    <div ref={setNodeRef} style={style} {...attributes} {...listeners}>
      <KanbanTaskCard
        task={task}
        teamName={teamName}
        columnId={columnId}
        kanbanTaskState={kanbanState.tasks[task.id]}
        hasReviewers={kanbanState.reviewers.length > 0}
        taskMap={taskMap}
        members={members}
        onRequestReview={onRequestReview}
        onApprove={onApprove}
        onRequestChanges={onRequestChanges}
        onMoveBackToDone={onMoveBackToDone}
        onStartTask={onStartTask}
        onCompleteTask={onCompleteTask}
        onScrollToTask={onScrollToTask}
        onTaskClick={onTaskClick}
      />
    </div>
  );
};

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
  onColumnOrderChange,
  toolbarLeft,
  onAddTask,
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

  const groupedOrdered = useMemo(() => {
    const result = new Map<KanbanColumnId, TeamTask[]>();
    for (const column of COLUMNS) {
      const columnTasks = grouped.get(column.id) ?? [];
      const order = kanbanState.columnOrder?.[column.id];
      result.set(column.id, sortColumnTasksByOrder(columnTasks, order));
    }
    return result;
  }, [grouped, kanbanState.columnOrder]);

  const sensors = useSensors(
    useSensor(PointerSensor, {
      activationConstraint: { distance: 8 },
    })
  );

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      const { active, over } = event;
      if (!onColumnOrderChange || !over || active.id === over.id) {
        return;
      }
      const activeData = active.data.current;
      if (activeData?.type !== 'kanban-task') {
        return;
      }
      const columnId = activeData.columnId as KanbanColumnId;
      const orderedIds = groupedOrdered.get(columnId)?.map((t) => t.id) ?? [];
      const oldIndex = orderedIds.indexOf(active.id as string);
      const newIndex = orderedIds.indexOf(over.id as string);
      if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) {
        return;
      }
      const newOrder = arrayMove(orderedIds, oldIndex, newIndex);
      onColumnOrderChange(columnId, newOrder);
    },
    [onColumnOrderChange, groupedOrdered]
  );

  const renderCards = (columnId: KanbanColumnId, columnTasks: TeamTask[]): React.JSX.Element => {
    if (columnTasks.length === 0) {
      return (
        <div className="rounded-md border border-dashed border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)]">
          No tasks
        </div>
      );
    }
    if (onColumnOrderChange) {
      const itemIds = columnTasks.map((t) => t.id);
      return (
        <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
          {columnTasks.map((task) => (
            <SortableKanbanTaskCard
              key={task.id}
              task={task}
              columnId={columnId}
              teamName={teamName}
              kanbanState={kanbanState}
              taskMap={taskMap}
              members={members}
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
        </SortableContext>
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
            members={members}
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

  const boardContent = (
    <>
      <div className={cn('mb-2 flex items-center gap-2', toolbarLeft == null && 'justify-end')}>
        {toolbarLeft != null && <div className="min-w-0 flex-1">{toolbarLeft}</div>}
        <div className="flex shrink-0 items-center gap-2">
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
      </div>

      {viewMode === 'grid' ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-5">
          {COLUMNS.map((column) => {
            const columnTasks = groupedOrdered.get(column.id) ?? [];
            const accent = COLUMN_ACCENTS[column.id];
            const addHandler =
              onAddTask && column.id === 'todo'
                ? () => onAddTask(false)
                : onAddTask && column.id === 'in_progress'
                  ? () => onAddTask(true)
                  : undefined;
            return (
              <KanbanColumn
                key={column.id}
                title={column.title}
                count={columnTasks.length}
                icon={accent.icon}
                headerBg={accent.headerBg}
                bodyBg={accent.bodyBg}
                onAddTask={addHandler}
              >
                {renderCards(column.id, columnTasks)}
              </KanbanColumn>
            );
          })}
        </div>
      ) : (
        <div className="flex gap-3 overflow-x-auto pb-2">
          {COLUMNS.map((column) => {
            const columnTasks = groupedOrdered.get(column.id) ?? [];
            const accent = COLUMN_ACCENTS[column.id];
            const addHandler =
              onAddTask && column.id === 'todo'
                ? () => onAddTask(false)
                : onAddTask && column.id === 'in_progress'
                  ? () => onAddTask(true)
                  : undefined;
            return (
              <div key={column.id} className="w-64 shrink-0">
                <KanbanColumn
                  title={column.title}
                  count={columnTasks.length}
                  icon={accent.icon}
                  headerBg={accent.headerBg}
                  bodyBg={accent.bodyBg}
                  onAddTask={addHandler}
                >
                  {renderCards(column.id, columnTasks)}
                </KanbanColumn>
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  if (onColumnOrderChange) {
    return (
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        {boardContent}
      </DndContext>
    );
  }

  return boardContent;
};
