import { Badge } from '@renderer/components/ui/badge';
import { formatAgentRole } from '@renderer/utils/formatAgentRole';

import type { ResolvedTeamMember } from '@shared/types';

interface MemberCardProps {
  member: ResolvedTeamMember;
}

const statusDotColor: Record<string, string> = {
  active: 'bg-emerald-400',
  idle: 'bg-emerald-400/50',
  terminated: 'bg-zinc-500',
  unknown: 'bg-zinc-600',
};

export const MemberCard = ({ member }: MemberCardProps): React.JSX.Element => {
  const dotClass =
    member.status === 'terminated'
      ? statusDotColor.terminated
      : member.currentTaskId
        ? statusDotColor.active
        : statusDotColor.idle;
  const avatarUrl = `https://robohash.org/${encodeURIComponent(member.name)}?size=64x64`;
  const presenceLabel =
    member.status === 'terminated' ? 'terminated' : member.currentTaskId ? 'working' : 'idle';

  return (
    <div
      className="group flex items-center gap-2.5 rounded px-2 py-1.5 hover:bg-[var(--color-surface-raised)]"
      title={member.currentTaskId ? `Текущая задача: ${member.currentTaskId}` : undefined}
    >
      <div className="relative shrink-0">
        <img
          src={avatarUrl}
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
      {formatAgentRole(member.agentType) && (
        <span className="hidden shrink-0 text-xs text-[var(--color-text-muted)] sm:inline">
          {formatAgentRole(member.agentType)}
        </span>
      )}
      <Badge
        variant="secondary"
        className="shrink-0 px-1.5 py-0.5 text-[10px] font-normal leading-none text-[var(--color-text-muted)]"
        title={member.currentTaskId ? `Текущая задача: ${member.currentTaskId}` : undefined}
      >
        {presenceLabel}
      </Badge>
      <Badge
        variant="secondary"
        className="shrink-0 px-1.5 py-0.5 text-[10px] font-normal leading-none"
      >
        {member.taskCount} {member.taskCount === 1 ? 'task' : 'tasks'}
      </Badge>
    </div>
  );
};
