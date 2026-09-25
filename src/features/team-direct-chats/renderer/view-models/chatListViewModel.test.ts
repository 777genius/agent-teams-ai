import { describe, expect, it } from 'vitest';

import { conversationScopeKey, createDirectScope } from '../../core/domain/conversationScope';

import { toChatListViewItems } from './chatListViewModel';

import type { ChatListItem } from '../../core/domain/buildChatList';

const aliceScope = createDirectScope('alice');
const message = {
  messageId: 'message-1',
  from: 'alice',
  to: 'user',
  text: 'last delivered message',
  timestamp: '2026-09-22T12:00:00.000Z',
  read: false,
} as never;
const item: ChatListItem = {
  scope: aliceScope,
  displayName: 'alice',
  member: { name: 'alice' },
  previewMessage: message,
  latestActivityTimestamp: '2026-09-22T12:00:00.000Z',
  unreadCount: 3,
  attentionCount: 1,
};

describe('toChatListViewItems draft projection', () => {
  it('adds an exact-scope draft without changing message activity or unread metadata', () => {
    const rows = toChatListViewItems(
      [item],
      'No messages',
      new Map([
        [
          conversationScopeKey(aliceScope),
          {
            preview: 'unsent draft',
            updatedAt: Date.parse('2026-09-22T13:00:00.000Z'),
            attachmentCount: 0,
            chipCount: 0,
            editorKind: 'plain' as const,
          },
        ],
      ])
    );
    expect(rows[0]).toEqual(
      expect.objectContaining({
        previewText: 'last delivered message',
        previewTimestamp: '2026-09-22T12:00:00.000Z',
        unreadCount: 3,
        attentionCount: 1,
        draft: expect.objectContaining({ preview: 'unsent draft' }),
      })
    );
  });

  it('does not project a draft from a different conversation', () => {
    const rows = toChatListViewItems(
      [item],
      'No messages',
      new Map([
        [
          conversationScopeKey(createDirectScope('bob')),
          {
            preview: 'bob only',
            updatedAt: 1,
            attachmentCount: 0,
            chipCount: 0,
            editorKind: 'plain' as const,
          },
        ],
      ])
    );
    expect(rows[0].draft).toBeUndefined();
  });
});
