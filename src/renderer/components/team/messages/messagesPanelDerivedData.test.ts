import { describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/store', () => ({ useStore: vi.fn() }));
vi.mock('./messagesPanelConversations', () => ({
  conversationScopeKey: vi.fn(),
  filterScopedMessages: vi.fn(),
}));
vi.mock('../activity/LeadThoughtsGroup', () => ({
  getThoughtGroupKey: vi.fn(),
  groupTimelineItems: vi.fn(),
}));

import {
  canonicalTeamMessages,
  canOpenConversationAddress,
  memberConversationParticipants,
  visibleTeamMessages,
} from './messagesPanelDerivedData';

import type { InboxMessage } from '@shared/types';

const message: InboxMessage = {
  from: 'Alice',
  to: 'user',
  text: 'Hidden by current search',
  timestamp: '2026-04-08T12:00:00.000Z',
  read: true,
  messageId: 'sent-1',
  source: 'inbox',
};

describe('messages panel derived data', () => {
  it('recognizes a normalized direct address for a mixed-case member', () => {
    const participants = memberConversationParticipants([{ name: 'Alice' }]);

    expect(
      canOpenConversationAddress(
        {
          contextId: 'local',
          teamName: 'team-a',
          target: { kind: 'direct', participant: 'alice' },
        },
        participants
      )
    ).toBe(true);
  });

  it('keeps canonical messages available for outbox reconciliation when the view filters them', () => {
    const messages = [message];
    const visible = visibleTeamMessages({
      messages,
      leadNames: [],
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: false },
      searchQuery: 'unrelated',
    });

    expect(visible).toEqual([]);
    expect(canonicalTeamMessages(messages, [])).toEqual([message]);
  });
});
