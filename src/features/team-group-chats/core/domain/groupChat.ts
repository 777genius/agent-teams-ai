import type { GroupMembership } from '../../contracts';

/** Private immutable admission and payload, unaffected by later membership or archive changes. */
export interface AgentGroupCreation {
  sourceMessageId: string;
  recipientNames: string[];
  payload: {
    name: string;
    selectedMemberNames: string[];
    autoIncludeNewMembers: boolean;
  };
}

export interface GroupChat {
  id: string;
  name: string;
  createdAt: string;
  membership: GroupMembership;
  archivedAt: string | null;
  agentCreation?: AgentGroupCreation;
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

/** Canonical targets are UUIDs; physical inbox identities also include a recipient suffix. */
export function isGroupUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/i.test(
      value
    )
  );
}

export function isGroupPhysicalId(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_.:-]{0,199}$/.test(value);
}
