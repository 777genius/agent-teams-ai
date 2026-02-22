import { Badge } from '@renderer/components/ui/badge';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';
import { agentAvatarUrl, getMemberDotClass, getPresenceLabel } from '@renderer/utils/memberHelpers';
import { ListPlus, MessageSquare } from 'lucide-react';

import type { ResolvedTeamMember } from '@shared/types';

interface MemberCardProps {
  member: ResolvedTeamMember;
  isTeamAlive?: boolean;
  onClick?: () => void;
  onSendMessage?: () => void;
  onAssignTask?: () => void;
}

export const MemberCard = ({
  member,
  isTeamAlive,
  onClick,
  onSendMessage,
  onAssignTask,
}: MemberCardProps): React.JSX.Element => {
  const dotClass = getMemberDotClass(member, isTeamAlive);
  const presenceLabel = getPresenceLabel(member, isTeamAlive);

  return (
    <div
      className="group flex cursor-pointer items-center gap-2.5 rounded px-2 py-1.5 hover:bg-[var(--color-surface-raised)]"
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
  );
};
