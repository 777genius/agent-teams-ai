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

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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

  it('hides native app-managed bootstrap private control messages from the feed', async () => {
    const service = new TeamMessageFeedService({
      getConfig: vi.fn(async () => config),
      getInboxMessages: vi.fn(async () => [
        makeMessage({
          from: 'team-lead',
          to: undefined,
          messageId: 'native-bootstrap-private-check',
          source: undefined,
          text: '<agent_teams_native_app_managed_bootstrap_check>\nprivate\n</agent_teams_native_app_managed_bootstrap_check>',
        }),
        makeMessage({
          messageId: 'visible-user-message',
          text: 'Visible message',
        }),
      ]),
      getLeadSessionMessages: vi.fn(async () => []),
      getSentMessages: vi.fn(async () => []),
    });

    const feed = await service.getFeed('signal-ops-4');

    expect(feed.messages.map((message) => message.messageId)).toEqual(['visible-user-message']);
  });

  it('includes Codex runtimeProvider in synthetic teammate bootstrap prompts', async () => {
    const service = new TeamMessageFeedService({
      getConfig: vi.fn(async () => ({
        name: 'codex-team',
        members: [
          { name: 'team-lead', role: 'Lead' },
          { name: 'bob', role: 'Developer', providerId: 'codex' as const, model: 'gpt-5.4-mini' },
        ],
      })),
      getInboxMessages: vi.fn(async () => []),
      getLeadSessionMessages: vi.fn(async () => []),
      getSentMessages: vi.fn(async () => []),
    });

    const feed = await service.getFeed('codex-team');

    expect(feed.messages).toHaveLength(1);
    expect(feed.messages[0].text).toContain('runtimeProvider: "codex"');
    expect(feed.messages[0].text).toContain('member_briefing');
  });

  it('does not hide user-authored text just because it resembles an internal prompt', async () => {
    const service = new TeamMessageFeedService({
      getConfig: vi.fn(async () => config),
      getInboxMessages: vi.fn(async () => [
        makeMessage({
          messageId: 'quoted-control-prompt',
          source: 'user_sent',
          text: `Human: You have new inbox messages addressed to you (team lead "team-lead").
Process them in order (oldest first).

Messages:
1) From: tom
   Timestamp: 2026-05-06T15:02:54.853Z
   Text:
   #f8d7235a done.`,
        }),
      ]),
      getLeadSessionMessages: vi.fn(async () => []),
      getSentMessages: vi.fn(async () => []),
    });

    const feed = await service.getFeed('signal-ops-4');

    expect(feed.messages.map((message) => message.messageId)).toEqual(['quoted-control-prompt']);
  });

  it('does not hide user-authored native bootstrap marker quotes from the feed', async () => {
    const service = new TeamMessageFeedService({
      getConfig: vi.fn(async () => config),
      getInboxMessages: vi.fn(async () => [
        makeMessage({
          messageId: 'quoted-native-bootstrap-control',
          source: 'user_sent',
          text: '<agent_teams_native_app_managed_bootstrap_check>\nquoted\n</agent_teams_native_app_managed_bootstrap_check>',
        }),
      ]),
      getLeadSessionMessages: vi.fn(async () => []),
      getSentMessages: vi.fn(async () => []),
    });

    const feed = await service.getFeed('signal-ops-4');

    expect(feed.messages.map((message) => message.messageId)).toEqual([
      'quoted-native-bootstrap-control',
    ]);
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

  it('deduplicates concurrent feed rebuilds for the same team', async () => {
    const inboxRequest = createDeferred<InboxMessage[]>();
    const getInboxMessages = vi.fn(() => inboxRequest.promise);
    const service = new TeamMessageFeedService({
      getConfig: vi.fn(async () => config),
      getInboxMessages,
      getLeadSessionMessages: vi.fn(async () => []),
      getSentMessages: vi.fn(async () => []),
    });

    const first = service.getFeed('signal-ops-4');
    const second = service.getFeed('signal-ops-4');
    await Promise.resolve();

    expect(getInboxMessages).toHaveBeenCalledTimes(1);
    inboxRequest.resolve([makeMessage()]);

    const [firstFeed, secondFeed] = await Promise.all([first, second]);
    expect(firstFeed).toEqual(secondFeed);
    expect(firstFeed.messages).toHaveLength(1);
  });

  it('does not reuse or cache a stale in-flight rebuild after invalidation', async () => {
    const firstInboxRequest = createDeferred<InboxMessage[]>();
    const secondInboxRequest = createDeferred<InboxMessage[]>();
    const getInboxMessages = vi
      .fn()
      .mockImplementationOnce(() => firstInboxRequest.promise)
      .mockImplementationOnce(() => secondInboxRequest.promise);
    const service = new TeamMessageFeedService({
      getConfig: vi.fn(async () => config),
      getInboxMessages,
      getLeadSessionMessages: vi.fn(async () => []),
      getSentMessages: vi.fn(async () => []),
    });

    const staleRequest = service.getFeed('signal-ops-4');
    await Promise.resolve();
    expect(getInboxMessages).toHaveBeenCalledTimes(1);

    service.invalidate('signal-ops-4');
    const freshRequest = service.getFeed('signal-ops-4');
    await Promise.resolve();
    expect(getInboxMessages).toHaveBeenCalledTimes(2);

    secondInboxRequest.resolve([
      makeMessage({
        messageId: 'fresh-message',
        text: 'fresh',
        timestamp: '2026-04-19T18:46:45.000Z',
      }),
    ]);
    const freshFeed = await freshRequest;
    expect(freshFeed.messages[0]?.messageId).toBe('fresh-message');

    firstInboxRequest.resolve([
      makeMessage({
        messageId: 'stale-message',
        text: 'stale',
        timestamp: '2026-04-19T18:46:44.000Z',
      }),
    ]);
    await staleRequest;

    const cachedFeed = await service.getFeed('signal-ops-4');
    expect(cachedFeed.messages[0]?.messageId).toBe('fresh-message');
    expect(getInboxMessages).toHaveBeenCalledTimes(2);
  });

  it('adds UI-only bootstrap start rows for side-lane teammates', async () => {
    const opencodeConfig: TeamConfig = {
      name: 'relay-works-14',
      description: 'relay-works-14 team for provisioning flow',
      members: [
        { name: 'team-lead', role: 'Lead', providerId: 'codex' },
        {
          name: 'bob',
          role: 'developer',
          providerId: 'opencode',
          model: 'openrouter/moonshotai/kimi-k2.6',
          joinedAt: 1777570946947,
        },
      ],
    };
    const service = new TeamMessageFeedService({
      getConfig: vi.fn(async () => opencodeConfig),
      getInboxMessages: vi.fn(async () => []),
      getLeadSessionMessages: vi.fn(async () => []),
      getSentMessages: vi.fn(async () => []),
    });

    const feed = await service.getFeed('relay-works-14');

    expect(feed.messages).toHaveLength(1);
    expect(feed.messages[0]).toMatchObject({
      from: 'team-lead',
      to: 'bob',
      source: 'system_notification',
      messageId: 'bootstrap-start:relay-works-14:bob',
      timestamp: '2026-04-30T17:42:26.947Z',
    });
    expect(feed.messages[0]?.text).toContain('Provider override for this teammate: opencode.');
    expect(feed.messages[0]?.text).toContain(
      'Model override for this teammate: openrouter/moonshotai/kimi-k2.6.'
    );
    expect(feed.messages[0]?.text).toContain(
      'The team has already been created and you are being attached as a persistent teammate.'
    );
  });

  it('keeps UI-only bootstrap start rows for members with stale inactive config flags', async () => {
    const configWithStaleInactiveMember: TeamConfig = {
      name: 'atlas-hq',
      description: 'atlas-hq team for provisioning flow',
      members: [
        { name: 'team-lead', role: 'Lead', providerId: 'codex' },
        {
          name: 'alice',
          role: 'reviewer',
          providerId: 'anthropic',
          model: 'claude-opus-4-6',
          joinedAt: 1778102486293,
          isActive: false,
        } as NonNullable<TeamConfig['members']>[number],
      ],
    };
    const service = new TeamMessageFeedService({
      getConfig: vi.fn(async () => configWithStaleInactiveMember),
      getInboxMessages: vi.fn(async () => []),
      getLeadSessionMessages: vi.fn(async () => []),
      getSentMessages: vi.fn(async () => []),
    });

    const feed = await service.getFeed('atlas-hq');

    expect(feed.messages).toHaveLength(1);
    expect(feed.messages[0]).toMatchObject({
      from: 'team-lead',
      to: 'alice',
      source: 'system_notification',
      messageId: 'bootstrap-start:atlas-hq:alice',
      timestamp: '2026-05-06T21:21:26.293Z',
    });
  });
});
