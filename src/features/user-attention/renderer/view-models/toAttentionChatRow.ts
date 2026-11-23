import { getChatMessagePreview } from '@features/team-direct-chats/renderer';

import type { AttentionChat } from '../../core/domain/buildAttention';
import type { ChatListViewItem } from '@features/team-direct-chats/renderer';

export function toAttentionChatRow(chat: AttentionChat): ChatListViewItem {
  const preview = getChatMessagePreview(chat.latestUnread, '');
  return {
    scope: chat.scope,
    displayName: chat.name,
    member: chat.scope.kind === 'direct' ? { name: chat.name } : undefined,
    unreadCount: chat.unreadCount,
    attentionCount: chat.unreadCount,
    previewTimestamp: chat.latestUnread.timestamp,
    ...preview,
  };
}

export function relativeAttentionAge(timestamp: string | null | undefined, now: number): string {
  const time = Date.parse(timestamp ?? '');
  if (!Number.isFinite(time)) return 'Time unknown';
  const minutes = Math.max(0, Math.floor((now - time) / 60_000));
  if (minutes < 1) return 'Just now';
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
