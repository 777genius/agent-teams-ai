import { useEffect, useRef, useState } from 'react';

import { ChatList } from '@features/team-direct-chats/renderer';
import { CreateGroupChatDialog, GroupChatList } from '@features/team-group-chats/renderer';

import type { useMessagesGroupConversation } from './useMessagesGroupConversation';
import type { ConversationScope } from '@features/team-direct-chats/renderer';
import type { InboxMessage, ResolvedTeamMember } from '@shared/types';

/** Owns creation-dialog lifetime independently of the existing DM navigation. */
const MessagesGroupNavigation = ({
  conversation, teamName, members, messages, readSet, selectedScope, isTeamAlive, onOpen,
}: Readonly<{
  conversation: ReturnType<typeof useMessagesGroupConversation>;
  teamName: string;
  members: ResolvedTeamMember[];
  messages: InboxMessage[];
  readSet: Set<string>;
  selectedScope?: ConversationScope;
  isTeamAlive?: boolean;
  onOpen: (scope: ConversationScope) => void;
}>) => {
  const [creating, setCreating] = useState(false);
  const dialogGeneration = useRef(0);
  const generation = dialogGeneration.current;
  const active = useRef(true);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  return (
    <>
      <GroupChatList groups={conversation.catalog.groups} messages={messages} readSet={readSet}
        selectedScope={selectedScope} onOpen={onOpen} onCreate={() => { dialogGeneration.current++; setCreating(true); }}
        error={conversation.catalog.error} />
      {creating ? <CreateGroupChatDialog teamName={teamName} members={members.filter((m) => !m.removedAt)}
        isTeamAlive={isTeamAlive} create={conversation.catalog.create} onClose={() => { if (generation === dialogGeneration.current) { dialogGeneration.current++; setCreating(false); } }}
        onCreated={(group) => { if (active.current && generation === dialogGeneration.current) onOpen({ kind: 'group', groupChatId: group.id }); }} /> : null}
    </>
  );
}

export const MessagesConversationList = ({ items, ...props }:
  Readonly<React.ComponentProps<typeof MessagesGroupNavigation> & {
    items: React.ComponentProps<typeof ChatList>['items'];
  }>) => {
  return <>
    <ChatList items={items} teamName={props.teamName} selectedScope={props.selectedScope} onOpen={props.onOpen} />
    <MessagesGroupNavigation {...props} />
  </>;
}
