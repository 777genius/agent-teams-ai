import { describe, expect, it } from 'vitest';

import { conversationScopeKey, createDirectScope } from '../../core/domain/conversationScope';

import {
  getChatMessagePreview,
  projectChatPreview,
  toChatListViewItems,
} from './chatListViewModel';

import type { ChatListItem } from '../../core/domain/buildChatList';
import type { ChatListDraftPreview } from './chatListViewModel';
import type { InboxMessage } from '@shared/types';

const aliceScope = createDirectScope('alice');
const message: InboxMessage = {
  messageId: 'message-1',
  from: 'alice',
  to: 'user',
  text: 'last delivered message',
  timestamp: '2026-09-22T12:00:00.000Z',
  read: false,
};
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

describe('shared chat preview presentation', () => {
  it.each(['openui', 'openui-lang', 'mermaid'])(
    'summarizes %s fences before flattening and truncating message previews',
    (language) => {
      const label = language === 'mermaid' ? 'Diagram' : 'Visualization';
      for (const closing of ['', '\n```']) {
        const text = `Report\n\n\`\`\`${language}\nprivateVisualizationSource${'x'.repeat(100)}${closing}`;
        expect(getChatMessagePreview({ ...message, text }, 'No messages')).toEqual({
          previewText: `Report ${label}`,
          previewFrom: 'alice',
        });
        expect(
          getChatMessagePreview({ ...message, text: 'Fallback body', summary: text }, 'No messages')
        ).toEqual({ previewText: `Report ${label}`, previewFrom: 'alice' });
      }
    }
  );

  it('preserves ordinary fenced code in message previews', () => {
    expect(
      getChatMessagePreview({ ...message, text: '```ts\nconst count = 2;\n```' }, 'No messages')
        .previewText
    ).toBe('```ts const count = 2; ```');
  });

  const selected = {
    ...getChatMessagePreview(message, 'No messages'),
    previewTimestamp: item.latestActivityTimestamp,
  };
  const draft: ChatListDraftPreview = {
    preview: '  current\n draft  ',
    updatedAt: Date.parse('2026-09-22T13:00:00.000Z'),
    attachmentCount: 0,
    chipCount: 0,
    editorKind: 'plain',
  };

  it('uses draft text and time, then returns to the selected message when draft disappears', () => {
    expect(projectChatPreview(selected, draft)).toEqual({
      previewText: 'current draft',
      previewFrom: null,
      previewTimestamp: '2026-09-22T13:00:00.000Z',
      isDraft: true,
    });
    expect(projectChatPreview(selected, undefined)).toEqual({
      previewText: 'last delivered message',
      previewFrom: 'alice',
      previewTimestamp: '2026-09-22T12:00:00.000Z',
      isDraft: false,
    });
    expect(
      projectChatPreview(selected, { ...draft, updatedAt: Infinity }).previewTimestamp
    ).toBeNull();
    expect(projectChatPreview(selected, { ...draft, preview: '', attachmentCount: 2 })).toEqual(
      expect.objectContaining({ previewText: '', isDraft: true, previewFrom: null })
    );
  });

  it('sanitizes selected canonical message content and truncates normalized text', () => {
    const internal: InboxMessage = {
      from: 'system',
      to: 'alice',
      text: 'Human: You have new inbox messages addressed to you (team lead alice).\nProcess them in order (oldest first).\nMessages: secret runtime instructions',
      timestamp: '2026-09-22T12:00:00.000Z',
      read: true,
      source: 'lead_process',
    };
    expect(getChatMessagePreview(internal, 'No messages').previewText).toBe(
      'Internal control message'
    );
    expect(
      getChatMessagePreview(
        { ...internal, from: 'alice', text: 'hello  \n' + 'x'.repeat(100) },
        'No messages'
      )
    ).toEqual({
      previewText: 'hello ' + 'x'.repeat(81) + '…',
      previewFrom: 'alice',
    });
    expect(
      getChatMessagePreview({ ...internal, text: '   ', from: 'alice' }, 'No messages')
    ).toEqual({
      previewText: 'No messages',
      previewFrom: null,
    });
  });
});
