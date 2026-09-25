import { belongsToConversation, type ConversationScope } from '@features/team-direct-chats/renderer';

import type { InboxMessage, ToolApprovalRequest } from '@shared/types';

/**
 * Pending replies are stored by destination member until their inbox row is
 * available. Classify that outgoing route with the same rule as chat history,
 * so a wait appears in its direct chat and in the team feed, never in another
 * participant's chat.
 */
export function pendingRepliesForConversation(
  pendingRepliesByMember: Record<string, number>,
  scope: ConversationScope,
  leadNames: Iterable<string>
): Record<string, number> {
  if (scope.kind === 'team-feed') return pendingRepliesByMember;

  return Object.fromEntries(
    Object.entries(pendingRepliesByMember).filter(([memberName]) =>
      belongsToConversation(
        {
          from: 'user',
          to: memberName,
          text: '',
          timestamp: '',
          read: false,
          source: 'user_sent',
        } satisfies InboxMessage,
        scope,
        leadNames
      )
    )
  );
}

/** Tool approvals have no message row, but do have a team and runtime source. */
export function pendingApprovalsForConversation(
  approvals: readonly ToolApprovalRequest[],
  teamName: string | undefined,
  scope: ConversationScope,
  leadNames: Iterable<string>
): ToolApprovalRequest[] {
  return approvals.filter((approval) => {
    if (teamName && approval.teamName !== teamName) return false;
    if (scope.kind === 'team-feed') return true;
    return belongsToConversation(
      {
        from: approval.source,
        to: 'user',
        text: '',
        timestamp: approval.receivedAt,
        read: false,
      } satisfies InboxMessage,
      scope,
      leadNames
    );
  });
}
