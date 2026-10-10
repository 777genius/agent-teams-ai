import type { GroupMembership } from '../../contracts';

export interface GroupChat {
  id: string;
  name: string;
  createdAt: string;
  membership: GroupMembership;
  archivedAt: string | null;
}

export function effectiveGroupMembers(group: GroupChat, roster: readonly string[]): string[] {
  const selected = new Set(
    group.membership.kind === 'fixed'
      ? group.membership.memberNames
      : group.membership.excludedMemberNames
  );
  return roster.filter((name) =>
    group.membership.kind === 'fixed' ? selected.has(name) : !selected.has(name)
  );
}

export class GroupChatError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
    this.name = 'GroupChatError';
  }
}
