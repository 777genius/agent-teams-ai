import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useResizableColumns } from '@renderer/hooks/useResizableColumns';
import { cn } from '@renderer/lib/utils';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
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
import {
  KanbanGridLayout,
  SKELETON_HIDE_DELAY_MS,
  SKELETON_HIDE_DELAY_MS_ON_MODE_SWITCH,
} from './KanbanGridLayout';
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
    headerBg: 'rgba(59, 130, 246, 0.22)',
    bodyBg: 'rgba(59, 130, 246, 0.05)',
    icon: <ClipboardList size={14} className="shrink-0 text-[var(--color-text-muted)]" />,
  },
  in_progress: {
    headerBg: 'rgba(234, 179, 8, 0.24)',
    bodyBg: 'rgba(234, 179, 8, 0.06)',
    icon: <PlayCircle size={14} className="shrink-0 text-[var(--color-text-muted)]" />,
  },
  done: {
    headerBg: 'rgba(34, 197, 94, 0.22)',
    bodyBg: 'rgba(34, 197, 94, 0.05)',
    icon: <CheckCircle2 size={14} className="shrink-0 text-[var(--color-text-muted)]" />,
  },
  review: {
    headerBg: 'rgba(139, 92, 246, 0.22)',
    bodyBg: 'rgba(139, 92, 246, 0.05)',
    icon: <Eye size={14} className="shrink-0 text-[var(--color-text-muted)]" />,
  },
  approved: {
    headerBg: 'rgba(34, 197, 94, 0.34)',
    bodyBg: 'rgba(34, 197, 94, 0.08)',
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

const SCROLLABLE_OVERFLOW_VALUES = new Set(['auto', 'scroll', 'overlay']);

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

function columnSupportsAddButton(
  columnId: KanbanColumnId,
  onAddTask?: (startImmediately: boolean) => void
): boolean {
  return Boolean(onAddTask && (columnId === 'todo' || columnId === 'in_progress'));
}

function estimateGridSkeletonCardHeight(
  task: TeamTask,
  columnId: KanbanColumnId,
  kanbanState: KanbanState,
  hasReviewers: boolean
): number {
  let height = 122;

  if (task.subject.length > 54) height += 10;
  if (task.subject.length > 92) height += 8;
  if (task.needsClarification) height += 16;
  if (task.reviewState === 'needsFix') height += 14;
  if ((task.blockedBy?.length ?? 0) > 0) height += 18;
  if ((task.blocks?.length ?? 0) > 0) height += 18;

  const effectiveReviewer = (kanbanState.tasks[task.id]?.reviewer ?? '').trim();
  if (columnId === 'review' && !hasReviewers && effectiveReviewer.length === 0) {
    height += 14;
  }

  return Math.min(Math.max(height, 116), 196);
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
  memberColorMap: Map<string, string>;
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
  memberColorMap,
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
        memberColorMap={memberColorMap}
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
  const boardRef = useRef<HTMLDivElement>(null);
  const scrollRestoreTimeoutsRef = useRef<number[]>([]);
  const [viewMode, setViewMode] = useState<KanbanViewMode>('grid');
  const [gridPrimaryColumnWidth, setGridPrimaryColumnWidth] = useState<number | null>(null);
  const [gridSkeletonDelayMs, setGridSkeletonDelayMs] = useState(SKELETON_HIDE_DELAY_MS);
  const hasReviewers = kanbanState.reviewers.length > 0;
  const enableTaskSorting =
    viewMode === 'columns' && !!onColumnOrderChange && sort.field === 'manual';

  const stableTaskMapRef = useRef<{
    signatures: string[];
    map: Map<string, TeamTask>;
  } | null>(null);
  const taskMap = useMemo(() => {
    const signatures = tasks.map(
      (task) => `${task.id}\0${task.displayId ?? ''}\0${task.subject}\0${task.status}`
    );
    const previous = stableTaskMapRef.current;
    if (
      previous?.signatures.length === signatures.length &&
      previous.signatures.every((signature, index) => signature === signatures[index])
    ) {
      return previous.map;
    }

    const next = new Map(tasks.map((task) => [task.id, task]));
    stableTaskMapRef.current = { signatures, map: next };
    return next;
  }, [tasks]);
  const memberColorMap = useMemo(() => buildMemberColorMap(members), [members]);
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
                memberColorMap={memberColorMap}
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
            hasReviewers={hasReviewers}
            compact={compact}
            taskMap={taskMap}
            memberColorMap={memberColorMap}
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
  const primaryVisibleColumnId = visibleColumns[0]?.id ?? null;

  const resizableColumnIds = useMemo(() => visibleColumns.map((c) => c.id), [visibleColumns]);
  const { widths: columnWidths, getHandleProps } = useResizableColumns({
    storageKey: teamName,
    columnIds: resizableColumnIds,
  });
  const columnModeSearchWidth =
    primaryVisibleColumnId != null ? (columnWidths.get(primaryVisibleColumnId) ?? 256) : 256;
  const toolbarLeftWidth =
    viewMode === 'grid' ? (gridPrimaryColumnWidth ?? columnModeSearchWidth) : columnModeSearchWidth;

  const clearScheduledScrollRestore = useCallback(() => {
    for (const timeoutId of scrollRestoreTimeoutsRef.current) {
      window.clearTimeout(timeoutId);
    }
    scrollRestoreTimeoutsRef.current = [];
  }, []);

  useEffect(() => clearScheduledScrollRestore, [clearScheduledScrollRestore]);

  const findScrollContainer = useCallback((startNode: HTMLElement | null): HTMLElement | null => {
    let current = startNode?.parentElement ?? null;
    while (current) {
      const { overflowY } = window.getComputedStyle(current);
      if (SCROLLABLE_OVERFLOW_VALUES.has(overflowY)) {
        return current;
      }
      current = current.parentElement;
    }
    return null;
  }, []);

  const scheduleScrollRestore = useCallback(
    (nextViewMode: KanbanViewMode, skeletonDelayMs: number) => {
      const container = findScrollContainer(boardRef.current);
      if (!container) {
        return;
      }

      const savedScrollTop = container.scrollTop;
      clearScheduledScrollRestore();

      const restore = (): void => {
        container.scrollTop = savedScrollTop;
      };

      const delays =
        nextViewMode === 'grid' ? [skeletonDelayMs + 40, skeletonDelayMs + 220] : [120];

      scrollRestoreTimeoutsRef.current = delays.map((delay) => window.setTimeout(restore, delay));
    },
    [clearScheduledScrollRestore, findScrollContainer]
  );

  const switchViewMode = useCallback(
    (nextViewMode: KanbanViewMode) => {
      const nextSkeletonDelayMs =
        nextViewMode === 'grid' && viewMode === 'columns'
          ? SKELETON_HIDE_DELAY_MS_ON_MODE_SWITCH
          : SKELETON_HIDE_DELAY_MS;

      setGridSkeletonDelayMs(nextSkeletonDelayMs);
      scheduleScrollRestore(nextViewMode, nextSkeletonDelayMs);
      setViewMode(nextViewMode);
    },
    [scheduleScrollRestore, viewMode]
  );

  const boardContent = (
    <div ref={boardRef} className="min-w-0 max-w-full overflow-x-hidden">
      <div
        className={cn(
          'flex min-w-0 max-w-full items-center gap-2',
          viewMode === 'columns' ? 'mb-0' : 'mb-2',
          toolbarLeft == null && 'justify-end'
        )}
      >
        {toolbarLeft != null && (
          <div className="min-w-0 max-w-full" style={{ width: toolbarLeftWidth }}>
            {toolbarLeft}
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
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
                  onClick={() => switchViewMode('grid')}
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
                  onClick={() => switchViewMode('columns')}
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
          primaryColumnId={primaryVisibleColumnId}
          onPrimaryColumnWidthChange={setGridPrimaryColumnWidth}
          skeletonDelayMs={gridSkeletonDelayMs}
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
              showAddButton: columnSupportsAddButton(column.id, onAddTask),
              skeletonCards: columnTasks.map((task) => ({
                key: task.id,
                height: estimateGridSkeletonCardHeight(task, column.id, kanbanState, hasReviewers),
              })),
            };
          })}
        />
      ) : (
        <div className="w-full min-w-0 max-w-full overflow-x-auto overflow-y-hidden px-1 pb-6 pr-4 pt-2">
          <div className="flex min-w-max items-start pr-1">
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
                      bodyClassName="max-h-none overflow-visible"
                    >
                      {renderCards(column.id, columnTasks, true)}
                    </KanbanColumn>
                  </div>
                  {index < visibleColumns.length - 1 ? (
                    <div
                      className="group relative mx-0.5 flex items-center justify-center"
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
        </div>
      )}
    </div>
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
