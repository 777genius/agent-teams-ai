import { Badge } from '@renderer/components/ui/badge';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { agentAvatarUrl, getMemberDotClass, getPresenceLabel } from '@renderer/utils/memberHelpers';
import { ListPlus, Loader2, MessageSquare } from 'lucide-react';

import type { TaskStatusCounts } from '@renderer/utils/pathNormalize';
import type { ResolvedTeamMember, TeamTask } from '@shared/types';

interface MemberCardProps {
  member: ResolvedTeamMember;
  memberColor: string;
  taskCounts?: TaskStatusCounts | null;
  isTeamAlive?: boolean;
  currentTask?: TeamTask | null;
  isAwaitingReply?: boolean;
  onOpenTask?: () => void;
  onClick?: () => void;
  onSendMessage?: () => void;
  onAssignTask?: () => void;
}

export const MemberCard = ({
  member,
  memberColor,
  taskCounts,
  isTeamAlive,
  currentTask,
  isAwaitingReply,
  onOpenTask,
  onClick,
  onSendMessage,
  onAssignTask,
}: MemberCardProps): React.JSX.Element => {
  const dotClass = getMemberDotClass(member, isTeamAlive);
  const presenceLabel = getPresenceLabel(member, isTeamAlive);
  const colors = getTeamColorSet(memberColor);
  const pending = taskCounts?.pending ?? 0;
  const inProgress = taskCounts?.inProgress ?? 0;
  const completed = taskCounts?.completed ?? 0;
  const totalTasks = pending + inProgress + completed;
  const completedRatio = totalTasks > 0 ? completed / totalTasks : 0;

  const progressPercent = Math.round(completedRatio * 100);

  return (
    <div className="rounded">
      <div
        className="group relative cursor-pointer rounded-t px-2 py-1.5"
        style={{
          borderLeft: `3px solid ${colors.border}`,
          backgroundColor: colors.badge,
        }}
        title={member.currentTaskId ? `Current task: ${member.currentTaskId}` : undefined}
        role="button"
        tabIndex={0}
        onClick={onClick}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            onClick?.();
          }
        }}
      >
        <div className="pointer-events-none absolute inset-0 rounded-t transition-colors group-hover:bg-white/5" />
        <div className="flex items-center gap-2.5">
          <div className="relative shrink-0">
            <img
              src={agentAvatarUrl(member.name)}
              alt={member.name}
              className="size-7 rounded-full bg-[var(--color-surface-raised)]"
              loading="lazy"
            />
            <span
              className={`absolute -bottom-0.5 -right-0.5 size-2.5 rounded-full border-2 border-[var(--color-surface)] ${dotClass}`}
              aria-label={member.status}
            />
          </div>
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-[var(--color-text)]">
            {member.name}
          </span>
          {(() => {
            const roleLabel = formatAgentRole(member.role) ?? formatAgentRole(member.agentType);
            return roleLabel ? (
              <span className="hidden shrink-0 text-xs text-[var(--color-text-muted)] sm:inline">
                {roleLabel}
              </span>
            ) : null;
          })()}
          <Badge
            variant="secondary"
            className="shrink-0 px-1.5 py-0.5 text-[10px] font-normal leading-none text-[var(--color-text-muted)]"
            title={member.currentTaskId ? `Current task: ${member.currentTaskId}` : undefined}
          >
            {presenceLabel}
          </Badge>
          <Badge
            variant="secondary"
            className="shrink-0 px-1.5 py-0.5 text-[10px] font-normal leading-none"
          >
            {member.taskCount} {member.taskCount === 1 ? 'task' : 'tasks'}
          </Badge>
          <div className="flex shrink-0 items-center gap-0.5">
            <button
              type="button"
              className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
              title="Send message"
              onClick={(e) => {
                e.stopPropagation();
                onSendMessage?.();
              }}
            >
              <MessageSquare size={13} />
            </button>
            <button
              type="button"
              className="rounded p-1 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface)] hover:text-[var(--color-text)]"
              title="Assign task"
              onClick={(e) => {
                e.stopPropagation();
                onAssignTask?.();
              }}
            >
              <ListPlus size={13} />
            </button>
          </div>
        </div>

        {currentTask ? (
          <div className="mt-1 flex items-center gap-2 pl-9 text-[10px] text-[var(--color-text-muted)]">
            <Loader2 className="size-3 animate-spin" style={{ color: colors.border }} />
            <span className="truncate">working on</span>
            <button
              type="button"
              className="truncate rounded px-1.5 py-0.5 text-[10px] font-medium text-[var(--color-text)] transition-opacity hover:opacity-90 focus:outline-none focus:ring-1 focus:ring-[var(--color-border)]"
              style={{ border: `1px solid ${colors.border}40` }}
              title="Open task"
              onClick={(e) => {
                e.stopPropagation();
                onOpenTask?.();
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
                  e.stopPropagation();
                  e.preventDefault();
                }
              }}
            >
              #{currentTask.id} {currentTask.subject.slice(0, 36)}
              {currentTask.subject.length > 36 ? '…' : ''}
            </button>
          </div>
        ) : null}

        {!currentTask && isAwaitingReply ? (
          <div className="mt-1 flex items-center gap-2 pl-9 text-[10px] text-[var(--color-text-muted)]">
            <Loader2 className="size-3 animate-spin" style={{ color: colors.border }} />
            <span className="truncate">awaiting reply</span>
          </div>
        ) : null}
      </div>
      <div
        className="h-0.5 rounded-b bg-[var(--color-border)]"
        role="progressbar"
        aria-valuenow={completed}
        aria-valuemin={0}
        aria-valuemax={totalTasks}
        aria-label={`Tasks ${completed}/${totalTasks} completed`}
        title={`${completed}/${totalTasks} tasks`}
        style={{
          background: `linear-gradient(to right, #10b981 ${progressPercent}%, var(--color-border) ${progressPercent}%)`,
        }}
      />
    </div>
  );
};
