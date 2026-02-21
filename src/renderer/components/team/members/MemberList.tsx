import { MemberCard } from './MemberCard';

import type { ResolvedTeamMember } from '@shared/types';

interface MemberListProps {
  members: ResolvedTeamMember[];
}

export const MemberList = ({ members }: MemberListProps): React.JSX.Element => {
  if (members.length === 0) {
    return (
      <div className="rounded-md border border-[var(--color-border)] p-4 text-sm text-[var(--color-text-muted)]">
        Участники не найдены
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-0.5">
      {members.map((member) => (
        <MemberCard key={member.name} member={member} />
      ))}
    </div>
  );
};
