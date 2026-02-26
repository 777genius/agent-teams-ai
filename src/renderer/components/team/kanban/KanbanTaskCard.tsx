import { useEffect, useMemo, useState } from 'react';

import { MemberBadge } from '@renderer/components/team/MemberBadge';
import { UnreadCommentsBadge } from '@renderer/components/team/UnreadCommentsBadge';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { useUnreadCommentCount } from '@renderer/hooks/useUnreadCommentCount';
import { useStore } from '@renderer/store';
import { buildMemberColorMap } from '@renderer/utils/memberHelpers';
import {
  ArrowLeftFromLine,
  ArrowRightFromLine,
  CheckCircle2,
  FileCode,
  HelpCircle,
  Play,
  Trash2,
  XCircle,
} from 'lucide-react';

import type { KanbanColumnId, KanbanTaskState, ResolvedTeamMember, TeamTask } from '@shared/types';

interface KanbanTaskCardProps {
  task: TeamTask;
  teamName: string;
  columnId: KanbanColumnId;
  kanbanTaskState?: KanbanTaskState;
  hasReviewers: boolean;
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

  return (
    <button
      type="button"
      className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
        isCompleted
          ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25'
          : 'bg-yellow-500/15 text-yellow-300 hover:bg-yellow-500/25'
      } ${onScrollToTask ? 'cursor-pointer' : ''}`}
      title={depTask ? `#${taskId}: ${depTask.subject}` : `#${taskId}`}
      onClick={(e) => {
        e.stopPropagation();
        onScrollToTask?.(taskId);
      }}
    >
      #{taskId}
    </button>
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
      <PopoverTrigger asChild>
        <Button
          variant="destructive"
          size="sm"
          className="gap-1"
          aria-label={`Cancel task ${taskId}`}
          onClick={(e) => e.stopPropagation()}
        >
          <XCircle size={12} />
          Cancel
        </Button>
      </PopoverTrigger>
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

export const KanbanTaskCard = ({
  task,
  teamName,
  columnId,
  kanbanTaskState: _kanbanTaskState,
  hasReviewers,
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
}: KanbanTaskCardProps): React.JSX.Element => {
  const colorMap = useMemo(() => buildMemberColorMap(members), [members]);
  const unreadCount = useUnreadCommentCount(teamName, task.id, task.comments);
  const blockedByIds = task.blockedBy?.filter((id) => id.length > 0) ?? [];
  const blocksIds = task.blocks?.filter((id) => id.length > 0) ?? [];
  const hasBlockedBy = blockedByIds.length > 0;
  const hasBlocks = blocksIds.length > 0;

  // Lazy-check if task has file changes (only for done/review/approved columns)
  const showChangesColumn =
    (columnId === 'done' || columnId === 'review' || columnId === 'approved') && !!onViewChanges;
  const cacheKey = `${teamName}:${task.id}`;
  const taskHasChanges = useStore((s) => s.taskHasChanges[cacheKey]);
  const checkTaskHasChanges = useStore((s) => s.checkTaskHasChanges);

  useEffect(() => {
    if (showChangesColumn && task.status === 'completed' && taskHasChanges == null) {
      void checkTaskHasChanges(teamName, task.id);
    }
  }, [showChangesColumn, task.status, task.id, teamName, taskHasChanges, checkTaskHasChanges]);

  return (
    <div
      data-task-id={task.id}
      className={`cursor-pointer rounded-md border p-3 transition-colors hover:border-[var(--color-border-emphasis)] ${
        hasBlockedBy
          ? 'border-yellow-500/30 bg-[var(--color-surface-raised)]'
          : 'border-[var(--color-border)] bg-[var(--color-surface-raised)]'
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
      <div className="mb-2 flex items-center gap-1">
        <Badge variant="secondary" className="shrink-0 px-1 py-0 text-[10px] font-normal">
          #{task.id}
        </Badge>
        {task.owner ? <MemberBadge name={task.owner} color={colorMap.get(task.owner)} /> : null}
        {task.needsClarification ? (
          <span
            className={`inline-flex shrink-0 items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] font-medium ${
              task.needsClarification === 'user'
                ? 'bg-red-500/15 text-red-400'
                : 'bg-blue-500/15 text-blue-400'
            }`}
          >
            <HelpCircle size={10} />
            {task.needsClarification === 'user' ? 'Awaiting user' : 'Awaiting lead'}
          </span>
        ) : null}
        <h5 className="min-w-0 truncate text-sm font-medium text-[var(--color-text)]">
          {task.subject}
        </h5>
      </div>

      {hasBlockedBy ? (
        <div className="mb-2 flex flex-wrap items-center gap-1">
          <span className="inline-flex items-center gap-0.5 text-[10px] text-yellow-300">
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
          <span className="inline-flex items-center gap-0.5 text-[10px] text-blue-400">
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

      <div className="flex items-end gap-2">
        <div className="flex flex-1 flex-wrap gap-2">
          {columnId === 'todo' ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="gap-1 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
                aria-label={`Start task ${task.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onStartTask(task.id);
                }}
              >
                <Play size={12} />
                Start
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                aria-label={`Complete task ${task.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onCompleteTask(task.id);
                }}
              >
                <CheckCircle2 size={12} />
                Complete
              </Button>
            </>
          ) : null}

          {columnId === 'in_progress' ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="gap-1"
                aria-label={`Complete task ${task.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onCompleteTask(task.id);
                }}
              >
                <CheckCircle2 size={12} />
                Complete
              </Button>
              <CancelTaskButton taskId={task.id} onConfirm={onCancelTask} />
            </>
          ) : null}

          {columnId === 'done' ? (
            <>
              <Button
                variant="outline"
                size="sm"
                className="gap-1 border-emerald-500/40 text-emerald-400 hover:bg-emerald-500/10 hover:text-emerald-300"
                aria-label={`Approve task ${task.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onApprove(task.id);
                }}
              >
                <CheckCircle2 size={12} />
                Approve
              </Button>
              <Button
                variant="outline"
                size="sm"
                aria-label={`Request review for task ${task.id}`}
                onClick={(e) => {
                  e.stopPropagation();
                  onRequestReview(task.id);
                }}
              >
                Request Review
              </Button>
            </>
          ) : null}

          {columnId === 'review' ? (
            <div className="space-y-2">
              {!hasReviewers ? (
                <p className="text-[11px] text-[var(--color-text-muted)]">Manual review</p>
              ) : null}
              <div className="flex gap-2">
                <Button
                  variant="outline"
                  size="sm"
                  aria-label={`Approve task ${task.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onApprove(task.id);
                  }}
                >
                  Approve
                </Button>
                <Button
                  variant="destructive"
                  size="sm"
                  aria-label={`Request changes for task ${task.id}`}
                  onClick={(e) => {
                    e.stopPropagation();
                    onRequestChanges(task.id);
                  }}
                >
                  Request Changes
                </Button>
              </div>
            </div>
          ) : null}

          {columnId === 'approved' ? (
            <Button
              variant="outline"
              size="sm"
              aria-label={`Move task ${task.id} back to done`}
              onClick={(e) => {
                e.stopPropagation();
                onMoveBackToDone(task.id);
              }}
            >
              Move back to DONE
            </Button>
          ) : null}
        </div>

        <div className="flex items-center gap-1.5">
          {showChangesColumn && taskHasChanges === true ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onViewChanges(task.id);
              }}
              className="flex items-center gap-1 text-[10px] text-[var(--color-text-muted)] transition-colors hover:text-blue-400"
            >
              <FileCode className="size-3" />
              Changes
            </button>
          ) : null}
          <UnreadCommentsBadge unreadCount={unreadCount} totalCount={task.comments?.length ?? 0} />
          {onDeleteTask ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDeleteTask(task.id);
              }}
              className="text-[var(--color-text-muted)] transition-colors hover:text-red-400"
              title="Delete task"
            >
              <Trash2 size={12} />
            </button>
          ) : null}
        </div>
      </div>
    </div>
  );
};
