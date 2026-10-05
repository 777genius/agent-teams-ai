import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { invalidateContextScopedRequestEpoch } from '../../../src/renderer/store/utils/contextScopedRequestEpoch';
import { installMockElectronAPI } from '../../mocks/electronAPI';

import { createTestStore } from './storeTestUtils';

import type { SessionDetail } from '../../../src/renderer/types/data';
import type { AgentConfig } from '../../../src/shared/types/api';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function detail(sessionId: string, projectId = 'sandbox-a'): SessionDetail {
  return {
    session: {
      id: sessionId,
      projectId,
      projectPath: `/synthetic-test/${projectId}`,
      createdAt: 1,
      firstMessage: sessionId,
      hasSubagents: false,
      messageCount: 0,
    },
    messages: [],
    chunks: [],
    processes: [],
    metrics: {
      durationMs: 0,
      totalTokens: 0,
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      messageCount: 0,
    },
  };
}

describe('session detail owner identity', () => {
  let store: ReturnType<typeof createTestStore>;
  let mock: ReturnType<typeof installMockElectronAPI>;
  let configs: ReturnType<typeof vi.fn<(root: string) => Promise<Record<string, AgentConfig>>>>;

  beforeEach(() => {
    mock = installMockElectronAPI();
    configs = vi.fn().mockResolvedValue({});
    Object.assign(mock, { readAgentConfigs: configs });
    store = createTestStore();
    let counter = 0;
    vi.stubGlobal('crypto', { randomUUID: () => `sandbox-tab-${++counter}` });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  function open(sessionId: string, projectId = 'sandbox-a', replaceActiveTab = false) {
    store
      .getState()
      .openTab({ type: 'session', sessionId, projectId, label: sessionId }, { replaceActiveTab });
    store.setState({ selectedProjectId: projectId, selectedSessionId: sessionId });
    return store.getState().activeTabId!;
  }

  function transcriptSnapshot() {
    const state = store.getState();
    return {
      sessionDetail: state.sessionDetail,
      conversation: state.conversation,
      sessionDetailLoading: state.sessionDetailLoading,
      conversationLoading: state.conversationLoading,
      sessionDetailError: state.sessionDetailError,
      sessionClaudeMdStats: state.sessionClaudeMdStats,
      sessionContextStats: state.sessionContextStats,
      sessionPhaseInfo: state.sessionPhaseInfo,
      visibleAIGroupId: state.visibleAIGroupId,
      selectedAIGroup: state.selectedAIGroup,
      tabSessionData: state.tabSessionData,
      tabs: state.openTabs,
    };
  }

  it('aligns a restored tab with the flat project resolved by session membership', async () => {
    const id = open('A', 'missing-restored-project');
    store.setState({
      selectedProjectId: null,
      selectedSessionId: null,
      projects: [
        {
          id: 'sandbox-resolved',
          name: 'Resolved sandbox',
          path: '/synthetic-test/sandbox-resolved',
          sessions: ['A'],
          createdAt: 1,
        },
      ],
    });
    mock.getSessionDetail.mockResolvedValueOnce(detail('A', 'sandbox-resolved'));
    store.getState().setActiveTab(id);
    await vi.waitFor(() => {
      expect(store.getState().tabSessionData[id]?.sessionDetail?.session.id).toBe('A');
    });
    expect(mock.getSessionDetail).toHaveBeenCalledExactlyOnceWith('sandbox-resolved', 'A');
    expect(store.getState().getActiveTab()?.projectId).toBe('sandbox-resolved');
    expect(store.getState().selectedProjectId).toBe('sandbox-resolved');
    expect(store.getState().activeProjectId).toBe('sandbox-resolved');
    expect(store.getState().selectedSessionId).toBe('A');
    expect(store.getState().sessionDetail?.session.projectId).toBe('sandbox-resolved');
    expect(store.getState().sessionDetailLoading).toBe(false);
  });

  it('aligns a restored tab before reusing its already loaded session cache', async () => {
    const id = open('A', 'missing-restored-project');
    mock.getSessionDetail.mockResolvedValueOnce(detail('A', 'sandbox-resolved'));
    await store.getState().fetchSessionDetail('missing-restored-project', 'A', id);
    const cached = store.getState().tabSessionData[id];
    store.setState({
      selectedProjectId: null,
      selectedSessionId: null,
      sessionDetail: null,
      projects: [
        {
          id: 'sandbox-resolved',
          name: 'Resolved sandbox',
          path: '/synthetic-test/sandbox-resolved',
          sessions: ['A'],
          createdAt: 1,
        },
      ],
    });
    mock.getSessionDetail.mockClear();
    store.getState().setActiveTab(id);
    expect(mock.getSessionDetail).not.toHaveBeenCalled();
    expect(store.getState().tabSessionData[id]).toBe(cached);
    expect(store.getState().sessionDetail).toBe(cached.sessionDetail);
    expect(store.getState().getActiveTab()?.projectId).toBe('sandbox-resolved');
    expect(store.getState().selectedProjectId).toBe('sandbox-resolved');
    expect(store.getState().activeProjectId).toBe('sandbox-resolved');
    expect(store.getState().selectedSessionId).toBe('A');
  });

  // Red on the old code: cleanup deletes generation 1, B reuses 1, then A
  // overwrites B's cache/detail or error. Assert the entire visible/cache state.
  it.each(['success', 'error'] as const)(
    'rejects A %s after same-ID replacement B finishes',
    async (outcome) => {
      const pending = deferred<SessionDetail | null>();
      const tabId = open('A');
      mock.getSessionDetail.mockReturnValueOnce(pending.promise);
      const a = store.getState().fetchSessionDetail('sandbox-a', 'A', tabId);
      expect(open('B', 'sandbox-b', true)).toBe(tabId);
      mock.getSessionDetail.mockResolvedValueOnce(detail('B', 'sandbox-b'));
      await store.getState().fetchSessionDetail('sandbox-b', 'B', tabId);
      const before = transcriptSnapshot();
      expect(before.sessionDetail?.session.id).toBe('B');
      if (outcome === 'success') pending.resolve(detail('A'));
      else pending.reject(new Error('A failed'));
      await a;
      expect(transcriptSnapshot()).toEqual(before);
    }
  );

  it('keeps B loading when stale A fails', async () => {
    const old = deferred<SessionDetail | null>();
    const next = deferred<SessionDetail | null>();
    const id = open('A');
    mock.getSessionDetail.mockReturnValueOnce(old.promise);
    const a = store.getState().fetchSessionDetail('sandbox-a', 'A', id);
    open('B', 'sandbox-a', true);
    mock.getSessionDetail.mockReturnValueOnce(next.promise);
    const b = store.getState().fetchSessionDetail('sandbox-a', 'B', id);
    const before = transcriptSnapshot();
    old.reject(new Error('obsolete'));
    await a;
    expect(transcriptSnapshot()).toEqual(before);
    expect(store.getState().tabSessionData[id].sessionDetailLoading).toBe(true);
    next.resolve(detail('B'));
    await b;
  });

  it.each(['closed', 'reopened'] as const)('rejects completion after owner is %s', async (mode) => {
    const pending = deferred<SessionDetail | null>();
    const id = open('A');
    mock.getSessionDetail.mockReturnValueOnce(pending.promise);
    const a = store.getState().fetchSessionDetail('sandbox-a', 'A', id);
    const createdAt = store.getState().openTabs[0].createdAt;
    store.getState().closeTab(id);
    if (mode === 'reopened') {
      // Deliberately reuse both ID and timestamp to prove cleanup identity matters.
      vi.stubGlobal('crypto', { randomUUID: () => id });
      vi.spyOn(Date, 'now').mockReturnValue(createdAt);
      open('A');
      mock.getSessionDetail.mockResolvedValueOnce(detail('new-owner'));
      await store.getState().fetchSessionDetail('sandbox-a', 'A', id);
    }
    const before = transcriptSnapshot();
    pending.resolve(detail('old-owner'));
    await a;
    expect(transcriptSnapshot()).toEqual(before);
    if (mode === 'closed') expect(store.getState().tabSessionData[id]).toBeUndefined();
  });

  it.each(['host', 'context', 'epoch', 'provider-root'] as const)(
    'rejects completion after %s changes',
    async (change) => {
      const pending = deferred<SessionDetail | null>();
      const id = open('A');
      mock.getSessionDetail.mockReturnValueOnce(pending.promise);
      const a = store.getState().fetchSessionDetail('sandbox-a', 'A', id);
      if (change === 'host')
        store.setState({ connectionMode: 'ssh', connectedHost: 'sandbox-host' });
      if (change === 'context') store.setState({ activeContextId: 'sandbox-context' });
      if (change === 'epoch') invalidateContextScopedRequestEpoch();
      if (change === 'provider-root')
        store.setState({
          appConfig: { general: { claudeRootPath: '/synthetic-test/provider-b' } } as never,
        });
      const before = transcriptSnapshot();
      pending.resolve(detail('obsolete'));
      await a;
      expect(transcriptSnapshot()).toEqual(before);
    }
  );

  it('rejects a retargeted project without cleanup or a newer fetch', async () => {
    const pending = deferred<SessionDetail | null>();
    const id = open('A');
    mock.getSessionDetail.mockReturnValueOnce(pending.promise);
    const a = store.getState().fetchSessionDetail('sandbox-a', 'A', id);
    store.setState((state) => ({
      paneLayout: {
        ...state.paneLayout,
        panes: state.paneLayout.panes.map((pane) => ({
          ...pane,
          tabs: pane.tabs.map((tab) => (tab.id === id ? { ...tab, projectId: 'sandbox-b' } : tab)),
        })),
      },
    }));
    const before = transcriptSnapshot();
    pending.resolve(detail('obsolete'));
    await a;
    expect(transcriptSnapshot()).toEqual(before);
  });

  it.each(['success', 'error'] as const)(
    'keeps inactive tab alive on %s without mutating active transcript',
    async (outcome) => {
      const pending = deferred<SessionDetail | null>();
      const id = open('A');
      mock.getSessionDetail.mockReturnValueOnce(pending.promise);
      const a = store.getState().fetchSessionDetail('sandbox-a', 'A', id);
      const bId = open('B');
      mock.getSessionDetail.mockResolvedValueOnce(detail('B'));
      await store.getState().fetchSessionDetail('sandbox-a', 'B', bId);
      const before = transcriptSnapshot();
      if (outcome === 'success') pending.resolve(detail('A'));
      else pending.reject(new Error('A failed'));
      await a;
      const after = transcriptSnapshot();
      expect({ ...after, tabSessionData: before.tabSessionData, tabs: before.tabs }).toEqual(
        before
      );
      const cache = store.getState().tabSessionData[id];
      expect(cache.sessionDetailLoading).toBe(false);
      if (outcome === 'success') expect(cache.sessionDetail?.session.id).toBe('A');
      else expect(cache.sessionDetailError).toBe('A failed');
    }
  );

  it.each(['success', 'error'] as const)(
    'fences an obsolete CLAUDE.md %s boundary',
    async (outcome) => {
      const tokens = deferred<Record<string, never>>();
      const id = open('A');
      mock.getSessionDetail.mockResolvedValueOnce(detail('A'));
      mock.readClaudeMdFiles.mockReturnValueOnce(tokens.promise);
      const a = store.getState().fetchSessionDetail('sandbox-a', 'A', id);
      await vi.waitFor(() => expect(mock.readClaudeMdFiles).toHaveBeenCalled());
      open('B', 'sandbox-b', true);
      mock.getSessionDetail.mockResolvedValueOnce(detail('B', 'sandbox-b'));
      await store.getState().fetchSessionDetail('sandbox-b', 'B', id);
      const before = transcriptSnapshot();
      const mentionedCalls = mock.readMentionedFile.mock.calls.length;
      if (outcome === 'success') tokens.resolve({});
      else tokens.reject(new Error('obsolete token read'));
      await a;
      expect(transcriptSnapshot()).toEqual(before);
      expect(mock.readMentionedFile.mock.calls.length).toBe(mentionedCalls);
    }
  );

  it.each(['success', 'error'] as const)(
    'fences project config %s independently of tab requests',
    async (outcome) => {
      const old = deferred<Record<string, AgentConfig>>();
      const id = open('A');
      configs.mockReturnValueOnce(old.promise);
      mock.getSessionDetail.mockResolvedValueOnce(detail('A'));
      await store.getState().fetchSessionDetail('sandbox-a', 'A', id);
      open('B', 'sandbox-b', true);
      const bConfigs = { helper: { name: 'helper', color: 'blue' } } as Record<string, AgentConfig>;
      configs.mockResolvedValueOnce(bConfigs);
      mock.getSessionDetail.mockResolvedValueOnce(detail('B', 'sandbox-b'));
      await store.getState().fetchSessionDetail('sandbox-b', 'B', id);
      await vi.waitFor(() => expect(store.getState().agentConfigs).toEqual(bConfigs));
      if (outcome === 'success') old.resolve({});
      else old.reject(new Error('obsolete config read'));
      await old.promise.catch(() => undefined);
      expect(store.getState().agentConfigs).toEqual(bConfigs);
    }
  );

  it('allows team lead requests and invalidates them when the team tab is replaced', async () => {
    store.getState().openTab({ type: 'team', teamName: 'sandbox-team', label: 'Team' });
    const id = store.getState().activeTabId!;
    store.setState({ selectedProjectId: 'sandbox-a' });
    mock.getSessionDetail.mockResolvedValueOnce(detail('lead'));
    await store.getState().fetchSessionDetail('sandbox-a', 'lead', id);
    expect(store.getState().tabSessionData[id].sessionDetail?.session.id).toBe('lead');
    expect(store.getState().openTabs[0].label).toBe('Team');
    const pending = deferred<SessionDetail | null>();
    mock.getSessionDetail.mockReturnValueOnce(pending.promise);
    const old = store.getState().fetchSessionDetail('sandbox-a', 'lead', id);
    open('B', 'sandbox-a', true);
    const before = transcriptSnapshot();
    pending.resolve(detail('obsolete-lead'));
    await old;
    expect(transcriptSnapshot()).toEqual(before);
  });

  it('rejects an earlier refresh after a later fetch publishes in the same live tab', async () => {
    const id = open('A');
    mock.getSessionDetail.mockResolvedValueOnce(detail('A'));
    await store.getState().fetchSessionDetail('sandbox-a', 'A', id);
    const pending = deferred<SessionDetail | null>();
    mock.getSessionDetail.mockReturnValueOnce(pending.promise);
    const refresh = store.getState().refreshSessionInPlace('sandbox-a', 'A');
    mock.getSessionDetail.mockResolvedValueOnce(detail('latest-fetch'));
    await store.getState().fetchSessionDetail('sandbox-a', 'A', id);
    const before = transcriptSnapshot();
    pending.resolve(detail('older-refresh'));
    await refresh;
    expect(transcriptSnapshot()).toEqual(before);
    expect(store.getState().sessionDetail?.session.id).toBe('latest-fetch');
    expect(store.getState().sessionDetailLoading).toBe(false);
  });

  it('refreshes inactive owner cache without changing the active transcript', async () => {
    const id = open('A');
    mock.getSessionDetail.mockResolvedValueOnce(detail('A'));
    await store.getState().fetchSessionDetail('sandbox-a', 'A', id);
    const pending = deferred<SessionDetail | null>();
    mock.getSessionDetail.mockReturnValueOnce(pending.promise);
    const refresh = store.getState().refreshSessionInPlace('sandbox-a', 'A');
    const bId = open('B', 'sandbox-b');
    mock.getSessionDetail.mockResolvedValueOnce(detail('B', 'sandbox-b'));
    await store.getState().fetchSessionDetail('sandbox-b', 'B', bId);
    const before = transcriptSnapshot();
    pending.resolve(detail('refreshed-A'));
    await refresh;
    const after = transcriptSnapshot();
    expect({ ...after, tabSessionData: before.tabSessionData }).toEqual(before);
    expect(after.tabSessionData[id].sessionDetail?.session.id).toBe('refreshed-A');
    expect(after.tabSessionData[bId]).toEqual(before.tabSessionData[bId]);
  });

  it('drops refresh after close/reopen of the same session and suppresses stale queued retry', async () => {
    const id = open('A');
    mock.getSessionDetail.mockResolvedValueOnce(detail('A'));
    await store.getState().fetchSessionDetail('sandbox-a', 'A', id);
    const pending = deferred<SessionDetail | null>();
    mock.getSessionDetail.mockReturnValueOnce(pending.promise);
    const refresh = store.getState().refreshSessionInPlace('sandbox-a', 'A');
    await store.getState().refreshSessionInPlace('sandbox-a', 'A');
    store.getState().closeTab(id);
    vi.stubGlobal('crypto', { randomUUID: () => id });
    open('A');
    mock.getSessionDetail.mockResolvedValueOnce(detail('new-owner'));
    await store.getState().fetchSessionDetail('sandbox-a', 'A', id);
    const before = transcriptSnapshot();
    const calls = mock.getSessionDetail.mock.calls.length;
    pending.resolve(detail('obsolete-refresh'));
    await refresh;
    expect(transcriptSnapshot()).toEqual(before);
    expect(mock.getSessionDetail).toHaveBeenCalledTimes(calls);
  });
});
