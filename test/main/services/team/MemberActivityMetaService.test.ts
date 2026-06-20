import { describe, expect, it, vi } from 'vitest';

import { MemberActivityMetaService } from '../../../../src/main/services/team/MemberActivityMetaService';

import type { TeamMessageFeedService } from '../../../../src/main/services/team/TeamMessageFeedService';
import type { InboxMessage } from '../../../../src/shared/types/team';

function makeMessage(overrides: Partial<InboxMessage>): InboxMessage {
  return {
    from: 'bob',
    to: 'user',
    text: 'done',
    timestamp: '2026-04-29T00:00:00.000Z',
    read: true,
    source: 'inbox',
    messageId: 'message-1',
    ...overrides,
  };
}

describe('MemberActivityMetaService', () => {
  it('builds member activity meta from a bounded page without loading the full feed', async () => {
    const getFeed = vi.fn(async () => {
      throw new Error('full feed should not be used for member activity meta');
    });
    const getPage = vi.fn(async () => ({
      messages: [
        makeMessage({
          from: 'alice',
          text: '{"type":"shutdown_response","approved":true}',
          timestamp: '2026-04-29T00:00:03.000Z',
          messageId: 'alice-2',
        }),
        makeMessage({
          from: 'bob',
          text: 'latest bob update',
          timestamp: '2026-04-29T00:00:02.000Z',
          messageId: 'bob-2',
        }),
        makeMessage({
          from: 'user',
          text: 'user prompt',
          timestamp: '2026-04-29T00:00:01.000Z',
          messageId: 'user-1',
        }),
        makeMessage({
          from: 'bob',
          text: 'older bob update',
          timestamp: '2026-04-29T00:00:00.000Z',
          messageId: 'bob-1',
        }),
      ],
      nextCursor: '2026-04-29T00:00:00.000Z|bob-1',
      hasMore: true,
      feedRevision: 'rev-page',
      durableWindowMessages: [],
      durableHasMoreAfterWindow: true,
    }));
    const service = new MemberActivityMetaService({
      getFeed,
      getPage,
    } as unknown as TeamMessageFeedService);

    const meta = await service.getMeta('my-team');

    expect(getFeed).not.toHaveBeenCalled();
    expect(getPage).toHaveBeenCalledWith('my-team', { limit: 200 });
    expect(meta.feedRevision).toBe('rev-page');
    expect(meta.members).toMatchObject({
      alice: {
        memberName: 'alice',
        lastAuthoredMessageAt: '2026-04-29T00:00:03.000Z',
        messageCountExact: 1,
        latestAuthoredMessageSignalsTermination: true,
      },
      bob: {
        memberName: 'bob',
        lastAuthoredMessageAt: '2026-04-29T00:00:02.000Z',
        messageCountExact: 2,
        latestAuthoredMessageSignalsTermination: false,
      },
    });
    expect(meta.members.user).toBeUndefined();
  });
});
