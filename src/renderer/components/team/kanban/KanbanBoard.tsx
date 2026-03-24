import { useCallback, useMemo, useState } from 'react';

import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useResizableColumns } from '@renderer/hooks/useResizableColumns';
import { cn } from '@renderer/lib/utils';
import {
  CheckCircle2,
  ClipboardList,
  Columns3,
  Eye,
  LayoutGrid,
  PlayCircle,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

import { KanbanColumn } from './KanbanColumn';
import { KanbanFilterPopover } from './KanbanFilterPopover';
import { KanbanGridLayout } from './KanbanGridLayout';
import { KanbanSortPopover } from './KanbanSortPopover';
import { KanbanTaskCard } from './KanbanTaskCard';

import type { KanbanFilterState } from './KanbanFilterPopover';
import type { KanbanSortField, KanbanSortState } from './KanbanSortPopover';
import type { DragEndEvent } from '@dnd-kit/core';
import type { Session } from '@renderer/types/data';
import type { KanbanColumnId, KanbanState, ResolvedTeamMember, TeamTask } from '@shared/types';

const COLUMN_ACCENTS: Record<
  KanbanColumnId,
  { headerBg: string; bodyBg: string; icon: React.ReactNode }
> = {
  todo: {
    headerBg: 'rgba(59, 130, 246, 0.15)',
    bodyBg: 'rgba(59, 130, 246, 0.015)',
    icon: <ClipboardList size={14} className="shrink-0 text-[var(--color-text-muted)]" />,
  },
  in_progress: {
    headerBg: 'rgba(234, 179, 8, 0.18)',
    bodyBg: 'rgba(234, 179, 8, 0.018)',
    icon: <PlayCircle size={14} className="shrink-0 text-[var(--color-text-muted)]" />,
  },
  done: {
    headerBg: 'rgba(34, 197, 94, 0.15)',
    bodyBg: 'rgba(34, 197, 94, 0.015)',
    icon: <CheckCircle2 size={14} className="shrink-0 text-[var(--color-text-muted)]" />,
  },
  review: {
    headerBg: 'rgba(139, 92, 246, 0.15)',
    bodyBg: 'rgba(139, 92, 246, 0.015)',
    icon: <Eye size={14} className="shrink-0 text-[var(--color-text-muted)]" />,
  },
  approved: {
    headerBg: 'rgba(34, 197, 94, 0.28)',
    bodyBg: 'rgba(34, 197, 94, 0.033)',
    icon: <ShieldCheck size={14} className="shrink-0 text-[var(--color-text-muted)]" />,
  },
};

interface KanbanBoardProps {
  tasks: TeamTask[];
  teamName: string;
  kanbanState: KanbanState;
  filter: KanbanFilterState;
  sort: KanbanSortState;
  sessions: Session[];
  leadSessionId?: string;
  members: ResolvedTeamMember[];
  onFilterChange: (filter: KanbanFilterState) => void;
  onSortChange: (sort: KanbanSortState) => void;
  onRequestReview: (taskId: string) => void;
  onApprove: (taskId: string) => void;
  onRequestChanges: (taskId: string) => void;
  onMoveBackToDone: (taskId: string) => void;
  onStartTask: (taskId: string) => void;
  onCompleteTask: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
  onScrollToTask?: (taskId: string) => void;
  onTaskClick?: (task: TeamTask) => void;
  /** Открывает diff-просмотр изменений задачи. */
  onViewChanges?: (taskId: string) => void;
  /** Вызывается после изменения порядка задач в колонке (drag-and-drop). */
  onColumnOrderChange?: (columnId: KanbanColumnId, orderedTaskIds: string[]) => void;
  /** Слот слева в одной строке с фильтром и переключателем вида (например, поле поиска). */
  toolbarLeft?: React.ReactNode;
  /** Opens the create-task dialog with pre-set startImmediately value. */
  onAddTask?: (startImmediately: boolean) => void;
  /** Soft-delete a task. */
  onDeleteTask?: (taskId: string) => void;
  /** Number of soft-deleted tasks (for trash button badge). */
  deletedTaskCount?: number;
  /** Opens the trash dialog. */
  onOpenTrash?: () => void;
}

type KanbanViewMode = 'grid' | 'columns';

const COLUMNS: { id: KanbanColumnId; title: string }[] = [
  { id: 'todo', title: 'TODO' },
  { id: 'in_progress', title: 'IN PROGRESS' },
  { id: 'review', title: 'REVIEW' },
  { id: 'done', title: 'DONE' },
  { id: 'approved', title: 'APPROVED' },
];

function getTaskColumn(task: TeamTask, kanbanState: KanbanState): KanbanColumnId | null {
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

/** Сортирует задачи по выбранному полю. */
function sortColumnTasksByField(
  columnTasks: TeamTask[],
  field: KanbanSortField,
  order?: string[]
): TeamTask[] {
  if (field === 'manual') {
    return sortColumnTasksByOrder(columnTasks, order);
  }

  return [...columnTasks].sort((a, b) => {
    if (field === 'updatedAt') {
      const tsA = a.updatedAt
        ? new Date(a.updatedAt).getTime()
        : a.createdAt
          ? new Date(a.createdAt).getTime()
          : 0;
      const tsB = b.updatedAt
        ? new Date(b.updatedAt).getTime()
        : b.createdAt
          ? new Date(b.createdAt).getTime()
          : 0;
      return tsB - tsA; // desc — свежие вверху
    }
    if (field === 'createdAt') {
      const tsA = a.createdAt ? new Date(a.createdAt).getTime() : 0;
      const tsB = b.createdAt ? new Date(b.createdAt).getTime() : 0;
      return tsB - tsA; // desc — новые вверху
    }
    if (field === 'owner') {
      const ownerA = (a.owner ?? '').toLowerCase();
      const ownerB = (b.owner ?? '').toLowerCase();
      if (!ownerA && !ownerB) return 0;
      if (!ownerA) return 1; // unassigned — в конец
      if (!ownerB) return -1;
      return ownerA.localeCompare(ownerB);
    }
    return 0;
  });
}

interface SortableKanbanTaskCardProps {
  task: TeamTask;
  columnId: KanbanColumnId;
  teamName: string;
  kanbanState: KanbanState;
  compact?: boolean;
  taskMap: Map<string, TeamTask>;
  members: ResolvedTeamMember[];
  onRequestReview: (taskId: string) => void;
  onApprove: (taskId: string) => void;
  onRequestChanges: (taskId: string) => void;
  onMoveBackToDone: (taskId: string) => void;
  onStartTask: (taskId: string) => void;
  onCompleteTask: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
  onScrollToTask?: (taskId: string) => void;
  onTaskClick?: (task: TeamTask) => void;
  onViewChanges?: (taskId: string) => void;
  onDeleteTask?: (taskId: string) => void;
}

const SortableKanbanTaskCard = ({
  task,
  columnId,
  teamName,
  kanbanState,
  compact,
  taskMap,
  members,
  onRequestReview,
  onApprove,
  onRequestChanges,
  onMoveBackToDone,
  onStartTask,
  onCompleteTask,
  onCancelTask,
  onScrollToTask,
  onTaskClick,
  onViewChanges,
  onDeleteTask,
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
        compact={compact}
        taskMap={taskMap}
        members={members}
        onRequestReview={onRequestReview}
        onApprove={onApprove}
        onRequestChanges={onRequestChanges}
        onMoveBackToDone={onMoveBackToDone}
        onStartTask={onStartTask}
        onCompleteTask={onCompleteTask}
        onCancelTask={onCancelTask}
        onScrollToTask={onScrollToTask}
        onTaskClick={onTaskClick}
        onViewChanges={onViewChanges}
        onDeleteTask={onDeleteTask}
      />
    </div>
  );
};

export const KanbanBoard = ({
  tasks,
  teamName,
  kanbanState,
  filter,
  sort,
  sessions,
  leadSessionId,
  members,
  onFilterChange,
  onSortChange,
  onRequestReview,
  onApprove,
  onRequestChanges,
  onMoveBackToDone,
  onStartTask,
  onCompleteTask,
  onCancelTask,
  onScrollToTask,
  onTaskClick,
  onViewChanges,
  onColumnOrderChange,
  toolbarLeft,
  onAddTask,
  onDeleteTask,
  deletedTaskCount,
  onOpenTrash,
}: KanbanBoardProps): React.JSX.Element => {
  const [viewMode, setViewMode] = useState<KanbanViewMode>('grid');
  const enableTaskSorting =
    viewMode === 'columns' && !!onColumnOrderChange && sort.field === 'manual';

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
      result.set(column.id, sortColumnTasksByField(columnTasks, sort.field, order));
    }
    return result;
  }, [grouped, kanbanState.columnOrder, sort.field]);

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

  const renderCards = (
    columnId: KanbanColumnId,
    columnTasks: TeamTask[],
    compact?: boolean
  ): React.JSX.Element => {
    const addHandler =
      onAddTask && columnId === 'todo'
        ? () => onAddTask(false)
        : onAddTask && columnId === 'in_progress'
          ? () => onAddTask(true)
          : undefined;

    const addButton = addHandler ? (
      <button
        type="button"
        onClick={addHandler}
        className="flex w-full items-center justify-center gap-1.5 rounded-md border border-dashed border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-emphasis)] hover:text-[var(--color-text-secondary)]"
      >
        <Plus size={13} />
        Add task
      </button>
    ) : null;

    if (columnTasks.length === 0) {
      return (
        addButton ?? (
          <div className="rounded-md border border-dashed border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)]">
            No tasks
          </div>
        )
      );
    }
    if (enableTaskSorting) {
      const itemIds = columnTasks.map((t) => t.id);
      return (
        <>
          <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
            {columnTasks.map((task) => (
              <SortableKanbanTaskCard
                key={task.id}
                task={task}
                columnId={columnId}
                teamName={teamName}
                kanbanState={kanbanState}
                compact={compact}
                taskMap={taskMap}
                members={members}
                onRequestReview={onRequestReview}
                onApprove={onApprove}
                onRequestChanges={onRequestChanges}
                onMoveBackToDone={onMoveBackToDone}
                onStartTask={onStartTask}
                onCompleteTask={onCompleteTask}
                onCancelTask={onCancelTask}
                onScrollToTask={onScrollToTask}
                onTaskClick={onTaskClick}
                onViewChanges={onViewChanges}
                onDeleteTask={onDeleteTask}
              />
            ))}
          </SortableContext>
          {addButton}
        </>
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
            compact={compact}
            taskMap={taskMap}
            members={members}
            onRequestReview={onRequestReview}
            onApprove={onApprove}
            onRequestChanges={onRequestChanges}
            onMoveBackToDone={onMoveBackToDone}
            onStartTask={onStartTask}
            onCompleteTask={onCompleteTask}
            onCancelTask={onCancelTask}
            onScrollToTask={onScrollToTask}
            onTaskClick={onTaskClick}
            onViewChanges={onViewChanges}
            onDeleteTask={onDeleteTask}
          />
        ))}
        {addButton}
      </>
    );
  };

  const visibleColumns = useMemo(
    () => (filter.columns.size > 0 ? COLUMNS.filter((c) => filter.columns.has(c.id)) : COLUMNS),
    [filter.columns]
  );

  const resizableColumnIds = useMemo(() => visibleColumns.map((c) => c.id), [visibleColumns]);
  const { widths: columnWidths, getHandleProps } = useResizableColumns({
    storageKey: teamName,
    columnIds: resizableColumnIds,
  });

  const boardContent = (
    <>
      <div className={cn('mb-2 flex items-center gap-2', toolbarLeft == null && 'justify-end')}>
        {toolbarLeft != null && <div className="min-w-0 flex-1">{toolbarLeft}</div>}
        <div className="flex shrink-0 items-center gap-2">
          <div className="inline-flex items-center rounded-md border border-[var(--color-border)]">
            <KanbanFilterPopover
              filter={filter}
              sessions={sessions}
              leadSessionId={leadSessionId}
              members={members}
              onFilterChange={onFilterChange}
            />
            <div className="h-4 w-px bg-[var(--color-border)]" />
            <KanbanSortPopover sort={sort} onSortChange={onSortChange} />
          </div>
          {deletedTaskCount != null && deletedTaskCount > 0 && onOpenTrash ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-7 px-2 text-[var(--color-text-muted)]"
                  onClick={onOpenTrash}
                >
                  <Trash2 size={14} />
                  <span className="ml-1 text-xs">{deletedTaskCount}</span>
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Trash</TooltipContent>
            </Tooltip>
          ) : null}
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
        <KanbanGridLayout
          allColumnIds={COLUMNS.map((column) => column.id)}
          columns={visibleColumns.map((column) => {
            const columnTasks = groupedOrdered.get(column.id) ?? [];
            const accent = COLUMN_ACCENTS[column.id];

            return {
              id: column.id,
              title: column.title,
              count: columnTasks.length,
              icon: accent.icon,
              headerBg: accent.headerBg,
              bodyBg: accent.bodyBg,
              content: renderCards(column.id, columnTasks),
            };
          })}
        />
      ) : (
        <div className="flex overflow-x-auto pb-2">
          {visibleColumns.map((column, index) => {
            const columnTasks = groupedOrdered.get(column.id) ?? [];
            const accent = COLUMN_ACCENTS[column.id];
            const width = columnWidths.get(column.id) ?? 256;
            const handleProps = getHandleProps(column.id);
            return (
              <div key={column.id} className="flex shrink-0">
                <div style={{ width }}>
                  <KanbanColumn
                    title={column.title}
                    count={columnTasks.length}
                    icon={accent.icon}
                    headerBg={accent.headerBg}
                    bodyBg={accent.bodyBg}
                  >
                    {renderCards(column.id, columnTasks, true)}
                  </KanbanColumn>
                </div>
                {index < visibleColumns.length - 1 ? (
                  <div
                    className="group relative mx-0.5 flex items-center"
                    onPointerDown={handleProps.onPointerDown}
                    style={handleProps.style}
                    aria-label={handleProps['aria-label']}
                  >
                    <div className="h-full w-px bg-[var(--color-border)] transition-colors group-hover:bg-blue-500/50 group-active:bg-blue-500" />
                  </div>
                ) : null}
              </div>
            );
          })}
        </div>
      )}
    </>
  );

  if (enableTaskSorting) {
    return (
      <DndContext sensors={sensors} onDragEnd={handleDragEnd}>
        {boardContent}
      </DndContext>
    );
  }

  return boardContent;
};
