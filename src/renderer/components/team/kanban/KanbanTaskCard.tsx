import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useReducer,
  useRef,
  useState,
} from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { OngoingIndicator } from '@renderer/components/common/OngoingIndicator';
import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { UnreadCommentsBadge } from '@renderer/components/team/UnreadCommentsBadge';
import { Button } from '@renderer/components/ui/button';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@renderer/components/ui/hover-card';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useTheme } from '@renderer/hooks/useTheme';
import { useUnreadCommentCount } from '@renderer/hooks/useUnreadCommentCount';
import { REVIEW_STATE_DISPLAY } from '@renderer/utils/memberHelpers';
import {
  buildTaskChangeRequestOptions,
  canDisplayTaskChangesForOptions,
} from '@renderer/utils/taskChangeRequest';
import { deriveTaskDisplayId, formatTaskDisplayLabel } from '@shared/utils/taskIdentity';
import {
  isTeamTaskFinishedForDependency,
  isTeamTaskNeedsFixActionable,
} from '@shared/utils/teamTaskState';
import {
  ArrowLeftFromLine,
  ArrowRightFromLine,
  CheckCircle2,
  Eye,
  FileCode,
  FilePenLine,
  HelpCircle,
  Play,
  RotateCcw,
  Trash2,
  XCircle,
} from 'lucide-react';

import type {
  KanbanColumnId,
  KanbanTaskState,
  TaskComment,
  TeamTask,
  TeamTaskWithKanban,
} from '@shared/types';

interface KanbanTaskCardProps {
  task: TeamTaskWithKanban;
  teamName: string;
  columnId: KanbanColumnId;
  kanbanTaskState?: KanbanTaskState;
  hasReviewers: boolean;
  compact?: boolean;
  flat?: boolean;
  showSeparator?: boolean;
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

interface DependencyBadgeProps {
  taskId: string;
  taskMap: Map<string, TeamTask>;
  onScrollToTask?: (taskId: string) => void;
}

interface FlatDependencyRowProps extends DependencyBadgeProps {
  label: string;
  direction: 'backward' | 'forward';
  tone: 'blocked' | 'depends' | 'blocks';
}

interface CommentPulseState {
  taskKey: string;
  commentCount: number;
  commentIds: Set<string>;
  pulseKey: number;
}

interface CommentPulseSyncAction {
  taskKey: string;
  comments: readonly TaskComment[];
}

const EMPTY_TASK_COMMENTS: readonly TaskComment[] = [];
const taskCardSignatureCache = new WeakMap<TeamTaskWithKanban, string>();

function getTaskCardSignature(task: TeamTaskWithKanban): string {
  const cached = taskCardSignatureCache.get(task);
  if (cached !== undefined) return cached;

  const signature = JSON.stringify(task);
  taskCardSignatureCache.set(task, signature);
  return signature;
}

function areKanbanTaskStatesEqual(
  prev: KanbanTaskState | undefined,
  next: KanbanTaskState | undefined
): boolean {
  if (prev === next) return true;
  if (!prev || !next) return !prev && !next;
  return (
    prev.column === next.column &&
    prev.reviewer === next.reviewer &&
    prev.errorDescription === next.errorDescription &&
    prev.movedAt === next.movedAt
  );
}

function getTaskDependencyIds(task: TeamTaskWithKanban): string[] {
  return [...(task.blockedBy ?? []), ...(task.blocks ?? [])].filter((id) => id.length > 0);
}

function getDependencyTaskSignature(task: TeamTask | undefined): string {
  if (!task) return '';
  const kanbanTask = task as Partial<TeamTaskWithKanban>;
  return [
    task.id,
    task.displayId ?? '',
    task.subject,
    task.status,
    task.reviewState ?? '',
    kanbanTask.kanbanColumn ?? '',
  ].join('\u001f');
}

function areTaskMapDependenciesEqual(
  prevTask: TeamTaskWithKanban,
  nextTask: TeamTaskWithKanban,
  prevTaskMap: Map<string, TeamTask>,
  nextTaskMap: Map<string, TeamTask>
): boolean {
  const dependencyIds = new Set([
    ...getTaskDependencyIds(prevTask),
    ...getTaskDependencyIds(nextTask),
  ]);
  for (const taskId of dependencyIds) {
    if (
      getDependencyTaskSignature(prevTaskMap.get(taskId)) !==
      getDependencyTaskSignature(nextTaskMap.get(taskId))
    ) {
      return false;
    }
  }
  return true;
}

function createCommentPulseState(
  taskKey: string,
  comments: readonly TaskComment[],
  pulseKey = 0
): CommentPulseState {
  return {
    taskKey,
    commentCount: comments.length,
    commentIds: new Set(comments.map((comment) => comment.id)),
    pulseKey,
  };
}

function hasSameCommentIds(state: CommentPulseState, comments: readonly TaskComment[]): boolean {
  return (
    comments.length === state.commentCount &&
    comments.every((comment) => state.commentIds.has(comment.id))
  );
}

function syncCommentPulseState(
  state: CommentPulseState,
  action: CommentPulseSyncAction
): CommentPulseState {
  if (state.taskKey !== action.taskKey) {
    return createCommentPulseState(action.taskKey, action.comments);
  }

  const hasNewIncomingComment =
    action.comments.length > state.commentCount &&
    action.comments.some(
      (comment) => !state.commentIds.has(comment.id) && comment.author !== 'user'
    );

  if (!hasNewIncomingComment && hasSameCommentIds(state, action.comments)) {
    return state;
  }

  return createCommentPulseState(
    action.taskKey,
    action.comments,
    hasNewIncomingComment ? state.pulseKey + 1 : state.pulseKey
  );
}

const DependencyBadge = ({
  taskId,
  taskMap,
  onScrollToTask,
}: DependencyBadgeProps): React.JSX.Element => {
  const depTask = taskMap.get(taskId);
  const isCompleted = depTask ? isTeamTaskFinishedForDependency(depTask) : false;
  const label = depTask
    ? `${formatTaskDisplayLabel(depTask)}: ${depTask.subject}`
    : `#${deriveTaskDisplayId(taskId)}`;

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
            isCompleted
              ? 'bg-emerald-500/15 text-emerald-700 hover:bg-emerald-500/25 dark:text-emerald-400'
              : 'bg-yellow-500/15 text-yellow-700 hover:bg-yellow-500/25 dark:text-yellow-300'
          } ${onScrollToTask ? 'cursor-pointer' : ''}`}
          onClick={(e) => {
            e.stopPropagation();
            onScrollToTask?.(taskId);
          }}
        >
          {depTask ? formatTaskDisplayLabel(depTask) : `#${deriveTaskDisplayId(taskId)}`}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  );
};

