import { describe, expect, it } from 'vitest';

import { buildChatListView } from '@features/team-direct-chats/renderer/view-models/chatListViewModel';

import { msg, toTestKey } from '../core/domain/fixtures';

describe('buildChatListView preview attribution', () => {
  it('keeps the sender on This team so the row can show alice: text', () => {
    const rows = buildChatListView({
      members: [
        { name: 'oscar', agentType: 'team-lead' },
        { name: 'alice' },
      ],
      messages: [
        msg({
          from: 'alice',
          to: 'user',
          text: 'nice, work, guys',
          messageId: 'dm',
        }),
      ],
      readSet: new Set(),
      toKey: toTestKey,
      teamFeedLabel: 'This team',
      emptyPreview: 'No messages yet',
      leadNames: ['oscar'],
    });

    expect(rows[0]?.previewFrom).toBe('alice');
    expect(rows[0]?.previewText).toBe('nice, work, guys');
    expect(rows.find((row) => row.displayName === 'alice')?.previewFrom).toBe('alice');
  });

  it('reorders DMs by activity when sortByActivity is on', () => {
    const rows = buildChatListView({
      members: [
        { name: 'oscar', agentType: 'team-lead' },
        { name: 'alice' },
        { name: 'cody' },
      ],
      messages: [
        msg({
          from: 'user',
          to: 'cody',
          text: 'just sent',
          timestamp: '2026-09-17T18:00:00.000Z',
          messageId: 'out',
        }),
      ],
      readSet: new Set(),
      toKey: toTestKey,
      teamFeedLabel: 'This team',
      emptyPreview: 'No messages yet',
      leadNames: ['oscar'],
      sortByActivity: true,
    });
    expect(rows.map((row) => row.displayName)).toEqual(['This team', 'cody', 'oscar', 'alice']);
  });

  it('does not invent a sender for empty chats', () => {
    const rows = buildChatListView({
      members: [{ name: 'oscar', agentType: 'team-lead' }],
      messages: [],
      readSet: new Set(),
      toKey: toTestKey,
      teamFeedLabel: 'This team',
      emptyPreview: 'No messages yet',
      leadNames: ['oscar'],
    });
    expect(rows[0]?.previewFrom).toBeNull();
    expect(rows[0]?.previewText).toBe('No messages yet');
  });
});
