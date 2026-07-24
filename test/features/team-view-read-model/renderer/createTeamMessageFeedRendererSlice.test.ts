import {
  createTeamMessageFeedRendererSlice,
  TeamMessageFeedCoordinator,
  type TeamMessageFeedRendererSlice,
  type TeamMessageFeedRendererState,
  type TeamMessagesCacheEntry,
} from '@features/team-view-read-model/renderer';
import { mergeTeamMessages } from '@renderer/utils/mergeTeamMessages';
import { describe, expect, it, vi } from 'vitest';

import {
  isMemberActivityMetaStale,
  structurallyShareMemberActivityFacts,
} from '../../../../src/renderer/store/team/teamMemberActivityMeta';
import {
  areInboxMessageArraysEquivalent,
  extractRetainedCanonicalOlderTail,
  getCanonicalHeadSlice,
  getTeamMessagesCacheEntry,
  pruneOptimisticMessages,
} from '../../../../src/renderer/store/team/teamMessagesCache';

import type { InboxMessage, MessagesPage, TeamMemberActivityMeta } from '@shared/types';

const TEAM_NAME = 'sandbox-team';

function message(id: string, timestamp = '2026-07-23T10:00:00.000Z'): InboxMessage {
  return {
    from: 'lead',
    text: id,
    timestamp,
    read: true,
    messageId: id,
  };
}

function page(
  revision: string,
  messages: InboxMessage[] = [message(revision)],
  nextCursor: string | null = null
): MessagesPage {
  return {
    messages,
    nextCursor,
    hasMore: nextCursor != null,
    feedRevision: revision,
  };
}

function cacheEntry(overrides: Partial<TeamMessagesCacheEntry> = {}): TeamMessagesCacheEntry {
  return {
    canonicalMessages: [],
    optimisticMessages: [],
    feedRevision: null,
    nextCursor: null,
    hasMore: false,
    lastFetchedAt: null,
    loadingHead: false,
    loadingOlder: false,
    headHydrated: false,
    ...overrides,
  };
}

function activityMeta(revision: string): TeamMemberActivityMeta {
  return {
    teamName: TEAM_NAME,
    computedAt: '2026-07-23T10:00:00.000Z',
    feedRevision: revision,
    members: {},
  };
}

