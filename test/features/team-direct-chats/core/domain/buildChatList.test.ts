import { describe, expect, it } from 'vitest';

import { buildChatList } from '@features/team-direct-chats/core/domain/buildChatList';
import { conversationScopeKey } from '@features/team-direct-chats/core/domain/conversationScope';

import { msg, toTestKey } from './fixtures';

describe('buildChatList', () => {
  it('puts This team then lead then remaining members without collapsing solo', () => {
    const lead = { name: 'oscar', agentType: 'team-lead', color: '#f00' };
    const rows = buildChatList({
      members: [lead],
      messages: [],
      readSet: new Set(),
      toKey: toTestKey,
      teamFeedLabel: 'This team',
      leadNames: ['oscar'],
    });
    expect(rows.map((row) => row.displayName)).toEqual(['This team', 'oscar']);
    expect(rows[0].scope.kind).toBe('team-feed');
    expect(conversationScopeKey(rows[1].scope)).toBe('direct:oscar');
  });

  it('keeps member order after lead and still lists empty chats', () => {
    const rows = buildChatList({
      members: [
        { name: 'alice', color: '#0f0' },
        { name: 'oscar', agentType: 'team-lead' },
        { name: 'cody' },
      ],
      messages: [],
      readSet: new Set(),
      toKey: toTestKey,
      teamFeedLabel: 'This team',
      leadNames: ['oscar'],
    });
    expect(rows.map((row) => row.displayName)).toEqual(['This team', 'oscar', 'alice', 'cody']);
  });

  it('attaches to-user preview and dual counts on both This team and alice', () => {
    const dm = msg({ from: 'alice', to: 'user', text: 'need you', messageId: 'dm' });
    const a2a = msg({
      from: 'cody',
      to: 'oscar',
      text: 'later a2a',
      timestamp: '2026-09-17T13:00:00.000Z',
      messageId: 'a2a',
    });
    const rows = buildChatList({
      members: [
        { name: 'oscar', agentType: 'team-lead' },
        { name: 'alice' },
        { name: 'cody' },
      ],
      messages: [a2a, dm],
      readSet: new Set(),
      toKey: toTestKey,
      teamFeedLabel: 'This team',
      leadNames: ['oscar'],
    });
    const teamRow = rows[0];
    const aliceRow = rows.find((row) => row.displayName === 'alice');
    const oscarRow = rows.find((row) => row.displayName === 'oscar');
    expect(teamRow.previewMessage?.text).toBe('need you');
    expect(teamRow.unreadCount).toBe(2);
    expect(teamRow.attentionCount).toBe(1);
    expect(aliceRow?.previewMessage?.text).toBe('need you');
    expect(aliceRow?.unreadCount).toBe(1);
    expect(aliceRow?.attentionCount).toBe(1);
    expect(oscarRow?.previewMessage?.text).toBe('later a2a');
    expect(oscarRow?.unreadCount).toBe(1);
    expect(oscarRow?.attentionCount).toBe(0);
  });
});
