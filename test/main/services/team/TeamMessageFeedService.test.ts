import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamMessageFeedService } from '../../../../src/main/services/team/TeamMessageFeedService';

import type { InboxMessage, TeamConfig } from '../../../../src/shared/types/team';

function makeMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'user',
    to: 'jack',
    text: 'Тут?',
    timestamp: '2026-04-19T18:46:37.613Z',
    read: true,
    source: 'user_sent',
    messageId: 'user-send-1',
    ...overrides,
  };
}

describe('TeamMessageFeedService', () => {
  const config: TeamConfig = {
    name: 'Signal Ops 4',
    members: [{ name: 'team-lead', role: 'Lead' }],
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-19T18:46:40.000Z'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('reuses the cached feed within the cache TTL when no dirty invalidation arrives', async () => {
    let inboxMessages: InboxMessage[] = [makeMessage()];
    const getInboxMessages = vi.fn(async () => inboxMessages);
    const service = new TeamMessageFeedService({
      getConfig: vi.fn(async () => config),
      getInboxMessages,
      getLeadSessionMessages: vi.fn(async () => []),
      getSentMessages: vi.fn(async () => []),
    });

    const first = await service.getFeed('signal-ops-4');
    expect(first.messages).toHaveLength(1);

    inboxMessages = [
      makeMessage({
        from: 'jack',
        to: 'user',
        text: 'Да, я тут, на связи. Что нужно сделать/проверить?',
        source: 'inbox',
        timestamp: '2026-04-19T18:46:43.427Z',
      }),
      ...inboxMessages,
    ];

    vi.setSystemTime(new Date('2026-04-19T18:46:43.000Z'));

    const second = await service.getFeed('signal-ops-4');
    expect(getInboxMessages).toHaveBeenCalledTimes(1);
    expect(second.messages).toHaveLength(1);
  });

  it('refreshes the durable feed after cache expiry even when the dirty signal was missed', async () => {
    let inboxMessages: InboxMessage[] = [makeMessage()];
    const getInboxMessages = vi.fn(async () => inboxMessages);
    const service = new TeamMessageFeedService({
      getConfig: vi.fn(async () => config),
      getInboxMessages,
      getLeadSessionMessages: vi.fn(async () => []),
      getSentMessages: vi.fn(async () => []),
    });

    await service.getFeed('signal-ops-4');

    inboxMessages = [
      makeMessage({
        from: 'jack',
        to: 'user',
        text: 'Да, я тут, на связи. Что нужно сделать/проверить?',
        source: 'inbox',
        timestamp: '2026-04-19T18:46:43.427Z',
      }),
      makeMessage(),
    ];

    vi.setSystemTime(new Date('2026-04-19T18:46:46.500Z'));

    const refreshed = await service.getFeed('signal-ops-4');
    expect(getInboxMessages).toHaveBeenCalledTimes(2);
    expect(
      refreshed.messages.some(
        (message) =>
          message.from === 'jack' &&
          message.to === 'user' &&
          message.text.includes('Да, я тут')
      )
    ).toBe(true);
  });
});
