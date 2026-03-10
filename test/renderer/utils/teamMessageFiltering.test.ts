import { describe, expect, it } from 'vitest';

import { filterTeamMessages } from '@renderer/utils/teamMessageFiltering';

import type { InboxMessage } from '@shared/types';

function makeMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'team-lead',
    text: 'Hello',
    timestamp: '2026-03-09T12:00:00.000Z',
    read: true,
    messageId: 'msg-1',
    ...overrides,
  };
}

describe('filterTeamMessages', () => {
  it('keeps lead-to-user messages visible', () => {
    const messages = [
      makeMessage({
        from: 'lead',
        to: 'user',
        text: 'Accepted cross-team request. Delegating now.',
        source: 'lead_process',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: true },
      searchQuery: '',
    });

    expect(result).toHaveLength(1);
    expect(result[0].to).toBe('user');
    expect(result[0].source).toBe('lead_process');
  });

  it('still filters noise messages when showNoise is false', () => {
    const messages = [
      makeMessage({
        text: '{"type":"idle_notification","idleReason":"available"}',
      }),
      makeMessage({
        messageId: 'msg-2',
        text: 'Real visible message',
      }),
    ];

    const result = filterTeamMessages(messages, {
      timeWindow: null,
      filter: { from: new Set(), to: new Set(), showNoise: false },
      searchQuery: '',
    });

    expect(result).toHaveLength(1);
    expect(result[0].messageId).toBe('msg-2');
  });
});
