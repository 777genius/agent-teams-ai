import { UnreadCommentsBadge } from '@renderer/components/team/UnreadCommentsBadge';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import { useUnreadCommentCount } from '@renderer/hooks/useUnreadCommentCount';
import { ArrowLeftFromLine, ArrowRightFromLine, CheckCircle2, Play } from 'lucide-react';

import type { KanbanColumnId, KanbanTaskState, TeamTask } from '@shared/types';

interface KanbanTaskCardProps {
  task: TeamTask;
  teamName: string;
  columnId: KanbanColumnId;
  kanbanTaskState?: KanbanTaskState;
  hasReviewers: boolean;
  taskMap: Map<string, TeamTask>;
  onRequestReview: (taskId: string) => void;
  onApprove: (taskId: string) => void;
  onRequestChanges: (taskId: string) => void;
  onMoveBackToDone: (taskId: string) => void;
  onStartTask: (taskId: string) => void;
  onCompleteTask: (taskId: string) => void;
  onScrollToTask?: (taskId: string) => void;
  onTaskClick?: (task: TeamTask) => void;
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

export const KanbanTaskCard = ({
  task,
  teamName,
  columnId,
  kanbanTaskState,
  hasReviewers,
  taskMap,
  onRequestReview,
  onApprove,
  onRequestChanges,
  onMoveBackToDone,
  onStartTask,
  onCompleteTask,
  onScrollToTask,
  onTaskClick,
}: KanbanTaskCardProps): React.JSX.Element => {
  const unreadCount = useUnreadCommentCount(teamName, task.id, task.comments);
  const blockedByIds = task.blockedBy?.filter((id) => id.length > 0) ?? [];
  const blocksIds = task.blocks?.filter((id) => id.length > 0) ?? [];
  const hasBlockedBy = blockedByIds.length > 0;
  const hasBlocks = blocksIds.length > 0;

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
      <div className="mb-2 flex items-start justify-between gap-2">
        <div>
          <div className="mb-1 flex items-center gap-1">
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
              #{task.id}
            </Badge>
            <UnreadCommentsBadge
              unreadCount={unreadCount}
              totalCount={task.comments?.length ?? 0}
            />
          </div>
          <h5 className="text-sm font-medium text-[var(--color-text)]">{task.subject}</h5>
        </div>
      </div>

      <p className="mb-2 text-xs text-[var(--color-text-muted)]">Owner: {task.owner ?? '\u2014'}</p>

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

      {columnId === 'todo' ? (
        <div className="flex gap-2">
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
        </div>
      ) : null}

      {columnId === 'in_progress' ? (
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
      ) : null}

      {columnId === 'done' ? (
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
  );
};
