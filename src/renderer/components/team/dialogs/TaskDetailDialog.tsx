import { useEffect } from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';
import { MemberLogsTab } from '@renderer/components/team/members/MemberLogsTab';
import { Badge } from '@renderer/components/ui/badge';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { markAsRead } from '@renderer/services/commentReadStorage';
import { TASK_STATUS_LABELS, TASK_STATUS_STYLES } from '@renderer/utils/memberHelpers';
import { formatDistanceToNow } from 'date-fns';
import {
  ArrowLeftFromLine,
  ArrowRightFromLine,
  Clock,
  FileText,
  PenLine,
  User,
} from 'lucide-react';

import { TaskCommentsSection } from './TaskCommentsSection';

import type { KanbanTaskState, ResolvedTeamMember, TeamTask } from '@shared/types';

interface TaskDetailDialogProps {
  open: boolean;
  task: TeamTask | null;
  teamName: string;
  kanbanTaskState?: KanbanTaskState;
  taskMap: Map<string, TeamTask>;
  members: ResolvedTeamMember[];
  onClose: () => void;
  onScrollToTask?: (taskId: string) => void;
}

export const TaskDetailDialog = ({
  open,
  task,
  teamName,
  kanbanTaskState,
  taskMap,
  members,
  onClose,
  onScrollToTask,
}: TaskDetailDialogProps): React.JSX.Element => {
  const currentTask = task ? (taskMap.get(task.id) ?? task) : null;

  useEffect(() => {
    if (!open || !currentTask) return;
    const comments = currentTask.comments ?? [];
    if (comments.length === 0) return;
    const latest = Math.max(...comments.map((c) => new Date(c.createdAt).getTime()));
    if (latest > 0) markAsRead(teamName, currentTask.id, latest);
  }, [open, teamName, currentTask]);

  const handleDependencyClick = (taskId: string): void => {
    onClose();
    onScrollToTask?.(taskId);
  };

  if (!currentTask) {
    return (
      <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>Task not found</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  const status = currentTask.status;
  const statusStyle = TASK_STATUS_STYLES[status];
  const statusLabel = TASK_STATUS_LABELS[status];
  const blockedByIds = currentTask.blockedBy?.filter((id) => id.length > 0) ?? [];
  const blocksIds = currentTask.blocks?.filter((id) => id.length > 0) ?? [];

  return (
    <Dialog open={open} onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] min-w-0 overflow-y-auto overflow-x-hidden sm:max-w-4xl">
        <DialogHeader>
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="px-1.5 py-0 text-[10px] font-normal">
              #{currentTask.id}
            </Badge>
            <span
              className={`inline-flex rounded-full px-2 py-0.5 text-[10px] font-medium ${statusStyle.bg} ${statusStyle.text}`}
            >
              {statusLabel}
            </span>
          </div>
          <DialogTitle className="text-base">{currentTask.subject}</DialogTitle>
          {currentTask.activeForm ? (
            <DialogDescription>{currentTask.activeForm}</DialogDescription>
          ) : null}
        </DialogHeader>

        {/* Metadata */}
        <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3">
          <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
            <User size={12} />
            <span className="text-[var(--color-text-secondary)]">
              {currentTask.owner ?? '\u2014'}
            </span>
          </div>
          {currentTask.createdBy ? (
            <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
              <PenLine size={12} />
              <span className="text-[var(--color-text-secondary)]">{currentTask.createdBy}</span>
            </div>
          ) : null}
          {currentTask.createdAt
            ? (() => {
                const date = new Date(currentTask.createdAt);
                return isNaN(date.getTime()) ? null : (
                  <div className="flex items-center gap-1.5 text-[var(--color-text-muted)]">
                    <Clock size={12} />
                    <span className="text-[var(--color-text-secondary)]">
                      {formatDistanceToNow(date, { addSuffix: true })}
                    </span>
                  </div>
                );
              })()
            : null}
        </div>

        {/* Description */}
        <div>
          <div className="mb-1 flex items-center gap-1.5 text-xs font-medium text-[var(--color-text-muted)]">
            <FileText size={12} />
            Description
          </div>
          {currentTask.description ? (
            <div className="max-h-[200px] overflow-y-auto rounded-md border border-[var(--color-border)] bg-[var(--color-surface)] p-3">
              <MarkdownViewer content={currentTask.description} maxHeight="max-h-[180px]" />
            </div>
          ) : (
            <p className="text-xs text-[var(--color-text-muted)]">No description</p>
          )}
        </div>

        {/* Dependencies */}
        {blockedByIds.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-0.5 text-xs text-yellow-300">
              <ArrowLeftFromLine size={12} />
              Blocked by
            </span>
            {blockedByIds.map((id) => {
              const depTask = taskMap.get(id);
              const isCompleted = depTask?.status === 'completed';
              return (
                <button
                  key={id}
                  type="button"
                  className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                    isCompleted
                      ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25'
                      : 'bg-yellow-500/15 text-yellow-300 hover:bg-yellow-500/25'
                  } cursor-pointer`}
                  title={depTask ? `#${id}: ${depTask.subject}` : `#${id}`}
                  onClick={() => handleDependencyClick(id)}
                >
                  #{id}
                </button>
              );
            })}
          </div>
        ) : null}

        {blocksIds.length > 0 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center gap-0.5 text-xs text-blue-400">
              <ArrowRightFromLine size={12} />
              Blocks
            </span>
            {blocksIds.map((id) => {
              const depTask = taskMap.get(id);
              const isCompleted = depTask?.status === 'completed';
              return (
                <button
                  key={id}
                  type="button"
                  className={`inline-flex items-center rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                    isCompleted
                      ? 'bg-emerald-500/15 text-emerald-400 hover:bg-emerald-500/25'
                      : 'bg-blue-500/15 text-blue-400 hover:bg-blue-500/25'
                  } cursor-pointer`}
                  title={depTask ? `#${id}: ${depTask.subject}` : `#${id}`}
                  onClick={() => handleDependencyClick(id)}
                >
                  #{id}
                </button>
              );
            })}
          </div>
        ) : null}

        {/* Review info */}
        {kanbanTaskState ? (
          <div className="flex items-center gap-2">
            {kanbanTaskState.reviewer ? (
              <span className="text-xs text-[var(--color-text-secondary)]">
                Reviewer: {kanbanTaskState.reviewer}
              </span>
            ) : null}
            {kanbanTaskState.errorDescription ? (
              <span className="text-xs text-red-400">{kanbanTaskState.errorDescription}</span>
            ) : null}
          </div>
        ) : null}

        {/* Comments */}
        <TaskCommentsSection
          teamName={teamName}
          taskId={currentTask.id}
          comments={currentTask.comments ?? []}
          members={members}
        />

        {/* Separator */}
        <div className="border-t border-[var(--color-border)]" />

        {/* Session Logs — sessions that reference this task */}
        <div className="min-w-0 overflow-hidden">
          <h4 className="mb-2 text-xs font-medium text-[var(--color-text-muted)]">
            Execution Logs
          </h4>
          <MemberLogsTab
            teamName={teamName}
            taskId={currentTask.id}
            taskOwner={currentTask.owner}
            taskStatus={currentTask.status}
          />
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={onClose}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
};
