import { MemberCard } from './MemberCard';

import type { ResolvedTeamMember } from '@shared/types';

interface MemberListProps {
  members: ResolvedTeamMember[];
  isTeamAlive?: boolean;
  onMemberClick?: (member: ResolvedTeamMember) => void;
  onSendMessage?: (member: ResolvedTeamMember) => void;
  onAssignTask?: (member: ResolvedTeamMember) => void;
}

export const MemberList = ({
  members,
  isTeamAlive,
  onMemberClick,
  onSendMessage,
  onAssignTask,
}: MemberListProps): React.JSX.Element => {
  if (members.length === 0) {
    return (
      <div className="rounded-md border border-[var(--color-border)] p-4 text-sm text-[var(--color-text-muted)]">
        No members found
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {members.map((member) => (
        <MemberCard
          key={member.name}
          member={member}
          isTeamAlive={isTeamAlive}
          onClick={() => onMemberClick?.(member)}
          onSendMessage={() => onSendMessage?.(member)}
          onAssignTask={() => onAssignTask?.(member)}
        />
      ))}
    </div>
  );
};
