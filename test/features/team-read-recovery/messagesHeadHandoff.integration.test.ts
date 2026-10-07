import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { create } from 'zustand';

import {
  __getTeamScopedTransientStateForTests,
  __resetTeamSliceModuleStateForTests,
  createTeamSlice,
} from '../../../src/renderer/store/slices/teamSlice';
import { invalidateTeamLocalStateEpoch } from '../../../src/renderer/store/team/teamLocalStateEpoch';

import type { AppState } from '../../../src/renderer/store/types';
import type { MessagesPage } from '../../../src/shared/types';

const boundary = vi.hoisted(() => ({ getMessagesPage: vi.fn() }));
vi.mock('@renderer/api', () => ({ api: { teams: boundary } }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolveValue, rejectValue) => {
    resolve = resolveValue;
    reject = rejectValue;
  });
  return { promise, resolve, reject };
}

const team = 'TEST-sentry-head-handoff';
function storeWithOlderCursor() {
  const store = create<AppState>()(
    (set, get, storeApi) =>
      ({
        ...createTeamSlice(set as never, get as never, storeApi as never),
        activeContextId: 'TEST-context',
      }) as AppState
  );
  store.setState({
    teamMessagesByName: {
      ['TEST-sentry-head-handoff']: {
        canonicalMessages: [],
        optimisticMessages: [],
        feedRevision: 'feed-1',
        nextCursor: 'TEST-older-cursor',
        hasMore: true,
        lastFetchedAt: 0,
        loadingHead: false,
        loadingOlder: false,
        headHydrated: true,
      },
    },
  });
  return store;
}

function page(feedRevision: string): MessagesPage {
  return { messages: [], feedRevision, nextCursor: null, hasMore: false };
}
async function flushMicrotasks() {
  for (let index = 0; index < 12; index++) await Promise.resolve();
}

describe('actual store older/head handoff with synthetic transport', () => {
  beforeEach(() => {
    __resetTeamSliceModuleStateForTests();
    boundary.getMessagesPage.mockReset();
  });
  afterEach(() => {
    __resetTeamSliceModuleStateForTests();
  });

  it.each([
    { name: 'changed page with no external head caller', queued: false, localChange: false },
    { name: 'changed page with queued external head callers', queued: true, localChange: false },
    {
      name: 'changed local feed with queued external head callers',
      queued: true,
      localChange: true,
    },
  ])('hands off $name without a self-wait cycle', async ({ queued, localChange }) => {
    const store = storeWithOlderCursor();
    const older = deferred<MessagesPage>();
    const head = deferred<MessagesPage>();
    boundary.getMessagesPage.mockReturnValueOnce(older.promise).mockReturnValueOnce(head.promise);
    const loadingOlder = store.getState().loadOlderTeamMessages(team);
    const callers = queued
      ? [
          store.getState().refreshTeamMessagesHead(team),
          store.getState().refreshTeamMessagesHead(team),
        ]
      : [];
    if (localChange)
      store.setState((state) => ({
        teamMessagesByName: {
          ...state.teamMessagesByName,
          ['TEST-sentry-head-handoff']: {
            ...state.teamMessagesByName['TEST-sentry-head-handoff'],
            feedRevision: 'feed-local-change',
          },
        },
      }));
    expect(boundary.getMessagesPage).toHaveBeenCalledTimes(1);
    older.resolve(page(localChange ? 'feed-1' : 'feed-2'));
    await flushMicrotasks();
    // A broken self-wait cycle never dispatches the required head, so this fails without a timeout.
    expect(boundary.getMessagesPage).toHaveBeenCalledTimes(2);
    expect(boundary.getMessagesPage.mock.calls[1]).toEqual([team, { limit: 50 }]);
    expect(store.getState().teamMessagesByName['TEST-sentry-head-handoff'].loadingOlder).toBe(
      false
    );
    expect(store.getState().teamMessagesByName['TEST-sentry-head-handoff'].loadingHead).toBe(true);
    head.resolve(page('feed-head-result'));
    await loadingOlder;
    for (const result of await Promise.all(callers))
      expect(result.feedRevision).toBe('feed-head-result');
    expect(store.getState().teamMessagesByName['TEST-sentry-head-handoff'].feedRevision).toBe(
      'feed-head-result'
    );
    expect(__getTeamScopedTransientStateForTests(team).hasQueuedHeadRefreshAfterOlder).toBe(false);
    expect(boundary.getMessagesPage).toHaveBeenCalledTimes(2);
  });

  it('propagates the performed head failure to queued callers and releases the queue', async () => {
    const store = storeWithOlderCursor();
    const older = deferred<MessagesPage>();
    const head = deferred<MessagesPage>();
    boundary.getMessagesPage.mockReturnValueOnce(older.promise).mockReturnValueOnce(head.promise);
    const loadingOlder = store.getState().loadOlderTeamMessages(team);
    const queued = store.getState().refreshTeamMessagesHead(team);
    const rejection = expect(queued).rejects.toThrow('TEST-head-failure');
    older.resolve(page('feed-2'));
    await flushMicrotasks();
    expect(boundary.getMessagesPage).toHaveBeenCalledTimes(2);
    head.reject(new Error('TEST-head-failure'));
    await Promise.all([loadingOlder, rejection]);
    expect(vi.mocked(console.error).mock.calls.map((call) => call.map(String).join(' '))).toEqual([
      '[Renderer:unwrapIpc] [team:getMessagesPage] TEST-head-failure',
    ]);
    vi.mocked(console.error).mockClear();
    expect(store.getState().teamMessagesByName['TEST-sentry-head-handoff'].loadingHead).toBe(false);
    expect(store.getState().teamMessagesByName['TEST-sentry-head-handoff'].loadingOlder).toBe(
      false
    );
    expect(__getTeamScopedTransientStateForTests(team).hasQueuedHeadRefreshAfterOlder).toBe(false);
  });

  it('retires an invalidated queued owner without dispatching its head', async () => {
    const store = storeWithOlderCursor();
    const older = deferred<MessagesPage>();
    boundary.getMessagesPage.mockReturnValueOnce(older.promise);
    const loadingOlder = store.getState().loadOlderTeamMessages(team);
    const queued = store.getState().refreshTeamMessagesHead(team);
    invalidateTeamLocalStateEpoch(team);
    store.setState({ teamMessagesByName: {} });
    older.resolve(page('feed-2'));
    await Promise.all([loadingOlder, queued]);
    expect(boundary.getMessagesPage).toHaveBeenCalledTimes(1);
    expect(store.getState().teamMessagesByName).toEqual({});
    expect(__getTeamScopedTransientStateForTests(team).hasQueuedHeadRefreshAfterOlder).toBe(false);
  });
});
