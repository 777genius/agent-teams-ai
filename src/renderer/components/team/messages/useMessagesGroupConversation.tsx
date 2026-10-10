import {
  GroupChatArchiveAction,
  GroupChatComposer,
  useGroupChatComposer,
  useGroupChatHistory,
  useTeamGroupChats,
} from '@features/team-group-chats/renderer';

import type { ConversationScope } from '@features/team-direct-chats/renderer';
import type { InboxMessage, ResolvedTeamMember } from '@shared/types';

/** Joins the group catalog, durable history and draft for one conversation. */
export function useMessagesGroupConversation(
  teamName: string,
  contextId: string,
  members: ResolvedTeamMember[],
  scope: ConversationScope
) {
  const groupId = scope.kind === 'group' ? scope.groupChatId : undefined;
  const catalog = useTeamGroupChats(teamName, contextId, members.map((m) => m.name).join('\0'));
  const history = useGroupChatHistory(teamName, contextId, groupId);
  const group = catalog.groups.find((item) => item.id === groupId);
  const composer = useGroupChatComposer(
    teamName,
    contextId,
    groupId ?? '',
    history.refresh,
    group?.name
  );
  const archiveAction = groupId ? (
    <GroupChatArchiveAction key={groupId} group={group} setArchived={catalog.setArchived} />
  ) : undefined;
  const saved = history.messages.findLast((message) => message.from === 'user');
  const renderComposer = (controls?: React.ReactNode) => (
    <GroupChatComposer
      group={group}
      composer={composer}
      controls={controls}
      savedResult={
        saved?.messageId && groupId
          ? {
              saved: true,
              groupChatId: groupId,
              messageId: saved.messageId,
              statusPersisted: !!saved.groupDeliverySummary,
              deliverySummary: saved.groupDeliverySummary,
            }
          : undefined
      }
    />
  );
  const quote = (message: InboxMessage) => {
    if (composer.ready && !composer.attemptId && !composer.pending && !group?.archivedAt)
      composer.change(
        `${message.text
          .split('\n')
          .map((line) => `> ${line}`)
          .join('\n')}\n\n${composer.text}`
      );
  };
  return { groupId, group, catalog, history, composer, archiveAction, renderComposer, quote };
}
