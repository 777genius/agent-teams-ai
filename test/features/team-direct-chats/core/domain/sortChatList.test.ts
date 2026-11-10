import { describe, expect, it } from 'vitest';

import { buildChatList } from '@features/team-direct-chats/core/domain/buildChatList';
import { conversationScopeKey } from '@features/team-direct-chats/core/domain/conversationScope';
import { sortChatListItems } from '@features/team-direct-chats/core/domain/sortChatList';

import { msg, toTestKey } from './fixtures';

describe('sortChatListItems', () => {
  it('keeps roster order when the activity sort is off', () => {
    const rows = [
      {
        scope: { kind: 'team-feed' as const },
        attentionCount: 0,
        latestActivityTimestamp: '2026-09-17T10:00:00.000Z',
      },
      {
        scope: { kind: 'direct' as const, participant: 'oscar' },
        attentionCount: 0,
        latestActivityTimestamp: '2026-09-17T11:00:00.000Z',
      },
      {
        scope: { kind: 'direct' as const, participant: 'alice' },
        attentionCount: 1,
        latestActivityTimestamp: '2026-09-17T09:00:00.000Z',
      },
    ];
    expect(sortChatListItems(rows, false).map((row) => conversationScopeKey(row.scope))).toEqual([
      'team-feed',
      'direct:oscar',
      'direct:alice',
    ]);
  });

  it('pins This team, then attention chats, then newest activity', () => {
    const rows = [
      {
        scope: { kind: 'team-feed' as const },
        attentionCount: 0,
        latestActivityTimestamp: '2026-09-17T18:00:00.000Z',
      },
      {
        scope: { kind: 'direct' as const, participant: 'oscar' },
        attentionCount: 0,
        latestActivityTimestamp: '2026-09-17T16:00:00.000Z',
      },
      {
        scope: { kind: 'direct' as const, participant: 'alice' },
        attentionCount: 1,
        latestActivityTimestamp: '2026-09-17T12:00:00.000Z',
      },
      {
        scope: { kind: 'direct' as const, participant: 'cody' },
        attentionCount: 0,
        latestActivityTimestamp: '2026-09-17T17:00:00.000Z',
      },
    ];
    expect(sortChatListItems(rows, true).map((row) => conversationScopeKey(row.scope))).toEqual([
      'team-feed',
      'direct:alice',
      'direct:cody',
      'direct:oscar',
    ]);
  });
});

describe('buildChatList activity sort', () => {
  const members = [
    { name: 'oscar', agentType: 'team-lead' },
    { name: 'alice' },
    { name: 'cody' },
  ];

  it('does not reorder after a send while the sort is off', () => {
    const rows = buildChatList({
      members,
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
      leadNames: ['oscar'],
    });
    expect(rows.map((row) => row.displayName)).toEqual(['This team', 'oscar', 'alice', 'cody']);
  });

  it('raises the newest DM and keeps for-you chats above other DMs', () => {
    const rows = buildChatList({
      members,
      messages: [
        msg({
          from: 'user',
          to: 'cody',
          text: 'just sent',
          timestamp: '2026-09-17T18:00:00.000Z',
          messageId: 'out',
        }),
        msg({
          from: 'alice',
          to: 'user',
          text: 'need you',
          timestamp: '2026-09-17T10:00:00.000Z',
          messageId: 'attn',
        }),
        msg({
          from: 'oscar',
          to: 'user',
          text: 'older lead',
          timestamp: '2026-09-17T09:00:00.000Z',
          messageId: 'lead',
        }),
      ],
      readSet: new Set(),
      toKey: toTestKey,
      teamFeedLabel: 'This team',
      leadNames: ['oscar'],
      sortByActivity: true,
    });
    expect(rows.map((row) => row.displayName)).toEqual(['This team', 'alice', 'oscar', 'cody']);
    const alice = rows.find((row) => row.displayName === 'alice');
    expect(alice?.previewMessage?.text).toBe('need you');
    expect(alice?.latestActivityTimestamp).toBe('2026-09-17T10:00:00.000Z');
    expect(rows.find((row) => row.displayName === 'cody')?.latestActivityTimestamp).toBe(
      '2026-09-17T18:00:00.000Z'
    );
  });

  it('uses the newest scoped timestamp, not the to-user preview, for recency', () => {
    const rows = buildChatList({
      members,
      messages: [
        msg({
          from: 'user',
          to: 'alice',
          text: 'just replied',
          timestamp: '2026-09-17T18:00:00.000Z',
          messageId: 'new',
        }),
        msg({
          from: 'user',
          to: 'cody',
          text: 'also sent',
          timestamp: '2026-09-17T17:00:00.000Z',
          messageId: 'cody-out',
        }),
        msg({
          from: 'alice',
          to: 'user',
          text: 'old ask',
          timestamp: '2026-09-17T10:00:00.000Z',
          messageId: 'old',
        }),
      ],
      readSet: new Set(['old']),
      toKey: toTestKey,
      teamFeedLabel: 'This team',
      leadNames: ['oscar'],
      sortByActivity: true,
    });
    expect(rows.map((row) => row.displayName)).toEqual(['This team', 'alice', 'cody', 'oscar']);
    const alice = rows.find((row) => row.displayName === 'alice');
    expect(alice?.previewMessage?.text).toBe('old ask');
    expect(alice?.latestActivityTimestamp).toBe('2026-09-17T18:00:00.000Z');
    expect(alice?.attentionCount).toBe(0);
  });
});
