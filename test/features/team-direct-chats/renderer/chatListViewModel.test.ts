import { buildChatListView } from '@features/team-direct-chats/renderer/view-models/chatListViewModel';
import { describe, expect, it } from 'vitest';

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

  it('shows latest activity time even when preview prefers an older to-user message', () => {
    const rows = buildChatListView({
      members: [
        { name: 'oscar', agentType: 'team-lead' },
        { name: 'alice' },
      ],
      messages: [
        msg({
          from: 'cody',
          to: 'oscar',
          text: 'later a2a',
          timestamp: '2026-09-17T18:00:00.000Z',
          messageId: 'a2a',
        }),
        msg({
          from: 'alice',
          to: 'user',
          text: 'earlier dm',
          timestamp: '2026-09-17T12:00:00.000Z',
          messageId: 'dm',
        }),
      ],
      readSet: new Set(),
      toKey: toTestKey,
      teamFeedLabel: 'This team',
      emptyPreview: 'No messages yet',
      leadNames: ['oscar'],
    });

    expect(rows[0]?.previewText).toBe('earlier dm');
    expect(rows[0]?.previewTimestamp).toBe('2026-09-17T18:00:00.000Z');
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

  it('attributes lead thought previews to lead even when from is a teammate', () => {
    const rows = buildChatListView({
      members: [
        { name: 'max', role: 'Team Lead', agentType: 'developer' },
        { name: 'ora', role: 'Developer' },
      ],
      messages: [
        msg({
          from: 'max',
          text: 'LEAD_THOUGHT_PROOF: delegating the next sandbox slice.',
          source: 'lead_process',
          messageId: 'thought',
          timestamp: '2026-09-19T10:00:00.000Z',
        }),
        msg({
          from: 'team-lead',
          to: 'ora',
          text: 'Starting ora',
          messageId: 'boot',
          timestamp: '2026-09-19T09:00:00.000Z',
        }),
      ],
      readSet: new Set(),
      toKey: toTestKey,
      teamFeedLabel: 'Group chat',
      emptyPreview: 'No messages yet',
      leadNames: ['team-lead'],
    });

    const group = rows.find((row) => row.displayName === 'Group chat');
    const maxRow = rows.find((row) => row.displayName === 'max');
    const oraRow = rows.find((row) => row.displayName === 'ora');

    expect(group?.previewFrom).toBe('team-lead');
    expect(group?.previewText).toContain('LEAD_THOUGHT_PROOF');
    expect(maxRow?.previewFrom).toBeNull();
    expect(maxRow?.previewText).toBe('No messages yet');
    expect(oraRow?.previewFrom).toBe('team-lead');
  });
});
