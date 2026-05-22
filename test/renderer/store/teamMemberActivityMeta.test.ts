import { describe, expect, it } from 'vitest';

import {
  areMemberActivityMetaEntriesEqual,
  isMemberActivityMetaStale,
  structurallyShareMemberActivityFacts,
} from '../../../src/renderer/store/team/teamMemberActivityMeta';

import type { TeamMessagesCacheEntry } from '../../../src/renderer/store/team/teamMessagesCache';
import type {
  MemberActivityMetaEntry,
  TeamMemberActivityMeta,
} from '../../../src/shared/types';

function createEntry(overrides: Partial<MemberActivityMetaEntry> = {}): MemberActivityMetaEntry {
  return {
    memberName: 'alice',
    lastAuthoredMessageAt: '2026-05-22T10:00:00.000Z',
    messageCountExact: 3,
    latestAuthoredMessageSignalsTermination: false,
    ...overrides,
  };
}

function createMeta(overrides: Partial<TeamMemberActivityMeta> = {}): TeamMemberActivityMeta {
  return {
    teamName: 'my-team',
    computedAt: '2026-05-22T10:00:00.000Z',
    members: {
      alice: createEntry(),
    },
    feedRevision: 'feed-1',
    ...overrides,
  };
}

function createMessagesEntry(
  overrides: Partial<TeamMessagesCacheEntry> = {}
): TeamMessagesCacheEntry {
  return {
    canonicalMessages: [],
    optimisticMessages: [],
    feedRevision: 'feed-1',
    nextCursor: null,
    hasMore: false,
    lastFetchedAt: null,
    loadingHead: false,
    loadingOlder: false,
    headHydrated: true,
    ...overrides,
  };
}

describe('teamMemberActivityMeta', () => {
  it('compares member activity entries by visible facts', () => {
    expect(areMemberActivityMetaEntriesEqual(createEntry(), createEntry())).toBe(true);
    expect(
      areMemberActivityMetaEntriesEqual(createEntry(), createEntry({ messageCountExact: 4 }))
    ).toBe(false);
    expect(
      areMemberActivityMetaEntriesEqual(
        createEntry(),
        createEntry({ latestAuthoredMessageSignalsTermination: true })
      )
    ).toBe(false);
    expect(areMemberActivityMetaEntriesEqual(undefined, createEntry())).toBe(false);
  });

  it('returns next activity facts when there is no previous record', () => {
    const next = {
      alice: createEntry(),
    };

    expect(structurallyShareMemberActivityFacts(undefined, next)).toBe(next);
  });

  it('preserves the previous record when all entries are semantically equal', () => {
    const previous = {
      alice: createEntry(),
      bob: createEntry({ memberName: 'bob', messageCountExact: 1 }),
    };
    const next = {
      alice: createEntry(),
      bob: createEntry({ memberName: 'bob', messageCountExact: 1 }),
    };

    expect(structurallyShareMemberActivityFacts(previous, next)).toBe(previous);
  });

  it('shares unchanged entries and replaces changed entries', () => {
    const previousAlice = createEntry();
    const previousBob = createEntry({ memberName: 'bob', messageCountExact: 1 });
    const nextBob = createEntry({ memberName: 'bob', messageCountExact: 2 });
    const previous = {
      alice: previousAlice,
      bob: previousBob,
    };

    const shared = structurallyShareMemberActivityFacts(
      previous,
      {
        alice: createEntry(),
        bob: nextBob,
      }
    );

    expect(shared).not.toBe(previous);
    expect(shared.alice).toBe(previousAlice);
    expect(shared.bob).toBe(nextBob);
  });

  it('returns a new record when activity keys are added or removed', () => {
    const previous = {
      alice: createEntry(),
      bob: createEntry({ memberName: 'bob' }),
    };

    const removed = structurallyShareMemberActivityFacts(previous, {
      alice: createEntry(),
    });

    expect(removed).not.toBe(previous);
    expect(removed).toEqual({
      alice: previous.alice,
    });
    expect(removed.alice).toBe(previous.alice);

    const singlePrevious = {
      alice: createEntry(),
    };
    const added = structurallyShareMemberActivityFacts(singlePrevious, {
        alice: createEntry(),
        bob: createEntry({ memberName: 'bob' }),
    });

    expect(added).not.toBe(singlePrevious);
    expect(added.alice).toBe(singlePrevious.alice);
    expect(added.bob).toEqual(createEntry({ memberName: 'bob' }));
  });

  it('treats missing member activity meta as stale', () => {
    expect(
      isMemberActivityMetaStale(
        {
          memberActivityMetaByTeam: {},
          teamMessagesByName: {},
        },
        'my-team'
      )
    ).toBe(true);
  });

  it('does not require refresh when the message feed has no revision yet', () => {
    expect(
      isMemberActivityMetaStale(
        {
          memberActivityMetaByTeam: {
            'my-team': createMeta({ feedRevision: 'old-feed' }),
          },
          teamMessagesByName: {
            'my-team': createMessagesEntry({ feedRevision: null }),
          },
        },
        'my-team'
      )
    ).toBe(false);
  });

  it('compares member activity meta feedRevision against the messages feed revision', () => {
    expect(
      isMemberActivityMetaStale(
        {
          memberActivityMetaByTeam: {
            'my-team': createMeta({ feedRevision: 'feed-1' }),
          },
          teamMessagesByName: {
            'my-team': createMessagesEntry({ feedRevision: 'feed-1' }),
          },
        },
        'my-team'
      )
    ).toBe(false);
    expect(
      isMemberActivityMetaStale(
        {
          memberActivityMetaByTeam: {
            'my-team': createMeta({ feedRevision: 'feed-1' }),
          },
          teamMessagesByName: {
            'my-team': createMessagesEntry({ feedRevision: 'feed-2' }),
          },
        },
        'my-team'
      )
    ).toBe(true);
  });
});
