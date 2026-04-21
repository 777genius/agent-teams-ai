import { memo, useCallback, useMemo, useRef, useState } from 'react';

import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { UnreadCommentsBadge } from '@renderer/components/team/UnreadCommentsBadge';
import { Button } from '@renderer/components/ui/button';
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

import type { KanbanColumnId, KanbanTaskState, TeamTask, TeamTaskWithKanban } from '@shared/types';

interface KanbanTaskCardProps {
  task: TeamTaskWithKanban;
  teamName: string;
  columnId: KanbanColumnId;
  kanbanTaskState?: KanbanTaskState;
  hasReviewers: boolean;
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

interface DependencyBadgeProps {
  taskId: string;
  taskMap: Map<string, TeamTask>;
  onScrollToTask?: (taskId: string) => void;
}

const DependencyBadge = ({
  taskId,
  taskMap,
  onScrollToTask,
}: DependencyBadgeProps): React.JSX.Element => {
  const depTask = taskMap.get(taskId);
  const isCompleted = depTask?.status === 'completed';
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

const TruncatedTitle = ({
  text,
  className,
}: {
  text: string;
  className?: string;
}): React.JSX.Element => {
  const ref = useRef<HTMLHeadingElement>(null);
  const [isTruncated, setIsTruncated] = useState(false);

  const checkTruncation = useCallback(() => {
    const el = ref.current;
    if (el) {
      setIsTruncated(el.scrollHeight > el.clientHeight);
    }
  }, []);

  return (
    <Tooltip open={isTruncated ? undefined : false}>
      <TooltipTrigger asChild>
        <h5
          ref={ref}
          className={`line-clamp-2 text-xs font-medium text-[var(--color-text)] ${className ?? ''}`}
          onMouseEnter={checkTruncation}
        >
          {text}
        </h5>
      </TooltipTrigger>
      <TooltipContent side="top" align="start">
        {text}
      </TooltipContent>
    </Tooltip>
  );
};

const CancelTaskButton = ({
  taskId,
  onConfirm,
}: {
  taskId: string;
  onConfirm: (taskId: string) => void;
}): React.JSX.Element => {
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverTrigger asChild>
            <Button
              variant="destructive"
              size="icon"
              className="size-6 rounded-full shadow-sm"
              aria-label={`Cancel task ${taskId}`}
              onClick={(e) => e.stopPropagation()}
            >
              <XCircle size={11} />
            </Button>
          </PopoverTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">Cancel</TooltipContent>
      </Tooltip>
      <PopoverContent
        className="w-56 p-3"
        side="top"
        align="start"
        onClick={(e) => e.stopPropagation()}
      >
        <p className="mb-3 text-xs text-[var(--color-text-secondary)]">
          Move this task back to TODO and notify the team?
        </p>
        <div className="flex gap-2">
          <Button
            variant="destructive"
            size="sm"
            className="flex-1"
            onClick={() => {
              setOpen(false);
              onConfirm(taskId);
            }}
          >
            Confirm
          </Button>
          <Button variant="outline" size="sm" className="flex-1" onClick={() => setOpen(false)}>
            Keep
          </Button>
        </div>
      </PopoverContent>
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
  <Tooltip>
    <TooltipTrigger asChild>
      <Button
        variant={variant}
        size="icon"
        className={`size-6 shrink-0 rounded-full shadow-sm ${className}`}
        aria-label={label}
        onClick={onClick}
        disabled={disabled}
      >
        {icon}
      </Button>
    </TooltipTrigger>
    <TooltipContent side="top">{label}</TooltipContent>
  </Tooltip>
);

export const KanbanTaskCard = memo(
  function KanbanTaskCard({
    task,
    teamName,
    columnId,
    kanbanTaskState,
    hasReviewers,
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
  }: KanbanTaskCardProps): React.JSX.Element {
    const { isLight } = useTheme();
    const unreadCount = useUnreadCommentCount(teamName, task.id, task.comments);
    const blockedByIds = task.blockedBy?.filter((id) => id.length > 0) ?? [];
    const blocksIds = task.blocks?.filter((id) => id.length > 0) ?? [];
    const hasBlockedBy = blockedByIds.length > 0;
    const hasBlocks = blocksIds.length > 0;
    const cardSurfaceClass = isLight ? 'bg-white' : 'bg-[var(--color-surface-raised)]';

    const taskChangeRequestOptions = useMemo(() => buildTaskChangeRequestOptions(task), [task]);
    const canDisplay = useMemo(
      () => canDisplayTaskChangesForOptions(taskChangeRequestOptions) && !!onViewChanges,
      [taskChangeRequestOptions, onViewChanges]
    );

    const effectiveReviewer = (kanbanTaskState?.reviewer ?? task.reviewer ?? '').trim();
    const isReviewManual = columnId === 'review' && !hasReviewers && effectiveReviewer.length === 0;
    const metaActions = (
      <>
        {canDisplay &&
        (task.changePresence === 'has_changes' || task.changePresence === 'needs_attention') ? (
          <TaskActionIconButton
            label="Changes"
            icon={<FileCode className="size-2.5" />}
            variant="ghost"
            className="text-sky-400 hover:bg-sky-500/10 hover:text-sky-300"
            onClick={(e) => {
              e.stopPropagation();
              onViewChanges!(task.id);
            }}
          />
        ) : null}
        <UnreadCommentsBadge unreadCount={unreadCount} totalCount={task.comments?.length ?? 0} />
        {onDeleteTask ? (
          <TaskActionIconButton
            label="Delete task"
            icon={<Trash2 size={11} />}
            variant="ghost"
            className="text-red-400 hover:bg-red-500/10 hover:text-red-300"
            onClick={(e) => {
              e.stopPropagation();
              onDeleteTask(task.id);
            }}
          />
        ) : null}
      </>
    );

    return (
      <div
        data-task-id={task.id}
        className={`relative cursor-pointer rounded-md border px-1.5 py-3 transition-colors hover:border-[var(--color-border-emphasis)] ${
          hasBlockedBy
            ? `border-yellow-500/30 ${cardSurfaceClass}`
            : `border-[var(--color-border)] ${cardSurfaceClass}`
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
        <span className="absolute left-[3px] top-[2px] text-[9px] leading-none text-[var(--color-text-muted)]">
          {formatTaskDisplayLabel(task)}
        </span>
        {task.owner ? (
          <span className="absolute right-[6px] top-[2px]">
            <MemberBadge name={task.owner} color={memberColorMap.get(task.owner)} size="xs" />
          </span>
        ) : null}
        <div className="mb-2 pt-[11px]">
          {!compact && <TruncatedTitle text={task.subject} className="min-w-0" />}
          {task.needsClarification ? (
            <span
              className={`mt-1 inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
                task.needsClarification === 'user'
                  ? 'bg-red-500/15 text-red-400'
                  : 'bg-blue-500/15 text-blue-600 dark:text-blue-400'
              }`}
            >
              <HelpCircle size={10} />
              {task.needsClarification === 'user' ? 'Awaiting user' : 'Awaiting lead'}
            </span>
          ) : null}
          {task.reviewState === 'needsFix' ? (
            <span
              className={`mt-1 inline-flex items-center rounded-full px-1.5 py-0.5 text-[10px] font-medium ${REVIEW_STATE_DISPLAY.needsFix.bg} ${REVIEW_STATE_DISPLAY.needsFix.text}`}
            >
              {REVIEW_STATE_DISPLAY.needsFix.label}
            </span>
          ) : null}
          {compact && <TruncatedTitle text={task.subject} className="mt-1" />}
        </div>

        {hasBlockedBy ? (
          <div className="mb-2 flex flex-wrap items-center gap-1">
            <span className="inline-flex items-center gap-0.5 text-[10px] text-yellow-700 dark:text-yellow-300">
              <ArrowLeftFromLine size={10} />
              Blocked by
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
              Blocks
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

        <div className="flex items-center justify-between gap-2">
          <div className="flex min-w-0 flex-nowrap gap-2">
            {columnId === 'todo' ? (
              <>
                <TaskActionIconButton
                  label="Start"
                  icon={<Play size={11} />}
                  className="border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
                  onClick={(e) => {
                    e.stopPropagation();
                    onStartTask(task.id);
                  }}
                />
                <TaskActionIconButton
                  label="Complete"
                  icon={<CheckCircle2 size={11} />}
                  className="border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCompleteTask(task.id);
                  }}
                />
              </>
            ) : null}

            {columnId === 'in_progress' ? (
              <>
                <TaskActionIconButton
                  label="Complete"
                  icon={<CheckCircle2 size={11} />}
                  className="border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
                  onClick={(e) => {
                    e.stopPropagation();
                    onCompleteTask(task.id);
                  }}
                />
                <CancelTaskButton taskId={task.id} onConfirm={onCancelTask} />
              </>
            ) : null}

            {columnId === 'done' ? (
              <>
                <TaskActionIconButton
                  label="Approve"
                  icon={<CheckCircle2 size={11} />}
                  className="border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
                  onClick={(e) => {
                    e.stopPropagation();
                    onApprove(task.id);
                  }}
                />
                <TaskActionIconButton
                  label="Request review"
                  icon={<Eye size={11} />}
                  className="border-violet-500/40 text-violet-400 hover:bg-violet-500/10 hover:text-violet-300"
                  onClick={(e) => {
                    e.stopPropagation();
                    onRequestReview(task.id);
                  }}
                />
              </>
            ) : null}

            {columnId === 'review' ? (
              <div className="flex min-w-0 flex-1 flex-col gap-1.5">
                {isReviewManual ? (
                  <div className="whitespace-nowrap text-[11px] text-[var(--color-text-muted)]">
                    Manual review
                  </div>
                ) : null}
                <div className="flex flex-wrap items-center gap-2">
                  <TaskActionIconButton
                    label="Approve"
                    icon={<CheckCircle2 size={11} />}
                    className="border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
                    onClick={(e) => {
                      e.stopPropagation();
                      onApprove(task.id);
                    }}
                  />
                  <TaskActionIconButton
                    label="Request changes"
                    icon={<FilePenLine size={11} />}
                    variant="destructive"
                    className="bg-red-500/90 text-white hover:bg-red-500"
                    onClick={(e) => {
                      e.stopPropagation();
                      onRequestChanges(task.id);
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
                  onMoveBackToDone(task.id);
                }}
              />
            ) : null}
          </div>

          <div className="flex shrink-0 flex-nowrap items-center gap-1.5">{metaActions}</div>
        </div>
      </div>
    );
  },
  (prev, next) =>
    prev.task === next.task &&
    prev.teamName === next.teamName &&
    prev.columnId === next.columnId &&
    prev.kanbanTaskState === next.kanbanTaskState &&
    prev.hasReviewers === next.hasReviewers &&
    prev.compact === next.compact &&
    prev.taskMap === next.taskMap &&
    prev.memberColorMap === next.memberColorMap &&
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
