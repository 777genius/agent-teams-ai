import { afterEach, describe, expect, it } from 'vitest';

import {
  areInboxMessageArraysEquivalent,
  clearTeamMessageSelectorCaches,
  clearTeamMessageSelectorCachesForTeam,
  EMPTY_TEAM_MESSAGES_CACHE_ENTRY,
  extractRetainedCanonicalOlderTail,
  getCanonicalHeadSlice,
  getTeamMessagesCacheEntry,
  getTeamMessageSelectorCacheSnapshotForTeam,
  pruneOptimisticMessages,
  selectMemberMessagesForTeamMember,
  selectTeamMessages,
  type TeamMessagesCacheEntry,
  type TeamMessagesCacheState,
  upsertOptimisticTeamMessage,
} from '../../../src/renderer/store/team/teamMessagesCache';

import type { InboxMessage } from '../../../src/shared/types';

afterEach(() => {
  clearTeamMessageSelectorCaches();
});

function createMessage(overrides: Partial<InboxMessage> & { messageId: string }): InboxMessage {
  return {
    from: 'lead',
    to: 'alice',
    text: overrides.messageId,
    timestamp: '2026-03-12T10:00:00.000Z',
    read: false,
    ...overrides,
  };
}

function createEntry(overrides: Partial<TeamMessagesCacheEntry> = {}): TeamMessagesCacheEntry {
  return {
    ...EMPTY_TEAM_MESSAGES_CACHE_ENTRY,
    ...overrides,
  };
}

describe('teamMessagesCache', () => {
  it('returns the immutable empty entry when a team has no cached messages', () => {
    const state: TeamMessagesCacheState = { teamMessagesByName: {} };

    expect(getTeamMessagesCacheEntry(state, 'missing-team')).toBe(EMPTY_TEAM_MESSAGES_CACHE_ENTRY);
  });

  it('upserts optimistic messages by durable id and keeps deterministic timestamp order', () => {
    const first = upsertOptimisticTeamMessage(
      createEntry(),
      createMessage({
        messageId: 'msg-new',
        timestamp: '2026-03-12T10:00:03.000Z',
        text: 'draft',
      })
    );
    const second = upsertOptimisticTeamMessage(
      first,
      createMessage({
        messageId: 'msg-old',
        timestamp: '2026-03-12T10:00:01.000Z',
      })
    );
    const replaced = upsertOptimisticTeamMessage(
      second,
      createMessage({
        messageId: 'msg-new',
        timestamp: '2026-03-12T10:00:03.000Z',
        text: 'sent',
      })
    );

    expect(replaced.optimisticMessages.map((message) => message.messageId)).toEqual([
      'msg-old',
      'msg-new',
    ]);
    expect(replaced.optimisticMessages[1].text).toBe('sent');
  });

  it('compares semantic message arrays and prunes optimistic rows confirmed by canonical data', () => {
    const canonical = [
      createMessage({ messageId: 'msg-1', text: 'confirmed' }),
      createMessage({ messageId: 'msg-2' }),
    ];
    const equivalentCanonical = [
      createMessage({ messageId: 'msg-1', text: 'confirmed' }),
      createMessage({ messageId: 'msg-2' }),
    ];
    const optimistic = [
      createMessage({ messageId: 'msg-1', text: 'draft that arrived' }),
      createMessage({ messageId: 'msg-local', text: 'still local' }),
    ];

    expect(areInboxMessageArraysEquivalent(canonical, equivalentCanonical)).toBe(true);
    expect(
      areInboxMessageArraysEquivalent(canonical, [
        createMessage({ messageId: 'msg-1', text: 'changed' }),
        createMessage({ messageId: 'msg-2' }),
      ])
    ).toBe(false);
    expect(pruneOptimisticMessages(optimistic, canonical).map((message) => message.messageId)).toEqual(
      ['msg-local']
    );
  });

  it('retains already-loaded older tail only when the fresh head anchors into canonical data', () => {
    const canonical = [
      createMessage({ messageId: 'msg-4', timestamp: '2026-03-12T10:00:04.000Z' }),
      createMessage({ messageId: 'msg-3', timestamp: '2026-03-12T10:00:03.000Z' }),
      createMessage({ messageId: 'msg-2', timestamp: '2026-03-12T10:00:02.000Z' }),
      createMessage({ messageId: 'msg-1', timestamp: '2026-03-12T10:00:01.000Z' }),
    ];
    const freshHead = [
      createMessage({ messageId: 'msg-5', timestamp: '2026-03-12T10:00:05.000Z' }),
      createMessage({ messageId: 'msg-3', timestamp: '2026-03-12T10:00:03.000Z' }),
    ];

    expect(getCanonicalHeadSlice(canonical, 2).map((message) => message.messageId)).toEqual([
      'msg-4',
      'msg-3',
    ]);
    expect(
      extractRetainedCanonicalOlderTail(canonical, freshHead)?.map((message) => message.messageId)
    ).toEqual(['msg-2', 'msg-1']);
    expect(
      extractRetainedCanonicalOlderTail(canonical, [createMessage({ messageId: 'disjoint' })])
    ).toBeNull();
  });

  it('memoizes merged and member-scoped selectors and clears team-scoped caches', () => {
    const state: TeamMessagesCacheState = {
      teamMessagesByName: {
        'my-team': createEntry({
          canonicalMessages: [
            createMessage({
              messageId: 'msg-1',
              to: 'alice',
              timestamp: '2026-03-12T10:00:01.000Z',
            }),
            createMessage({
              messageId: 'msg-2',
              to: 'bob',
              timestamp: '2026-03-12T10:00:02.000Z',
            }),
          ],
          optimisticMessages: [
            createMessage({
              messageId: 'msg-3',
              from: 'alice',
              to: 'lead',
              timestamp: '2026-03-12T10:00:03.000Z',
            }),
          ],
        }),
      },
    };

    const firstTeamMessages = selectTeamMessages(state, 'my-team');
    const secondTeamMessages = selectTeamMessages(state, 'my-team');
    const firstAliceMessages = selectMemberMessagesForTeamMember(state, 'my-team', 'alice');
    const secondAliceMessages = selectMemberMessagesForTeamMember(state, 'my-team', 'alice');

    expect(firstTeamMessages).toBe(secondTeamMessages);
    expect(firstAliceMessages).toBe(secondAliceMessages);
    expect(firstTeamMessages.map((message) => message.messageId)).toEqual([
      'msg-3',
      'msg-2',
      'msg-1',
    ]);
    expect(firstAliceMessages.map((message) => message.messageId)).toEqual(['msg-3', 'msg-1']);
    expect(getTeamMessageSelectorCacheSnapshotForTeam('my-team')).toEqual({
      hasMergedMessagesSelector: true,
      memberMessagesSelectorCount: 1,
    });

    clearTeamMessageSelectorCachesForTeam('my-team');

    expect(getTeamMessageSelectorCacheSnapshotForTeam('my-team')).toEqual({
      hasMergedMessagesSelector: false,
      memberMessagesSelectorCount: 0,
    });
  });
});