const FlatDependencyRow = ({
  taskId,
  taskMap,
  onScrollToTask,
  label,
  direction,
  tone,
}: FlatDependencyRowProps): React.JSX.Element => {
  const depTask = taskMap.get(taskId);
  const displayLabel = depTask
    ? formatTaskDisplayLabel(depTask)
    : `#${deriveTaskDisplayId(taskId)}`;
  const toneClass =
    tone === 'blocked'
      ? 'text-yellow-700 dark:text-yellow-300'
      : tone === 'blocks'
        ? 'text-blue-600 dark:text-blue-400'
        : 'text-[var(--color-text-muted)]';
  const DirectionIcon = direction === 'backward' ? ArrowLeftFromLine : ArrowRightFromLine;

  return (
    <button
      type="button"
      className={`flex w-full min-w-0 items-center gap-1.5 overflow-hidden whitespace-nowrap text-left text-[10px] leading-4 ${toneClass} ${
        onScrollToTask ? 'cursor-pointer' : 'cursor-default'
      }`}
      onClick={(e) => {
        e.stopPropagation();
        onScrollToTask?.(taskId);
      }}
    >
      <DirectionIcon className="size-3 shrink-0" />
      <span className="shrink-0 font-medium">{label}</span>
      <span className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-[var(--color-text-muted)]">
        <span className="shrink-0 font-medium">{displayLabel}</span>
        {depTask ? (
          <span
            className="min-w-0 truncate text-[var(--color-text-secondary)]"
            title={depTask.subject}
          >
            {depTask.subject}
          </span>
        ) : null}
      </span>
    </button>
  );
};

