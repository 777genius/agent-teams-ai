import { Badge } from '@renderer/components/ui/badge';
import { getTeamColorSet } from '@renderer/constants/teamColors';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { agentAvatarUrl, getMemberDotClass, getPresenceLabel } from '@renderer/utils/memberHelpers';
import { ListPlus, MessageSquare } from 'lucide-react';

import type { TaskStatusCounts } from '@renderer/utils/pathNormalize';
import type { ResolvedTeamMember } from '@shared/types';

interface MemberCardProps {
  member: ResolvedTeamMember;
  memberColor: string;
  taskCounts?: TaskStatusCounts | null;
  isTeamAlive?: boolean;
  onClick?: () => void;
  onSendMessage?: () => void;
  onAssignTask?: () => void;
}

export const MemberCard = ({
  member,
  memberColor,
  taskCounts,
  isTeamAlive,
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

  return (
    <div className="rounded">
      <div
        className="group relative flex cursor-pointer items-center gap-2.5 rounded-t px-2 py-1.5"
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
            title="Send Message"
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
            title="Assign Task"
            onClick={(e) => {
              e.stopPropagation();
              onAssignTask?.();
            }}
          >
            <ListPlus size={13} />
          </button>
        </div>
      </div>
      <div className="rounded-b border-x border-b border-t-0 border-[var(--color-border)] bg-[var(--color-surface)] px-2 py-1">
        <div className="flex items-center gap-2">
          <div
            className="h-1.5 min-w-0 flex-1 overflow-hidden rounded-full bg-[var(--color-surface-raised)]"
            role="progressbar"
            aria-valuenow={completed}
            aria-valuemin={0}
            aria-valuemax={totalTasks}
            aria-label={`Tasks ${completed}/${totalTasks} completed`}
          >
            <div
              className="h-full rounded-full bg-emerald-500 transition-all duration-200"
              style={{ width: `${Math.round(completedRatio * 100)}%` }}
            />
          </div>
          <span className="shrink-0 text-[10px] font-medium tabular-nums text-[var(--color-text-muted)]">
            {completed}/{totalTasks}
          </span>
        </div>
      </div>
    </div>
  );
};
