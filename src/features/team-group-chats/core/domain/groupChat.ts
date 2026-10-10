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

/** Resolve the physical destination without changing the shared conversation. */
export function groupSendRecipients(
  memberNames: readonly string[],
  from: string,
  recipientName?: string
): string[] {
  if (recipientName !== undefined) {
    if (!memberNames.includes(recipientName))
      throw new GroupChatError('invalid-recipient', 'Recipient is not a current chat member');
    return [recipientName];
  }
  return memberNames.filter((name) => name !== from);
}

/** Human All posts always freeze at least two recipients; directed posts freeze one. */
export function matchesHumanGroupTarget(
  frozenRecipientNames: readonly string[],
  recipientName?: string
): boolean {
  return recipientName === undefined
    ? frozenRecipientNames.length >= 2
    : frozenRecipientNames.length === 1 && frozenRecipientNames[0] === recipientName;
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