const TruncatedTitle = ({
  text,
  className,
  reserveTwoLines = false,
  prominent = false,
}: {
  text: string;
  className?: string;
  reserveTwoLines?: boolean;
  prominent?: boolean;
}): React.JSX.Element => {
  const titleRef = useRef<HTMLHeadingElement | null>(null);
  const [isOverflowing, setIsOverflowing] = useState(false);
  const [tooltipOpen, setTooltipOpen] = useState(false);

  const updateOverflowState = useCallback((): boolean => {
    const element = titleRef.current;
    if (!element) return false;

    const nextIsOverflowing =
      element.scrollHeight > element.clientHeight + 1 ||
      element.scrollWidth > element.clientWidth + 1;
    setIsOverflowing((current) => (current === nextIsOverflowing ? current : nextIsOverflowing));
    if (!nextIsOverflowing) setTooltipOpen(false);
    return nextIsOverflowing;
  }, []);

  useLayoutEffect(() => {
    const element = titleRef.current;
    if (!element) return undefined;

    updateOverflowState();

    if (typeof ResizeObserver !== 'undefined') {
      let animationFrame = 0;
      const resizeObserver = new ResizeObserver(() => {
        cancelAnimationFrame(animationFrame);
        animationFrame = requestAnimationFrame(updateOverflowState);
      });
      resizeObserver.observe(element);
      return () => {
        cancelAnimationFrame(animationFrame);
        resizeObserver.disconnect();
      };
    }

    window.addEventListener('resize', updateOverflowState);
    return () => window.removeEventListener('resize', updateOverflowState);
  }, [text, updateOverflowState]);

  const handleTooltipOpenChange = useCallback(
    (open: boolean): void => {
      setTooltipOpen(open && updateOverflowState());
    },
    [updateOverflowState]
  );

  const title = (
    <h5
      ref={titleRef}
      data-title-overflow={isOverflowing ? 'true' : 'false'}
      className={`line-clamp-2 font-medium text-[var(--color-text)] ${
        prominent ? 'text-sm leading-5' : 'text-xs leading-4'
      } ${reserveTwoLines ? (prominent ? 'h-10' : 'h-8') : ''} ${className ?? ''}`}
    >
      {text}
    </h5>
  );

  return (
    <Tooltip open={tooltipOpen} onOpenChange={handleTooltipOpenChange}>
      <TooltipTrigger asChild>{title}</TooltipTrigger>
      <TooltipContent
        side="top"
        sideOffset={6}
        collisionPadding={12}
        className="max-w-80 text-pretty break-words leading-relaxed"
        data-testid="kanban-task-title-tooltip"
      >
        {text}
      </TooltipContent>
    </Tooltip>
  );
};

