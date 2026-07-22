import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { DndContext, PointerSensor, useSensor, useSensors } from '@dnd-kit/core';
import { arrayMove } from '@dnd-kit/sortable';
import { SortableContext, useSortable, verticalListSortingStrategy } from '@dnd-kit/sortable';
import { CSS } from '@dnd-kit/utilities';
import { useAppTranslation } from '@features/localization/renderer';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useResizableColumns } from '@renderer/hooks/useResizableColumns';
import { cn } from '@renderer/lib/utils';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import { isTeamTaskNeedsFixActionable } from '@shared/utils/teamTaskState';
import {
  CheckCircle2,
  ChevronDown,
  ClipboardList,
  Columns3,
  Eye,
  LayoutGrid,
  PlayCircle,
  Plus,
  ShieldCheck,
  Trash2,
} from 'lucide-react';

import { KANBAN_COLUMN_CONTROL_INSET_CLASS, KanbanColumn } from './KanbanColumn';
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

const COLUMN_ACCENTS: Record<KanbanColumnId, { accentColor: string; icon: React.ReactNode }> = {
  todo: {
    accentColor: 'rgb(59, 130, 246)',
    icon: <ClipboardList size={14} className="shrink-0 text-[var(--kanban-column-accent)]" />,
  },
  in_progress: {
    accentColor: 'rgb(234, 179, 8)',
    icon: <PlayCircle size={14} className="shrink-0 text-[var(--kanban-column-accent)]" />,
  },
  done: {
    accentColor: 'rgb(20, 184, 166)',
    icon: <CheckCircle2 size={14} className="shrink-0 text-[var(--kanban-column-accent)]" />,
  },
  review: {
    accentColor: 'rgb(139, 92, 246)',
    icon: <Eye size={14} className="shrink-0 text-[var(--kanban-column-accent)]" />,
  },
  approved: {
    accentColor: 'rgb(101, 163, 13)',
    icon: <ShieldCheck size={14} className="shrink-0 text-[var(--kanban-column-accent)]" />,
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
  activeTaskLogActivity?: Record<string, true>;
  /** Shows all cards when another UI flow, such as search, must not hide matches. */
  forceShowAllTasks?: boolean;
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
const INITIAL_VISIBLE_TASKS_PER_COLUMN = 20;
const LOAD_MORE_TASKS_PER_COLUMN = 20;

const COLUMNS = [
  { id: 'todo', titleKey: 'kanban.columns.todo' },
  { id: 'in_progress', titleKey: 'kanban.columns.inProgress' },
  { id: 'review', titleKey: 'kanban.columns.review' },
  { id: 'done', titleKey: 'kanban.columns.done' },
  { id: 'approved', titleKey: 'kanban.columns.approved' },
] as const satisfies readonly { id: KanbanColumnId; titleKey: string }[];

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
  let height = 96;

  if (task.needsClarification) height += 18;
  if (isTeamTaskNeedsFixActionable(task)) height += 16;
  height += (task.blockedBy?.length ?? 0) * 20;
  height += (task.blocks?.length ?? 0) * 20;

  const effectiveReviewer = (kanbanState.tasks[task.id]?.reviewer ?? '').trim();
  if (columnId === 'review' && !hasReviewers && effectiveReviewer.length === 0) {
    height += 14;
  }

  return Math.min(Math.max(height, 96), 320);
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
  showSeparator: boolean;
  taskMap: Map<string, TeamTask>;
  memberColorMap: Map<string, string>;
  hasLiveTaskLogs?: boolean;
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
  showSeparator,
  taskMap,
  memberColorMap,
  hasLiveTaskLogs,
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
        flat
        task={task}
        teamName={teamName}
        columnId={columnId}
        kanbanTaskState={kanbanState.tasks[task.id]}
        hasReviewers={kanbanState.reviewers.length > 0}
        compact={compact}
        showSeparator={showSeparator}
        taskMap={taskMap}
        memberColorMap={memberColorMap}
        hasLiveTaskLogs={hasLiveTaskLogs}
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

export const KanbanBoard = memo(function KanbanBoard({
  tasks,
  teamName,
  kanbanState,
  filter,
  sort,
  sessions,
  leadSessionId,
  members,
  activeTaskLogActivity,
  forceShowAllTasks = false,
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
}: KanbanBoardProps): React.JSX.Element {
  const { t } = useAppTranslation('team');
  const boardRef = useRef<HTMLDivElement>(null);
  const scrollRestoreTimeoutsRef = useRef<number[]>([]);
  const [viewMode, setViewMode] = useState<KanbanViewMode>('grid');
  const [gridPrimaryColumnWidth, setGridPrimaryColumnWidth] = useState<number | null>(null);
  const [gridSkeletonDelayMs, setGridSkeletonDelayMs] = useState(SKELETON_HIDE_DELAY_MS);
  const [visibleTaskLimitsByColumn, setVisibleTaskLimitsByColumn] = useState<
    Partial<Record<KanbanColumnId, number>>
  >({});
  const hasReviewers = kanbanState.reviewers.length > 0;
  const enableTaskSorting =
    viewMode === 'columns' && !!onColumnOrderChange && sort.field === 'manual';
  const shouldLimitTaskCards = !forceShowAllTasks && !enableTaskSorting;

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

  const filterOwnerKey = useMemo(
    () =>
      Array.from(filter.selectedOwners)
        .sort((a, b) => a.localeCompare(b))
        .join('\0'),
    [filter.selectedOwners]
  );
  const filterColumnKey = useMemo(
    () =>
      Array.from(filter.columns)
        .sort((a, b) => a.localeCompare(b))
        .join('\0'),
    [filter.columns]
  );

  useEffect(() => {
    setVisibleTaskLimitsByColumn({});
  }, [teamName, viewMode, sort.field, filter.sessionId, filterOwnerKey, filterColumnKey]);

  const getVisibleTaskLimit = useCallback(
    (columnId: KanbanColumnId) =>
      visibleTaskLimitsByColumn[columnId] ?? INITIAL_VISIBLE_TASKS_PER_COLUMN,
    [visibleTaskLimitsByColumn]
  );

  const revealNextTasks = useCallback((columnId: KanbanColumnId, totalTasks: number) => {
    setVisibleTaskLimitsByColumn((prev) => {
      const current = prev[columnId] ?? INITIAL_VISIBLE_TASKS_PER_COLUMN;
      return {
        ...prev,
        [columnId]: Math.min(current + LOAD_MORE_TASKS_PER_COLUMN, totalTasks),
      };
    });
  }, []);

  const renderableColumnTasks = useCallback(
    (columnId: KanbanColumnId, columnTasks: TeamTask[]) => {
      if (!shouldLimitTaskCards) {
        return columnTasks;
      }
      return columnTasks.slice(0, getVisibleTaskLimit(columnId));
    },
    [getVisibleTaskLimit, shouldLimitTaskCards]
  );

  const handleScrollToTask = useCallback(
    (taskId: string) => {
      if (!onScrollToTask) {
        return;
      }

      if (!shouldLimitTaskCards) {
        onScrollToTask(taskId);
        return;
      }

      for (const column of COLUMNS) {
        const columnTasks = groupedOrdered.get(column.id) ?? [];
        const taskIndex = columnTasks.findIndex((task) => task.id === taskId);
        if (taskIndex === -1) {
          continue;
        }

        const currentLimit = getVisibleTaskLimit(column.id);
        if (taskIndex < currentLimit) {
          onScrollToTask(taskId);
          return;
        }

        setVisibleTaskLimitsByColumn((prev) => ({
          ...prev,
          [column.id]: Math.max(prev[column.id] ?? INITIAL_VISIBLE_TASKS_PER_COLUMN, taskIndex + 1),
        }));
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(() => onScrollToTask(taskId));
        });
        return;
      }

      onScrollToTask(taskId);
    },
    [getVisibleTaskLimit, groupedOrdered, onScrollToTask, shouldLimitTaskCards]
  );

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

  const renderCards = useCallback(
    (columnId: KanbanColumnId, columnTasks: TeamTask[], compact?: boolean): React.JSX.Element => {
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
          className={cn(
            KANBAN_COLUMN_CONTROL_INSET_CLASS,
            'flex items-center justify-center gap-1.5 rounded-md border border-dashed border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-emphasis)] hover:text-[var(--color-text-secondary)]'
          )}
        >
          <Plus size={13} />
          {t('kanban.board.addTask')}
        </button>
      ) : null;

      if (columnTasks.length === 0) {
        return (
          addButton ?? (
            <div
              className={cn(
                KANBAN_COLUMN_CONTROL_INSET_CLASS,
                'rounded-md border border-dashed border-[var(--color-border)] p-3 text-xs text-[var(--color-text-muted)]'
              )}
            >
              {t('kanban.board.noTasks')}
            </div>
          )
        );
      }
      const visibleTasks = renderableColumnTasks(columnId, columnTasks);
      const hiddenTaskCount = Math.max(0, columnTasks.length - visibleTasks.length);
      const nextRevealCount = Math.min(LOAD_MORE_TASKS_PER_COLUMN, hiddenTaskCount);
      const showMoreButton =
        hiddenTaskCount > 0 ? (
          <button
            type="button"
            onClick={() => revealNextTasks(columnId, columnTasks.length)}
            className={cn(
              KANBAN_COLUMN_CONTROL_INSET_CLASS,
              'flex items-center justify-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-2.5 text-xs text-[var(--color-text-muted)] transition-colors hover:border-[var(--color-border-emphasis)] hover:text-[var(--color-text-secondary)]'
            )}
          >
            <ChevronDown size={13} />
            {t('kanban.board.showMore', { count: nextRevealCount })}
            <span className="text-[10px] text-[var(--color-text-muted)]">
              {t('kanban.board.hiddenCount', { count: hiddenTaskCount })}
            </span>
          </button>
        ) : null;

      if (enableTaskSorting) {
        const itemIds = visibleTasks.map((t) => t.id);
        return (
          <>
            <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
              {visibleTasks.map((task, index) => (
                <SortableKanbanTaskCard
                  key={task.id}
                  task={task}
                  columnId={columnId}
                  teamName={teamName}
                  kanbanState={kanbanState}
                  compact={compact}
                  showSeparator={index < visibleTasks.length - 1}
                  taskMap={taskMap}
                  memberColorMap={memberColorMap}
                  hasLiveTaskLogs={Boolean(activeTaskLogActivity?.[task.id])}
                  onRequestReview={onRequestReview}
                  onApprove={onApprove}
                  onRequestChanges={onRequestChanges}
                  onMoveBackToDone={onMoveBackToDone}
                  onStartTask={onStartTask}
                  onCompleteTask={onCompleteTask}
                  onCancelTask={onCancelTask}
                  onScrollToTask={handleScrollToTask}
                  onTaskClick={onTaskClick}
                  onViewChanges={onViewChanges}
                  onDeleteTask={onDeleteTask}
                />
              ))}
            </SortableContext>
            {showMoreButton}
            {addButton}
          </>
        );
      }
      return (
        <>
          {visibleTasks.map((task, index) => (
            <KanbanTaskCard
              flat
              key={task.id}
              task={task}
              teamName={teamName}
              columnId={columnId}
              kanbanTaskState={kanbanState.tasks[task.id]}
              hasReviewers={hasReviewers}
              compact={compact}
              showSeparator={index < visibleTasks.length - 1}
              taskMap={taskMap}
              memberColorMap={memberColorMap}
              hasLiveTaskLogs={Boolean(activeTaskLogActivity?.[task.id])}
              onRequestReview={onRequestReview}
              onApprove={onApprove}
              onRequestChanges={onRequestChanges}
              onMoveBackToDone={onMoveBackToDone}
              onStartTask={onStartTask}
              onCompleteTask={onCompleteTask}
              onCancelTask={onCancelTask}
              onScrollToTask={handleScrollToTask}
              onTaskClick={onTaskClick}
              onViewChanges={onViewChanges}
              onDeleteTask={onDeleteTask}
            />
          ))}
          {showMoreButton}
          {addButton}
        </>
      );
    },
    [
      enableTaskSorting,
      activeTaskLogActivity,
      handleScrollToTask,
      hasReviewers,
      kanbanState,
      memberColorMap,
      onAddTask,
      onApprove,
      onCancelTask,
      onCompleteTask,
      onDeleteTask,
      onMoveBackToDone,
      onRequestChanges,
      onRequestReview,
      onStartTask,
      onTaskClick,
      onViewChanges,
      renderableColumnTasks,
      revealNextTasks,
      taskMap,
      teamName,
      t,
    ]
  );

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

  const gridColumns = useMemo(
    () =>
      visibleColumns.map((column) => {
        const columnTasks = groupedOrdered.get(column.id) ?? [];
        const accent = COLUMN_ACCENTS[column.id];
        return {
          id: column.id,
          title: t(column.titleKey),
          count: columnTasks.length,
          icon: accent.icon,
          accentColor: accent.accentColor,
          content: renderCards(column.id, columnTasks),
          showAddButton: columnSupportsAddButton(column.id, onAddTask),
          skeletonCards: renderableColumnTasks(column.id, columnTasks).map((task) => ({
            key: task.id,
            height: estimateGridSkeletonCardHeight(task, column.id, kanbanState, hasReviewers),
          })),
        };
      }),
    [
      visibleColumns,
      groupedOrdered,
      renderCards,
      onAddTask,
      renderableColumnTasks,
      kanbanState,
      hasReviewers,
      t,
    ]
  );

  const boardContent = (
    <div ref={boardRef} className="min-w-0 max-w-full overflow-x-hidden">
      <div
        className={cn(
          'flex min-w-0 max-w-full items-center gap-2 px-2',
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
              <TooltipContent side="bottom">{t('kanban.board.trash')}</TooltipContent>
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
                  aria-label={t('kanban.board.gridView')}
                >
                  <LayoutGrid size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('kanban.board.gridView')}</TooltipContent>
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
                  aria-label={t('kanban.board.columnsView')}
                >
                  <Columns3 size={14} />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">{t('kanban.board.columnsView')}</TooltipContent>
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
          columns={gridColumns}
        />
      ) : (
        <div className="w-full min-w-0 max-w-full overflow-x-auto overflow-y-hidden pb-6 pt-2">
          <div className="flex min-w-max items-start">
            {visibleColumns.map((column, index) => {
              const columnTasks = groupedOrdered.get(column.id) ?? [];
              const accent = COLUMN_ACCENTS[column.id];
              const width = columnWidths.get(column.id) ?? 256;
              const handleProps = getHandleProps(column.id);
              return (
                <div key={column.id} className="relative shrink-0" style={{ width }}>
                  <KanbanColumn
                    title={t(column.titleKey)}
                    count={columnTasks.length}
                    icon={accent.icon}
                    accentColor={accent.accentColor}
                    bodyClassName="max-h-none overflow-visible"
                  >
                    {renderCards(column.id, columnTasks, true)}
                  </KanbanColumn>
                  {index < visibleColumns.length - 1 ? (
                    <div
                      className="group absolute right-0 top-0 z-20 flex h-full translate-x-1/2 items-center justify-center"
                      onPointerDown={handleProps.onPointerDown}
                      style={handleProps.style}
                      aria-label={handleProps['aria-label']}
                    >
                      <div className="h-full w-px bg-transparent transition-colors group-active:bg-blue-500" />
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
});
