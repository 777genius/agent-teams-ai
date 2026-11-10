import { describe, expect, it } from 'vitest';

import { computePendingCrossTeamReplies } from '@renderer/utils/crossTeamPendingReplies';

import type { InboxMessage } from '@shared/types';

function makeMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'user',
    text: 'hello',
    timestamp: '2026-03-09T12:00:00.000Z',
    read: true,
    messageId: 'msg-1',
    ...overrides,
  };
}

/** Anchor time just after the latest timestamp used in tests, within the 10s TTL window. */
const NOW_MS = Date.parse('2026-03-09T12:10:05.000Z');

describe('computePendingCrossTeamReplies', () => {
  it('returns pending entry for outbound cross-team message without reply', () => {
    const sentAt = '2026-03-09T12:10:00.000Z';
    const result = computePendingCrossTeamReplies(
      [
        makeMessage({
          conversationId: 'conv-1',
          source: 'cross_team_sent',
          to: 'team-best.team-lead',
          timestamp: sentAt,
        }),
      ],
      NOW_MS
    );

    expect(result).toEqual([
      {
        conversationId: 'conv-1',
        teamName: 'team-best',
        sentAtMs: Date.parse(sentAt),
      },
    ]);
  });

  it('clears pending entry when a newer cross-team reply arrives in the same conversation', () => {
    const result = computePendingCrossTeamReplies(
      [
        makeMessage({
          conversationId: 'conv-1',
          source: 'cross_team_sent',
          to: 'team-best.team-lead',
          timestamp: '2026-03-09T12:10:00.000Z',
        }),
        makeMessage({
          conversationId: 'conv-1',
          replyToConversationId: 'conv-1',
          from: 'team-best.team-lead',
          source: 'cross_team',
          timestamp: '2026-03-09T12:10:05.000Z',
          messageId: 'msg-2',
        }),
      ],
      NOW_MS
    );

    expect(result).toEqual([]);
  });

  it('keeps pending entry when the latest outbound is newer than the last reply', () => {
    const sentAt = '2026-03-09T12:10:03.000Z';
    const result = computePendingCrossTeamReplies(
      [
        makeMessage({
          conversationId: 'conv-1',
          replyToConversationId: 'conv-1',
          from: 'team-best.team-lead',
          source: 'cross_team',
          timestamp: '2026-03-09T12:10:00.000Z',
          messageId: 'msg-1-reply',
        }),
        makeMessage({
          conversationId: 'conv-1',
          source: 'cross_team_sent',
          to: 'team-best.team-lead',
          timestamp: sentAt,
          messageId: 'msg-2',
        }),
      ],
      NOW_MS
    );

    expect(result).toEqual([
      {
        conversationId: 'conv-1',
        teamName: 'team-best',
        sentAtMs: Date.parse(sentAt),
      },
    ]);
  });

  it('keeps a pending conversation even when another team message arrives in a different conversation', () => {
    const sentAt = '2026-03-09T12:10:00.000Z';
    const result = computePendingCrossTeamReplies(
      [
        makeMessage({
          conversationId: 'conv-1',
          source: 'cross_team_sent',
          to: 'team-best.team-lead',
          timestamp: sentAt,
        }),
        makeMessage({
          conversationId: 'conv-2',
          from: 'team-best.team-lead',
          source: 'cross_team',
          timestamp: '2026-03-09T12:10:05.000Z',
          messageId: 'msg-2',
        }),
      ],
      NOW_MS
    );

    expect(result).toEqual([
      {
        conversationId: 'conv-1',
        teamName: 'team-best',
        sentAtMs: Date.parse(sentAt),
      },
    ]);
  });

  it('ignores non-cross-team messages', () => {
    const result = computePendingCrossTeamReplies(
      [
        makeMessage({
          from: 'alice',
          to: 'team-lead',
          timestamp: '2026-03-09T12:10:00.000Z',
        }),
      ],
      NOW_MS
    );

    expect(result).toEqual([]);
  });

  it('falls back to legacy team-level matching when conversationId is missing', () => {
    const sentAt = '2026-03-09T12:10:00.000Z';
    const result = computePendingCrossTeamReplies(
      [
        makeMessage({
          source: 'cross_team_sent',
          to: 'team-best.team-lead',
          timestamp: sentAt,
        }),
      ],
      NOW_MS
    );

    expect(result).toEqual([
      {
        teamName: 'team-best',
        sentAtMs: Date.parse(sentAt),
      },
    ]);
  });
});