const CancelTaskButton = ({
  taskId,
  onConfirm,
  toolbarMode = false,
  onOpenChange,
}: {
  taskId: string;
  onConfirm: (taskId: string) => void;
  toolbarMode?: boolean;
  onOpenChange?: (open: boolean) => void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const [open, setOpen] = useState(false);
  const handleOpenChange = (nextOpen: boolean): void => {
    setOpen(nextOpen);
    onOpenChange?.(nextOpen);
  };

  return (
    <Popover open={open} onOpenChange={handleOpenChange}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant={toolbarMode ? 'ghost' : 'destructive'}
              size="icon"
              className={
                toolbarMode
                  ? 'size-6 rounded-none text-red-400 shadow-none hover:bg-red-500/10 hover:text-red-300'
                  : 'size-6 rounded-full shadow-sm'
              }
              aria-label={t('kanban.taskCard.cancelTask', { taskId })}
              onClick={(e) => e.stopPropagation()}
            >
              <XCircle size={11} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">{t('kanban.taskCard.cancel')}</TooltipContent>
      </Tooltip>
      {open ? (
        <PopoverContent
          className="w-56 p-3"
          side="top"
          align="start"
          onClick={(e) => e.stopPropagation()}
        >
          <p className="mb-3 text-xs text-[var(--color-text-secondary)]">
            {t('kanban.taskCard.moveBackToTodoConfirm')}
          </p>
          <div className="flex gap-2">
            <Button
              variant="destructive"
              size="sm"
              className="flex-1"
              onClick={() => {
                handleOpenChange(false);
                onConfirm(taskId);
              }}
            >
              {t('kanban.taskCard.confirm')}
            </Button>
            <Button
              variant="outline"
              size="sm"
              className="flex-1"
              onClick={() => handleOpenChange(false)}
            >
              {t('kanban.taskCard.keep')}
            </Button>
          </div>
        </PopoverContent>
      ) : null}
    </Popover>
  );
};

interface TaskActionIconButtonProps {
  label: string;
  icon: React.ReactNode;
  onClick: (e: React.MouseEvent<HTMLButtonElement>) => void;
  className: string;
  variant?: 'outline' | 'ghost' | 'destructive';
  disabled?: boolean;
}

const TaskActionIconButton = ({
  label,
  icon,
  onClick,
  className,
  variant = 'outline',
  disabled = false,
}: TaskActionIconButtonProps): React.JSX.Element => (
  <Button
    variant={variant}
    size="icon"
    className={`size-6 shrink-0 rounded-full shadow-sm ${className}`}
    aria-label={label}
    title={label}
    onClick={onClick}
    disabled={disabled}
  >
    {icon}
  </Button>
);

interface TaskMetaActionsProps {
  taskId: string;
  unreadCount: number;
  commentCount: number;
  pulseKey: number;
  showComments: boolean;
  canOpenChanges: boolean;
  changesNeedAttention: boolean;
  onViewChanges?: (taskId: string) => void;
  onDeleteTask?: (taskId: string) => void;
}

const TaskMetaActions = memo(function TaskMetaActions({
  taskId,
  unreadCount,
  commentCount,
  pulseKey,
  showComments,
  canOpenChanges,
  changesNeedAttention,
  onViewChanges,
  onDeleteTask,
}: TaskMetaActionsProps): React.JSX.Element {
  const { t } = useAppTranslation('team');

  return (
    <>
      {canOpenChanges && onViewChanges ? (
        <TaskActionIconButton
          label={
            changesNeedAttention
              ? t('kanban.taskCard.changesNeedAttention')
              : t('kanban.taskCard.changes')
          }
          icon={<FileCode className="size-2.5" />}
          variant="ghost"
          className={
            changesNeedAttention
              ? 'text-amber-400 hover:bg-amber-500/10 hover:text-amber-300'
              : 'text-sky-400 hover:bg-sky-500/10 hover:text-sky-300'
          }
          onClick={(e) => {
            e.stopPropagation();
            onViewChanges(taskId);
          }}
        />
      ) : null}
      {showComments ? (
        <UnreadCommentsBadge
          unreadCount={unreadCount}
          totalCount={commentCount}
          pulseKey={pulseKey}
        />
      ) : null}
      {onDeleteTask ? (
        <TaskActionIconButton
          label={t('kanban.taskCard.deleteTask')}
          icon={<Trash2 size={11} />}
          variant="ghost"
          className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
          onClick={(e) => {
            e.stopPropagation();
            onDeleteTask(taskId);
          }}
        />
      ) : null}
    </>
  );
});

interface TaskPrimaryActionsProps {
  taskId: string;
  columnId: KanbanColumnId;
  isReviewManual: boolean;
  onRequestReview: (taskId: string) => void;
  onApprove: (taskId: string) => void;
  onRequestChanges: (taskId: string) => void;
  onMoveBackToDone: (taskId: string) => void;
  onStartTask: (taskId: string) => void;
  onCompleteTask: (taskId: string) => void;
  onCancelTask: (taskId: string) => void;
  toolbarMode?: boolean;
  onActionPopoverOpenChange?: (open: boolean) => void;
}

const TaskPrimaryActions = memo(function TaskPrimaryActions({
  taskId,
  columnId,
  isReviewManual,
  onRequestReview,
  onApprove,
  onRequestChanges,
  onMoveBackToDone,
  onStartTask,
  onCompleteTask,
  onCancelTask,
  toolbarMode = false,
  onActionPopoverOpenChange,
}: TaskPrimaryActionsProps): React.JSX.Element {
  const { t } = useAppTranslation('team');

  return (
    <div
      className={
        toolbarMode ? 'flex min-w-0 flex-col items-center gap-1' : 'flex min-w-0 flex-nowrap gap-2'
      }
    >
      {columnId === 'todo' ? (
        <>
          <TaskActionIconButton
            label={t('kanban.taskCard.start')}
            icon={<Play size={11} />}
            className="border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
            onClick={(e) => {
              e.stopPropagation();
              onStartTask(taskId);
            }}
          />
          <TaskActionIconButton
            label={t('kanban.taskCard.complete')}
            icon={<CheckCircle2 size={11} />}
            className="border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
            onClick={(e) => {
              e.stopPropagation();
              onCompleteTask(taskId);
            }}
          />
        </>
      ) : null}

      {columnId === 'in_progress' ? (
        <>
          <TaskActionIconButton
            label={t('kanban.taskCard.complete')}
            icon={<CheckCircle2 size={11} />}
            className="border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
            onClick={(e) => {
              e.stopPropagation();
              onCompleteTask(taskId);
            }}
          />
          <CancelTaskButton
            taskId={taskId}
            onConfirm={onCancelTask}
            toolbarMode={toolbarMode}
            onOpenChange={onActionPopoverOpenChange}
          />
        </>
      ) : null}

      {columnId === 'done' ? (
        <>
          <TaskActionIconButton
            label={t('kanban.taskCard.approve')}
            icon={<CheckCircle2 size={11} />}
            className="border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
            onClick={(e) => {
              e.stopPropagation();
              onApprove(taskId);
            }}
          />
          <TaskActionIconButton
            label={t('kanban.taskCard.requestReview')}
            icon={<Eye size={11} />}
            className="border-violet-500/40 text-violet-400 hover:bg-violet-500/10 hover:text-violet-300"
            onClick={(e) => {
              e.stopPropagation();
              onRequestReview(taskId);
            }}
          />
        </>
      ) : null}

      {columnId === 'review' ? (
        <div className="flex min-w-0 flex-1 flex-col gap-1.5">
          {isReviewManual && !toolbarMode ? (
            <div className="whitespace-nowrap text-[11px] text-[var(--color-text-muted)]">
              {t('kanban.taskCard.manualReview')}
            </div>
          ) : null}
          <div
            className={
              toolbarMode ? 'flex flex-col items-center gap-1' : 'flex flex-wrap items-center gap-2'
            }
          >
            <TaskActionIconButton
              label={t('kanban.taskCard.approve')}
              icon={<CheckCircle2 size={11} />}
              className="border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
              onClick={(e) => {
                e.stopPropagation();
                onApprove(taskId);
              }}
            />
            <TaskActionIconButton
              label={t('kanban.taskCard.requestChanges')}
              icon={<FilePenLine size={11} />}
              variant={toolbarMode ? 'ghost' : 'destructive'}
              className={
                toolbarMode
                  ? 'text-red-400 hover:bg-red-500/10 hover:text-red-300'
                  : 'bg-red-500/90 text-white hover:bg-red-500'
              }
              onClick={(e) => {
                e.stopPropagation();
                onRequestChanges(taskId);
              }}
            />
          </div>
        </div>
      ) : null}

      {columnId === 'approved' ? (
        <TaskActionIconButton
          label="Disapprove"
          icon={<RotateCcw size={11} />}
          className="border-amber-500/40 text-amber-400 hover:bg-amber-500/10 hover:text-amber-300"
          onClick={(e) => {
            e.stopPropagation();
            onMoveBackToDone(taskId);
          }}
        />
      ) : null}
    </div>
  );
});

export const KanbanTaskCard = memo(
  function KanbanTaskCard({
    task,
    teamName,
    columnId,
    kanbanTaskState,
    hasReviewers,
    compact,
    flat = false,
    showSeparator = false,
    taskMap,
    memberColorMap,
    hasLiveTaskLogs = false,
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
  }: KanbanTaskCardProps): React.JSX.Element {
    const { t } = useAppTranslation('team');
    const { isLight } = useTheme();
    const unreadCount = useUnreadCommentCount(teamName, task.id, task.comments);
    const commentPulseTaskKey = `${teamName}/${task.id}`;
    const comments = task.comments ?? EMPTY_TASK_COMMENTS;
    const commentCount = comments.length;
    const [toolbarOpen, setToolbarOpen] = useState(false);
    const [actionPopoverOpen, setActionPopoverOpen] = useState(false);
    const handleActionPopoverOpenChange = useCallback((open: boolean): void => {
      setActionPopoverOpen(open);
      if (!open) setToolbarOpen(false);
    }, []);
    const [commentPulse, syncCommentPulse] = useReducer(
      syncCommentPulseState,
      { taskKey: commentPulseTaskKey, comments },
      ({ taskKey, comments: initialComments }) => createCommentPulseState(taskKey, initialComments)
    );
    const visibleCommentPulseKey =
      commentPulse.taskKey === commentPulseTaskKey ? commentPulse.pulseKey : 0;
    const blockedByIds = task.blockedBy?.filter((id) => id.length > 0) ?? [];
    const blocksIds = task.blocks?.filter((id) => id.length > 0) ?? [];
    const hasBlockedBy = blockedByIds.length > 0;
    const hasBlocks = blocksIds.length > 0;
    const hasActiveBlocker = blockedByIds.some((id) => {
      const blocker = taskMap.get(id);
      return !blocker || !isTeamTaskFinishedForDependency(blocker);
    });
    const shouldHighlightBlocked =
      hasActiveBlocker && columnId !== 'done' && columnId !== 'approved';
    const cardSurfaceClass = isLight ? 'bg-white' : 'bg-[var(--color-surface-raised)]';

    const taskChangeRequestOptions = useMemo(() => buildTaskChangeRequestOptions(task), [task]);
    const canDisplay = useMemo(
      () => canDisplayTaskChangesForOptions(taskChangeRequestOptions) && !!onViewChanges,
      [taskChangeRequestOptions, onViewChanges]
    );

    const effectiveReviewer = (kanbanTaskState?.reviewer ?? task.reviewer ?? '').trim();
    const isReviewManual = columnId === 'review' && !hasReviewers && effectiveReviewer.length === 0;
    const canOpenChanges =
      canDisplay &&
      (task.changePresence === 'has_changes' || task.changePresence === 'needs_attention');
    const changesNeedAttention = task.changePresence === 'needs_attention';

    const renderActionControls = (toolbarMode: boolean): React.JSX.Element => (
      <div
        data-kanban-task-toolbar={toolbarMode ? 'true' : undefined}
        data-orientation={toolbarMode ? 'vertical' : undefined}
        className={
          toolbarMode
            ? 'flex flex-col items-center gap-1'
            : 'flex items-center justify-between gap-2'
        }
      >
        <TaskPrimaryActions
          taskId={task.id}
          columnId={columnId}
          isReviewManual={isReviewManual}
          onRequestReview={onRequestReview}
          onApprove={onApprove}
          onRequestChanges={onRequestChanges}
          onMoveBackToDone={onMoveBackToDone}
          onStartTask={onStartTask}
          onCompleteTask={onCompleteTask}
          onCancelTask={onCancelTask}
          toolbarMode={toolbarMode}
          onActionPopoverOpenChange={toolbarMode ? handleActionPopoverOpenChange : undefined}
        />

        <div
          className={`flex shrink-0 flex-nowrap items-center gap-1.5 ${
            toolbarMode ? 'flex-col border-t border-[var(--color-border)] pt-1' : ''
          }`}
        >
          <TaskMetaActions
            taskId={task.id}
            unreadCount={unreadCount}
            commentCount={commentCount}
            pulseKey={visibleCommentPulseKey}
            showComments={!toolbarMode}
            canOpenChanges={canOpenChanges}
            changesNeedAttention={changesNeedAttention}
            onViewChanges={onViewChanges}
            onDeleteTask={onDeleteTask}
          />
        </div>
      </div>
    );

    useEffect(() => {
      syncCommentPulse({ taskKey: commentPulseTaskKey, comments });
    }, [commentCount, commentPulseTaskKey, comments]);

    const cardContent = (
      <div
        data-task-id={task.id}
        data-task-separator={flat && showSeparator ? 'true' : undefined}
        className={`kanban-task-card relative cursor-pointer ${
          flat
            ? `kanban-task-card-flat group rounded-none bg-transparent py-3 pl-3 pr-1.5 ${
                shouldHighlightBlocked ? 'kanban-task-card-flat-blocked' : ''
              }`
            : `rounded-md border px-1.5 py-3 hover:border-[var(--color-border-emphasis)] ${
                shouldHighlightBlocked
                  ? `border-yellow-500/30 ${cardSurfaceClass}`
                  : `border-[var(--color-border)] ${cardSurfaceClass}`
              }`
        }`}
        role="button"
        tabIndex={0}
        onClick={() => onTaskClick?.(task)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onTaskClick?.(task);
          }
        }}
      >
        {flat ? (
          <div className="absolute left-3 right-1.5 top-1.5 flex min-w-0 items-center justify-between gap-2">
            <div className="flex min-w-0 items-center gap-1.5 text-[10px] leading-none text-[var(--color-text-muted)]">
              <span className="truncate">{formatTaskDisplayLabel(task)}</span>
              <UnreadCommentsBadge
                unreadCount={unreadCount}
                totalCount={commentCount}
                pulseKey={visibleCommentPulseKey}
                showZero
                displayMode="inline"
              />
              {hasLiveTaskLogs ? (
                <span aria-label={t('kanban.taskCard.taskLogsActive')} className="inline-flex">
                  <OngoingIndicator size="sm" title={t('kanban.taskCard.newTaskLogsArriving')} />
                </span>
              ) : null}
            </div>
            {task.owner ? (
              <span className="shrink-0">
                <MemberBadge
                  name={task.owner}
                  color={memberColorMap.get(task.owner)}
                  size="xs"
                  variant="text"
                />
              </span>
            ) : null}
          </div>
        ) : (
          <>
            <span className="absolute left-[3px] top-[2px] flex max-w-[calc(100%-72px)] items-center gap-1 text-[9px] leading-none text-[var(--color-text-muted)]">
              <span className="truncate">{formatTaskDisplayLabel(task)}</span>
              {hasLiveTaskLogs ? (
                <span aria-label={t('kanban.taskCard.taskLogsActive')} className="inline-flex">
                  <OngoingIndicator size="sm" title={t('kanban.taskCard.newTaskLogsArriving')} />
                </span>
              ) : null}
            </span>
            {task.owner ? (
              <span className="absolute right-[6px] top-[2px]">
                <MemberBadge name={task.owner} color={memberColorMap.get(task.owner)} size="xs" />
              </span>
            ) : null}
          </>
        )}
        <div className={`mb-2 ${flat ? 'pt-5' : 'pt-[11px]'}`}>
          {flat ? (
            <TruncatedTitle text={task.subject} className="min-w-0" reserveTwoLines prominent />
          ) : !compact ? (
            <TruncatedTitle text={task.subject} className="min-w-0" />
          ) : null}
          {task.needsClarification ? (
            <span
              className={`mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                task.needsClarification === 'user'
                  ? 'bg-red-500/15 text-red-400'
                  : 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
              }`}
            >
              <HelpCircle size={10} />
              {task.needsClarification === 'user'
                ? t('kanban.taskCard.awaitingUser')
                : t('kanban.taskCard.awaitingLead')}
            </span>
          ) : null}
          {isTeamTaskNeedsFixActionable(task) ? (
            <span
              className={`mt-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${REVIEW_STATE_DISPLAY.needsFix.bg} ${REVIEW_STATE_DISPLAY.needsFix.text}`}
            >
              {REVIEW_STATE_DISPLAY.needsFix.label}
            </span>
          ) : null}
          {flat && isReviewManual ? (
            <span className="mt-1 inline-flex text-[10px] text-[var(--color-text-muted)]">
              {t('kanban.taskCard.manualReview')}
            </span>
          ) : null}
          {!flat && compact ? <TruncatedTitle text={task.subject} className="mt-1" /> : null}
        </div>

        {flat ? (
          hasBlockedBy || hasBlocks ? (
            <div className="mb-1.5 space-y-1">
              {blockedByIds.map((id) => {
                const blocker = taskMap.get(id);
                const isFinished = blocker ? isTeamTaskFinishedForDependency(blocker) : false;
                return (
                  <FlatDependencyRow
                    key={`blocked-by:${id}`}
                    taskId={id}
                    taskMap={taskMap}
                    onScrollToTask={onScrollToTask}
                    label={
                      isFinished
                        ? t('organizations.editor.relationKind.dependsOn')
                        : t('kanban.taskCard.blockedBy')
                    }
                    direction={isFinished ? 'forward' : 'backward'}
                    tone={isFinished ? 'depends' : 'blocked'}
                  />
                );
              })}
              {blocksIds.map((id) => (
                <FlatDependencyRow
                  key={`blocks:${id}`}
                  taskId={id}
                  taskMap={taskMap}
                  onScrollToTask={onScrollToTask}
                  label={t('kanban.taskCard.blocks')}
                  direction="forward"
                  tone="blocks"
                />
              ))}
            </div>
          ) : null
        ) : (
          <>
            {hasBlockedBy ? (
              <div className="mb-2 flex flex-wrap items-center gap-1">
                <span className="inline-flex items-center gap-0.5 text-[10px] text-yellow-700 dark:text-yellow-300">
                  <ArrowLeftFromLine size={10} />
                  {t('kanban.taskCard.blockedBy')}
                </span>
                {blockedByIds.map((id) => (
                  <DependencyBadge
                    key={id}
                    taskId={id}
                    taskMap={taskMap}
                    onScrollToTask={onScrollToTask}
                  />
                ))}
              </div>
            ) : null}

            {hasBlocks ? (
              <div className="mb-2 flex flex-wrap items-center gap-1">
                <span className="inline-flex items-center gap-0.5 text-[10px] text-blue-600 dark:text-blue-400">
                  <ArrowRightFromLine size={10} />
                  {t('kanban.taskCard.blocks')}
                </span>
                {blocksIds.map((id) => (
                  <DependencyBadge
                    key={id}
                    taskId={id}
                    taskMap={taskMap}
                    onScrollToTask={onScrollToTask}
                  />
                ))}
              </div>
            ) : null}
          </>
        )}

        {!flat ? renderActionControls(false) : null}
      </div>
    );

    if (!flat) {
      return cardContent;
    }

    return (
      <HoverCard
        open={toolbarOpen || actionPopoverOpen}
        onOpenChange={setToolbarOpen}
        openDelay={120}
        closeDelay={220}
      >
        <HoverCardTrigger asChild>{cardContent}</HoverCardTrigger>
        <HoverCardContent
          side="left"
          align="start"
          sideOffset={0}
          avoidCollisions={false}
          className="kanban-task-card-toolbar w-auto min-w-0 rounded-r-none border-r-0 bg-[var(--color-surface-raised)] p-1 shadow-none"
          onPointerDown={(e) => e.stopPropagation()}
          onClick={(e) => e.stopPropagation()}
        >
          {renderActionControls(true)}
        </HoverCardContent>
      </HoverCard>
    );
  },
  (prev, next) =>
    getTaskCardSignature(prev.task) === getTaskCardSignature(next.task) &&
    prev.teamName === next.teamName &&
    prev.columnId === next.columnId &&
    areKanbanTaskStatesEqual(prev.kanbanTaskState, next.kanbanTaskState) &&
    prev.hasReviewers === next.hasReviewers &&
    prev.compact === next.compact &&
    prev.flat === next.flat &&
    prev.showSeparator === next.showSeparator &&
    areTaskMapDependenciesEqual(prev.task, next.task, prev.taskMap, next.taskMap) &&
    prev.memberColorMap === next.memberColorMap &&
    prev.hasLiveTaskLogs === next.hasLiveTaskLogs &&
    prev.onRequestReview === next.onRequestReview &&
    prev.onApprove === next.onApprove &&
    prev.onRequestChanges === next.onRequestChanges &&
    prev.onMoveBackToDone === next.onMoveBackToDone &&
    prev.onStartTask === next.onStartTask &&
    prev.onCompleteTask === next.onCompleteTask &&
    prev.onCancelTask === next.onCancelTask &&
    prev.onScrollToTask === next.onScrollToTask &&
    prev.onTaskClick === next.onTaskClick &&
    prev.onViewChanges === next.onViewChanges &&
    prev.onDeleteTask === next.onDeleteTask
);
