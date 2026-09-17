import { useAppTranslation } from '@features/localization/renderer';

import { ChatListRow } from './ChatListRow';

import type { ConversationScope } from '../../core/domain/conversationScope';
import type { ChatListViewItem } from '../view-models/chatListViewModel';
import type { JSX } from 'react';

interface ChatListProps {
  items: readonly ChatListViewItem[];
  teamName: string;
  onOpen: (scope: ConversationScope) => void;
}

export const ChatList = ({ items, teamName, onOpen }: ChatListProps): JSX.Element => {
  const { t } = useAppTranslation('team');
  if (items.length === 0) {
    return (
      <p className="px-3 py-6 text-center text-xs text-[var(--color-text-muted)]">
        {t('messages.chats.emptyList')}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-0.5 overflow-visible px-1 pb-3">
      {items.map((item) => (
        <ChatListRow
          key={item.scope.kind === 'team-feed' ? 'team-feed' : `direct:${item.displayName}`}
          item={item}
          teamName={teamName}
          onOpen={onOpen}
        />
      ))}
    </div>
  );
};
