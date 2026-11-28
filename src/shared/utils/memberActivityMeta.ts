import type { InboxMessage, MemberActivityMetaEntry } from '@shared/types/team';

export const MEMBER_ACTIVITY_META_WINDOW_LIMIT = 200;

function messageSignalsTermination(message: InboxMessage | null | undefined): boolean {
  if (!message) return false;
  try {
    const parsed = JSON.parse(message.text) as {
      type?: string;
      approve?: boolean;
      approved?: boolean;
    };
    return (
      (parsed.type === 'shutdown_response' &&
        (parsed.approve === true || parsed.approved === true)) ||
      parsed.type === 'shutdown_approved'
    );
  } catch {
    return false;
  }
}

/** Message facts from a captured newest-first window; not native runtime or launch authority. */
export function projectMemberActivityFacts(
  messages: readonly InboxMessage[]
): Record<string, MemberActivityMetaEntry> {
  const latestByMember = new Map<string, InboxMessage>();
  const countsByMember = new Map<string, number>();
  for (const message of messages) {
    const memberName = typeof message.from === 'string' ? message.from.trim() : '';
    if (!memberName || memberName === 'user' || memberName === 'system') continue;
    countsByMember.set(memberName, (countsByMember.get(memberName) ?? 0) + 1);
    if (!latestByMember.has(memberName)) latestByMember.set(memberName, message);
  }
  return Object.fromEntries(
    Array.from(new Set([...countsByMember.keys(), ...latestByMember.keys()]))
      .sort((left, right) => left.localeCompare(right))
      .map((memberName) => {
        const latestMessage = latestByMember.get(memberName) ?? null;
        return [
          memberName,
          {
            memberName,
            lastAuthoredMessageAt: latestMessage?.timestamp ?? null,
            messageCountExact: countsByMember.get(memberName) ?? 0,
            latestAuthoredMessageSignalsTermination: messageSignalsTermination(latestMessage),
          },
        ] as const;
      })
  );
}
