import { toChatListViewItems } from '@features/team-direct-chats/renderer';

import type { AttentionChat } from '../../core/domain/buildAttention';
import type { ChatListViewItem } from '@features/team-direct-chats/renderer';

export function toAttentionChatRow(chat: AttentionChat): ChatListViewItem {
  // Reuse Messenger's canonical presentation (sender attribution,
  // sanitized previews, avatars and unread styling) rather than cloning it.
  return toChatListViewItems([
    {
      scope: chat.scope,
      displayName: chat.name,
      member: chat.scope.kind === 'direct' ? { name: chat.name } : undefined,
      previewMessage: chat.latestUnread,
      latestActivityTimestamp: chat.latestUnread.timestamp,
      unreadCount: chat.unreadCount,
      attentionCount: chat.unreadCount,
    },
  ], '')[0];
}

export function relativeAttentionAge(
  timestamp: string | null | undefined,
  now: number,
  language = 'en',
  unknownText = 'Time unknown'
): string {
  const time = Date.parse(timestamp ?? '');
  if (!Number.isFinite(time)) return unknownText;
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto', style: 'short' });
  if (minutes < 1) return format.format(0, 'minute');
  if (minutes < 60) return format.format(-minutes, 'minute');
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return format.format(-hours, 'hour');
  return format.format(-Math.floor(hours / 24), 'day');
}
