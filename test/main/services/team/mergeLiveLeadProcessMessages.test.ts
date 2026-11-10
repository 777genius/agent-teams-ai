import { describe, expect, it } from 'vitest';

import { mergeLiveLeadProcessMessages } from '../../../../src/main/services/team/mergeLiveLeadProcessMessages';

import type { InboxMessage } from '../../../../src/shared/types';

function thought(overrides: Partial<InboxMessage>): InboxMessage {
  return {
    from: 'team-lead',
    text: 'Delegating the next slice.',
    timestamp: '2026-09-19T10:00:00.000Z',
    read: true,
    source: 'lead_session',
    leadSessionId: 'session-1',
    ...overrides,
  };
}

describe('mergeLiveLeadProcessMessages', () => {
  it('dedupes live lead_process thoughts against durable thoughts even when from differs', () => {
    const durable = [
      thought({
        from: 'team-lead',
        source: 'lead_session',
        messageId: 'durable-1',
      }),
    ];
    const live = [
      thought({
        from: 'max',
        source: 'lead_process',
        messageId: 'live-1',
      }),
    ];

    const merged = mergeLiveLeadProcessMessages(durable, live);

    expect(merged).toHaveLength(1);
    expect(merged[0]?.from).toBe('team-lead');
    expect(merged[0]?.messageId).toBe('durable-1');
  });

  it('keeps a live thought when the durable copy has different text', () => {
    const durable = [thought({ text: 'Durable thought', messageId: 'durable-1' })];
    const live = [
      thought({
        from: 'max',
        source: 'lead_process',
        text: 'Live thought',
        messageId: 'live-1',
      }),
    ];

    const merged = mergeLiveLeadProcessMessages(durable, live);

    expect(merged.map((message) => message.messageId).sort()).toEqual(['durable-1', 'live-1']);
  });
});
