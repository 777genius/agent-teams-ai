import { type ButtonHTMLAttributes, forwardRef, type MouseEvent } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { formatActivityTimestamp } from '@renderer/components/team/activity/activityTimestamp';
import { MemberIdentityAvatar } from '@renderer/components/team/members/MemberIdentityAvatar';
import { displayMemberName } from '@renderer/utils/memberHelpers';
import { Pin } from 'lucide-react';

import { useChatMemberIdentity } from '../hooks/useChatMemberIdentity';

import { ChatPreviewLine } from './ChatPreviewLine';
import { ChatUnreadBadges } from './ChatUnreadBadges';
import { GroupChatAvatar } from './GroupChatAvatar';

import type { ConversationScope } from '../../core/domain/conversationScope';
import type { ChatListViewItem } from '../view-models/chatListViewModel';

interface ChatListRowProps extends Omit<
  ButtonHTMLAttributes<HTMLButtonElement>,
  'type' | 'children'
> {
  item: ChatListViewItem;
  teamName: string;
  pinned?: boolean;
  onOpen: (scope: ConversationScope) => void;
}

export const ChatListRow = forwardRef<HTMLButtonElement, ChatListRowProps>(
  ({ item, teamName, pinned = false, onOpen, className, onClick, ...props }, ref) => {
    const { t } = useAppTranslation('team');
    const draftPreview = item.draft
      ? item.draft.preview ||
        [
          item.draft.chipCount > 0
            ? t('messages.chats.draftReferences', { count: item.draft.chipCount })
            : '',
          item.draft.attachmentCount > 0
            ? t('messages.chats.draftAttachments', { count: item.draft.attachmentCount })
            : '',
        ]
          .filter(Boolean)
          .join(', ')
      : '';
    const preview = item.draft
      ? draftPreview
      : item.previewText || t('messages.chats.emptyPreview');
    const draftDate =
      typeof item.draft?.updatedAt === 'number' ? new Date(item.draft.updatedAt) : null;
    const timestamp = item.draft
      ? draftDate && Number.isFinite(draftDate.getTime())
        ? draftDate.toISOString()
        : null
      : item.previewTimestamp;
    const time = timestamp ? formatActivityTimestamp(timestamp) : '';
    const memberName = item.member?.name ?? item.displayName;
    const identity = useChatMemberIdentity(teamName, memberName, item.member?.color);
    const title =
      item.scope.kind === 'direct' ? displayMemberName(item.displayName) : item.displayName;
    const ariaLabel = pinned
      ? `${t('messages.chats.rowAria', {
          name: title,
          unread: item.unreadCount,
          attention: item.attentionCount,
        })}, ${t('messages.chats.pinned')}`
      : t('messages.chats.rowAria', {
          name: title,
          unread: item.unreadCount,
          attention: item.attentionCount,
        });

    return (
      <button
        type="button"
        {...props}
        ref={ref}
        className={`flex w-full items-start gap-2.5 overflow-visible rounded-md px-2 py-2 text-left transition-colors hover:bg-[var(--color-surface-raised)]${className ? ` ${className}` : ''}`}
        aria-label={ariaLabel}
        onClick={(event: MouseEvent<HTMLButtonElement>) => {
          onClick?.(event);
          if (event.defaultPrevented) {
            return;
          }
          onOpen(item.scope);
        }}
      >
        <span className="mt-0.5 shrink-0">
          {item.scope.kind === 'team-feed' ? (
            <GroupChatAvatar />
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
            from={item.draft ? null : item.previewFrom}
            text={preview}
            avatarUrl={
              !item.draft && item.previewFrom ? identity.avatarUrlFor(item.previewFrom) : undefined
            }
            draft={item.draft != null}
          />
        </span>
        <span className="mt-0.5 flex shrink-0 flex-col items-end gap-1 overflow-visible">
          <span className="flex items-center gap-1">
            {pinned ? (
              <Pin size={10} className="text-[var(--color-text-muted)]" aria-hidden="true" />
            ) : null}
            {time ? (
              <span className="text-[10px] tabular-nums text-[var(--color-text-muted)]">
                {time}
              </span>
            ) : null}
          </span>
          <ChatUnreadBadges unreadCount={item.unreadCount} attentionCount={item.attentionCount} />
        </span>
      </button>
    );
  }
);

ChatListRow.displayName = 'ChatListRow';