function onlyTeamMessageEntry(
  state: TeamMessageFeedRendererState
): TeamMessagesCacheEntry | undefined {
  return Object.values(state.teamMessagesByName).at(0);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

function createHarness(
  initialState: TeamMessageFeedRendererState = {
    memberActivityMetaByTeam: {},
    teamMessagesByName: {},
  }
) {
  let state = initialState;
  let scopeIsCurrent = true;
  const coordinator = new TeamMessageFeedCoordinator();
  const transport = {
    getMemberActivityMeta: vi.fn().mockResolvedValue(activityMeta('r1')),
    getMessagesPage: vi.fn().mockResolvedValue(page('r1')),
  };
  const pendingReplyPolicy = {
    setEnabled: vi.fn((_teamName: string, _sourceId: string, enabled: boolean) => enabled),
  };

  const slice: TeamMessageFeedRendererSlice = createTeamMessageFeedRendererSlice({
    actions: {
      getActions: () => slice,
    },
    activityPolicy: {
      isStale: isMemberActivityMetaStale,
      structurallyShareMembers: structurallyShareMemberActivityFacts,
    },
    cachePolicy: {
      areMessageArraysEquivalent: areInboxMessageArraysEquivalent,
      extractRetainedOlderTail: extractRetainedCanonicalOlderTail,
      getCanonicalHeadSlice,
      getEntry: getTeamMessagesCacheEntry,
      mergeMessages: mergeTeamMessages,
      pruneOptimisticMessages,
    },
    coordinator,
    pendingReplyPolicy,
    requestScope: {
      capture: () => Symbol('scope'),
      isCurrent: () => scopeIsCurrent,
    },
    state: {
      getState: () => state,
      setState: (update) => {
        const patch = typeof update === 'function' ? update(state) : update;
        state = { ...state, ...patch };
      },
    },
    transport,
  });

  return {
    coordinator,
    getState: () => state,
    pendingReplyPolicy,
    setScopeCurrent: (value: boolean) => {
      scopeIsCurrent = value;
    },
    slice,
    transport,
  };
}

describe('createTeamMessageFeedRendererSlice', () => {
  it('deduplicates a head request and schedules exactly one fresh follow-up', async () => {
    const first = deferred<MessagesPage>();
    const harness = createHarness();
    harness.transport.getMessagesPage
      .mockImplementationOnce(() => first.promise)
      .mockResolvedValueOnce(page('r2'));

    const firstCaller = harness.slice.refreshTeamMessagesHead(TEAM_NAME);
    const secondCaller = harness.slice.refreshTeamMessagesHead(TEAM_NAME);
    const thirdCaller = harness.slice.refreshTeamMessagesHead(TEAM_NAME);
    expect(harness.transport.getMessagesPage).toHaveBeenCalledTimes(1);

    first.resolve(page('r1'));
    await Promise.all([firstCaller, secondCaller, thirdCaller]);
    await vi.waitFor(() => {
      expect(harness.transport.getMessagesPage).toHaveBeenCalledTimes(2);
    });

    expect(onlyTeamMessageEntry(harness.getState())?.feedRevision).toBe('r2');
    expect(harness.coordinator.snapshot(TEAM_NAME).hasPendingFreshHeadRefresh).toBe(false);
  });

  it('queues one head refresh until the active older-page request settles', async () => {
    const older = deferred<void>();
    const harness = createHarness();
    const olderRequest = older.promise.finally(() => {
      harness.coordinator.deleteOlderRequest(TEAM_NAME, olderRequest);
    });
    harness.coordinator.setOlderRequest(TEAM_NAME, olderRequest);

    const firstCaller = harness.slice.refreshTeamMessagesHead(TEAM_NAME);
    const secondCaller = harness.slice.refreshTeamMessagesHead(TEAM_NAME);
    expect(harness.transport.getMessagesPage).not.toHaveBeenCalled();
    expect(harness.coordinator.snapshot(TEAM_NAME).hasQueuedHeadRefreshAfterOlder).toBe(true);

    older.resolve();
    await Promise.all([firstCaller, secondCaller]);

    expect(harness.transport.getMessagesPage).toHaveBeenCalledTimes(1);
    expect(harness.coordinator.snapshot(TEAM_NAME).hasQueuedHeadRefreshAfterOlder).toBe(false);
  });

  it('reloads the head when an older page belongs to another feed revision', async () => {
    const harness = createHarness({
      memberActivityMetaByTeam: {},
      teamMessagesByName: {
        [TEAM_NAME]: cacheEntry({
          canonicalMessages: [message('head')],
          feedRevision: 'r1',
          headHydrated: true,
          hasMore: true,
          nextCursor: 'cursor-1',
        }),
      },
    });
    harness.transport.getMessagesPage
      .mockResolvedValueOnce(page('r2', [message('older')]))
      .mockResolvedValueOnce(page('r2', [message('new-head')]));

    await harness.slice.loadOlderTeamMessages(TEAM_NAME);

    expect(harness.transport.getMessagesPage).toHaveBeenCalledTimes(2);
    expect(onlyTeamMessageEntry(harness.getState())?.feedRevision).toBe('r2');
    expect(onlyTeamMessageEntry(harness.getState())?.loadingOlder).toBe(false);
  });

  it('contains a failed best-effort head reload after an older feed revision mismatch', async () => {
    const harness = createHarness({
      memberActivityMetaByTeam: {},
      teamMessagesByName: {
        [TEAM_NAME]: cacheEntry({
          canonicalMessages: [message('head')],
          feedRevision: 'r1',
          headHydrated: true,
          hasMore: true,
          nextCursor: 'cursor-1',
        }),
      },
    });
    harness.transport.getMessagesPage
      .mockResolvedValueOnce(page('r2', [message('older')]))
      .mockRejectedValueOnce(new Error('transient head refresh failure'));

    await expect(harness.slice.loadOlderTeamMessages(TEAM_NAME)).resolves.toBeUndefined();

    expect(harness.transport.getMessagesPage).toHaveBeenCalledTimes(2);
    expect(onlyTeamMessageEntry(harness.getState())?.feedRevision).toBe('r1');
    expect(onlyTeamMessageEntry(harness.getState())?.loadingOlder).toBe(false);
    expect(onlyTeamMessageEntry(harness.getState())?.loadingHead).toBe(false);
  });

  it('does not apply stale member activity metadata or schedule a stale follow-up', async () => {
    const pending = deferred<TeamMemberActivityMeta>();
    const harness = createHarness({
      memberActivityMetaByTeam: {},
      teamMessagesByName: {
        [TEAM_NAME]: cacheEntry({
          feedRevision: 'r1',
          headHydrated: true,
        }),
      },
    });
    harness.transport.getMemberActivityMeta.mockImplementationOnce(() => pending.promise);

    const request = harness.slice.refreshMemberActivityMeta(TEAM_NAME);
    void harness.slice.refreshMemberActivityMeta(TEAM_NAME);
    harness.setScopeCurrent(false);
    pending.resolve(activityMeta('r1'));
    await request;

    expect(harness.getState().memberActivityMetaByTeam).toEqual({});
    expect(harness.coordinator.snapshot(TEAM_NAME).hasPendingFreshMemberActivityRefresh).toBe(
      false
    );
    expect(harness.transport.getMemberActivityMeta).toHaveBeenCalledTimes(1);
  });

  it('clears all team-scoped request and timer coordination', () => {
    vi.useFakeTimers();
    try {
      const harness = createHarness();
      harness.slice.syncTeamPendingReplyRefresh(TEAM_NAME, 'panel-1', true, 1_000);
      harness.coordinator.markFreshHeadRefreshPending(TEAM_NAME);
      harness.coordinator.markFreshMemberActivityRefreshPending(TEAM_NAME);

      harness.coordinator.clearTeam(TEAM_NAME);
      vi.advanceTimersByTime(1_000);

      expect(harness.coordinator.snapshot(TEAM_NAME)).toEqual({
        hasPendingFreshHeadRefresh: false,
        hasPendingFreshMemberActivityRefresh: false,
        hasQueuedHeadRefreshAfterOlder: false,
      });
      expect(harness.transport.getMessagesPage).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
