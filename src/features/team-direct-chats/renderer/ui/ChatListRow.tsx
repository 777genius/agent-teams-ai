import { useAppTranslation } from '@features/localization/renderer';
import { formatActivityTimestamp } from '@renderer/components/team/activity/activityTimestamp';
import { MemberIdentityAvatar } from '@renderer/components/team/members/MemberIdentityAvatar';
import { displayMemberName } from '@renderer/utils/memberHelpers';
import { MessageSquare } from 'lucide-react';

import { useChatMemberIdentity } from '../hooks/useChatMemberIdentity';

import { ChatPreviewLine } from './ChatPreviewLine';
import { ChatUnreadBadges } from './ChatUnreadBadges';

import type { ConversationScope } from '../../core/domain/conversationScope';
import type { ChatListViewItem } from '../view-models/chatListViewModel';
import type { JSX } from 'react';

interface ChatListRowProps {
  item: ChatListViewItem;
  teamName: string;
  onOpen: (scope: ConversationScope) => void;
}

export const ChatListRow = ({ item, teamName, onOpen }: ChatListRowProps): JSX.Element => {
  const { t } = useAppTranslation('team');
  const preview = item.previewText || t('messages.chats.emptyPreview');
  const time = item.previewTimestamp ? formatActivityTimestamp(item.previewTimestamp) : '';
  const memberName = item.member?.name ?? item.displayName;
  const identity = useChatMemberIdentity(teamName, memberName, item.member?.color);
  const title =
    item.scope.kind === 'direct' ? displayMemberName(item.displayName) : item.displayName;

  return (
    <button
      type="button"
      className="flex w-full items-start gap-2.5 overflow-visible rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--color-surface-raised)]"
      aria-label={t('messages.chats.rowAria', {
        name: title,
        unread: item.unreadCount,
        attention: item.attentionCount,
      })}
      onClick={() => onOpen(item.scope)}
    >
      <span className="mt-0.5 shrink-0">
        {item.scope.kind === 'team-feed' ? (
          <span className="flex size-[34px] items-center justify-center rounded-full bg-[var(--color-surface-raised)] text-[var(--color-text-muted)]">
            <MessageSquare size={14} />
          </span>
        ) : (
          <MemberIdentityAvatar
            name={identity.name}
            color={identity.color}
            avatarUrl={identity.avatarUrl}
            presenceClass={identity.presenceClass}
            presenceLabel={identity.presenceLabel}
          />
        )}
      </span>
      <span className="min-w-0 flex-1 overflow-hidden">
        <span className="block min-w-0 truncate text-sm font-medium text-[var(--color-text)]">
          {title}
        </span>
        <ChatPreviewLine
          from={item.previewFrom}
          text={preview}
          avatarUrl={item.previewFrom ? identity.avatarUrlFor(item.previewFrom) : undefined}
        />
      </span>
      <span className="mt-0.5 flex shrink-0 flex-col items-end gap-1 overflow-visible">
        {time ? (
          <span className="text-[10px] tabular-nums text-[var(--color-text-muted)]">{time}</span>
        ) : null}
        <ChatUnreadBadges unreadCount={item.unreadCount} attentionCount={item.attentionCount} />
      </span>
    </button>
  );
};
