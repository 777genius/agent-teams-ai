/**
 * Tab slice unit tests.
 * Tests tab state management including deduplication, forceNewTab, scroll position,
 * and the unified navigation request model.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { installMockElectronAPI, type MockElectronAPI } from '../../mocks/electronAPI';

import { createTestStore, type TestStore } from './storeTestUtils';

import type { TabNavigationRequest } from '../../../src/renderer/types/tabs';

describe('tabSlice', () => {
  let store: TestStore;
  let mockAPI: MockElectronAPI;

  beforeEach(() => {
    vi.useFakeTimers();
    mockAPI = installMockElectronAPI();
    store = createTestStore();

    // Mock crypto.randomUUID for predictable tab IDs
    let uuidCounter = 0;
    vi.stubGlobal('crypto', {
      randomUUID: () => `test-uuid-${++uuidCounter}`,
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe('openTab', () => {
    describe('deduplication', () => {
      it('should focus existing tab when opening same session', () => {
        // Open initial session tab
        store.getState().openTab({
          type: 'session',
          sessionId: 'session-1',
          projectId: 'project-1',
          label: 'First Session',
        });

        const initialTabId = store.getState().activeTabId;
        expect(store.getState().openTabs).toHaveLength(1);

        // Open another tab
        store.getState().openTab({
          type: 'session',
          sessionId: 'session-2',
          projectId: 'project-1',
          label: 'Second Session',
        });

        expect(store.getState().openTabs).toHaveLength(2);
        expect(store.getState().activeTabId).not.toBe(initialTabId);

        // Try to open session-1 again - should deduplicate
        store.getState().openTab({
          type: 'session',
          sessionId: 'session-1',
          projectId: 'project-1',
          label: 'First Session Again',
        });

        expect(store.getState().openTabs).toHaveLength(2);
        expect(store.getState().activeTabId).toBe(initialTabId);
      });

      it('should bypass deduplication when forceNewTab is true', () => {
        // Open initial session tab
        store.getState().openTab({
          type: 'session',
          sessionId: 'session-1',
          projectId: 'project-1',
          label: 'First Session',
        });

        const initialTabId = store.getState().activeTabId;
        expect(store.getState().openTabs).toHaveLength(1);

        // Open same session with forceNewTab
        store.getState().openTab(
          {
            type: 'session',
            sessionId: 'session-1',
            projectId: 'project-1',
            label: 'First Session (New Tab)',
          },
          { forceNewTab: true }
        );

        // Should have 2 tabs now, both for the same session
        expect(store.getState().openTabs).toHaveLength(2);
        expect(store.getState().activeTabId).not.toBe(initialTabId);

        // Both tabs should have the same sessionId
        const sessionTabs = store.getState().openTabs.filter((t) => t.sessionId === 'session-1');
        expect(sessionTabs).toHaveLength(2);
      });

      it('should reuse existing dashboard tab instead of creating duplicate', () => {
        store.getState().openDashboard();
        const firstTabId = store.getState().activeTabId;

        store.getState().openDashboard();

        expect(store.getState().openTabs).toHaveLength(1);
        expect(store.getState().openTabs.filter((t) => t.type === 'dashboard')).toHaveLength(1);
        expect(store.getState().activeTabId).toBe(firstTabId);
      });
    });

    describe('dashboard replacement', () => {
      it('should replace active dashboard tab when opening session', () => {
        store.getState().openDashboard();
        const dashboardTabId = store.getState().activeTabId;

        store.getState().openTab({
          type: 'session',
          sessionId: 'session-1',
          projectId: 'project-1',
          label: 'Session 1',
        });

        expect(store.getState().openTabs).toHaveLength(1);
        // Tab should keep same ID (position preserved)
        expect(store.getState().activeTabId).toBe(dashboardTabId);
        // But now it's a session tab
        expect(store.getState().openTabs[0].type).toBe('session');
        expect(store.getState().openTabs[0].sessionId).toBe('session-1');
      });
    });

    describe('label truncation', () => {
      it('should truncate labels longer than 50 characters', () => {
        const longLabel = 'A'.repeat(60);

        store.getState().openTab({
          type: 'session',
          sessionId: 'session-1',
          projectId: 'project-1',
          label: longLabel,
        });

        const tab = store.getState().openTabs[0];
        expect(tab.label).toHaveLength(50);
        expect(tab.label.endsWith('…')).toBe(true);
      });
    });
  });

  describe('closeTab', () => {
    it('should focus adjacent tab when closing active tab', () => {
      // Open 3 tabs
      store.getState().openTab({
        type: 'session',
        sessionId: 'session-1',
        projectId: 'project-1',
        label: 'Tab 1',
      });

      store.getState().openTab({
        type: 'session',
        sessionId: 'session-2',
        projectId: 'project-1',
        label: 'Tab 2',
      });
      const tab2Id = store.getState().activeTabId;

      store.getState().openTab({
        type: 'session',
        sessionId: 'session-3',
        projectId: 'project-1',
        label: 'Tab 3',
      });
      const tab3Id = store.getState().activeTabId;

      // Close tab 3 (active tab)
      store.getState().closeTab(tab3Id!);

      // Should focus tab 2 (previous tab)
      expect(store.getState().openTabs).toHaveLength(2);
      expect(store.getState().activeTabId).toBe(tab2Id);
    });

    it('should reset state when all tabs closed', () => {
      // Setup some state
      store.setState({
        selectedProjectId: 'project-1',
        selectedSessionId: 'session-1',
      });

      store.getState().openTab({
        type: 'session',
        sessionId: 'session-1',
        projectId: 'project-1',
        label: 'Tab 1',
      });
      const tabId = store.getState().activeTabId;

      store.getState().closeTab(tabId!);

      expect(store.getState().openTabs).toHaveLength(0);
      expect(store.getState().activeTabId).toBeNull();
      expect(store.getState().selectedProjectId).toBeNull();
      expect(store.getState().selectedSessionId).toBeNull();
    });
  });

  describe('setActiveTab', () => {
    it('should update activeTabId', () => {
      store.getState().openTab({
        type: 'session',
        sessionId: 'session-1',
        projectId: 'project-1',
        label: 'Session 1',
      });
      const tab1Id = store.getState().activeTabId;

      store.getState().openTab({
        type: 'session',
        sessionId: 'session-2',
        projectId: 'project-1',
        label: 'Session 2',
      });

      // Switch back to first tab
      store.getState().setActiveTab(tab1Id!);

      expect(store.getState().activeTabId).toBe(tab1Id);
    });

    it('should sync selectedRepositoryId and selectedWorktreeId when switching tabs across repos', () => {
      // Setup repositoryGroups with two repos, each with one worktree
      store.setState({
        repositoryGroups: [
          {
            id: 'repo-A',
            identity: null,
            name: 'Repo A',
            worktrees: [
              {
                id: 'worktree-A',
                path: '/path/a',
                name: 'main',
                isMainWorktree: true,
                source: 'git',
                sessions: [],
                createdAt: 0,
              },
            ],
            totalSessions: 0,
          },
          {
            id: 'repo-B',
            identity: null,
            name: 'Repo B',
            worktrees: [
              {
                id: 'worktree-B',
                path: '/path/b',
                name: 'develop',
                isMainWorktree: true,
                source: 'git',
                sessions: [],
                createdAt: 0,
              },
            ],
            totalSessions: 0,
          },
        ] as never[],
        selectedRepositoryId: 'repo-A',
        selectedWorktreeId: 'worktree-A',
      });

      // Open tab from repo A
      store.getState().openTab({
        type: 'session',
        sessionId: 'session-A',
        projectId: 'worktree-A',
        label: 'Session A',
      });
      const tabAId = store.getState().activeTabId;

      // Open tab from repo B
      store.getState().openTab({
        type: 'session',
        sessionId: 'session-B',
        projectId: 'worktree-B',
        label: 'Session B',
      });

      // Switch back to tab A
      store.getState().setActiveTab(tabAId!);
      expect(store.getState().selectedRepositoryId).toBe('repo-A');
      expect(store.getState().selectedWorktreeId).toBe('worktree-A');

      // Switch to tab B
      const tabBId = store.getState().openTabs.find((t) => t.sessionId === 'session-B')?.id;
      store.getState().setActiveTab(tabBId!);
      expect(store.getState().selectedRepositoryId).toBe('repo-B');
      expect(store.getState().selectedWorktreeId).toBe('worktree-B');
    });

    it('should preserve sidebar state for non-session tabs', () => {
      // Setup initial state with projects data so setActiveTab can find the project
      store.setState({
        selectedProjectId: 'project-1',
        selectedSessionId: 'session-1',
        projects: [
          { id: 'project-1', name: 'Project 1', path: '/path/1', sessions: ['session-1'] },
          { id: 'project-2', name: 'Project 2', path: '/path/2', sessions: ['session-2'] },
        ] as never[],
      });

      // Open session-2 tab first (this doesn't call setActiveTab, just sets activeTabId)
      store.getState().openTab({
        type: 'session',
        sessionId: 'session-2',
        projectId: 'project-2',
        label: 'Session 2',
      });
      const sessionTabId = store.getState().activeTabId;

      // Manually call setActiveTab to sync sidebar state (simulating user click)
      store.getState().setActiveTab(sessionTabId!);
      expect(store.getState().selectedProjectId).toBe('project-2');

      // Open dashboard tab
      store.getState().openDashboard();
      const dashboardTabId = store.getState().activeTabId;

      // Switch to dashboard (should preserve sidebar state)
      store.getState().setActiveTab(dashboardTabId!);

      expect(store.getState().activeTabId).toBe(dashboardTabId);
      // Sidebar state should be preserved (not cleared) when switching to dashboard
      expect(store.getState().selectedProjectId).toBe('project-2');
    });

    it('should re-select the team when switching to a graph tab for another team', () => {
      const selectTeamSpy = vi.fn(async () => undefined);
      store.setState({
        selectedTeamName: 'team-a',
        selectedTeamData: {
          teamName: 'team-a',
          config: { name: 'Team A', projectPath: '/repo/a' },
          members: [],
          tasks: [],
          messages: [],
          kanbanState: { teamName: 'team-a', reviewers: [], tasks: {} },
          processes: [],
          isAlive: true,
        },
        selectTeam: selectTeamSpy,
      } as never);

      store.getState().openTab({
        type: 'graph',
        teamName: 'team-b',
        label: 'Team B Graph',
      });
      const graphTabId = store.getState().activeTabId!;

      store.getState().setActiveTab(graphTabId);

      expect(selectTeamSpy).toHaveBeenCalledWith('team-b');
    });
  });

  describe('saveTabScrollPosition', () => {
    it('should save scroll position for a tab', () => {
      store.getState().openTab({
        type: 'session',
        sessionId: 'session-1',
        projectId: 'project-1',
        label: 'Session 1',
      });
      const tabId = store.getState().activeTabId!;

      // Initially undefined
      expect(store.getState().openTabs[0].savedScrollTop).toBeUndefined();

      // Save scroll position
      store.getState().saveTabScrollPosition(tabId, 500);

      expect(store.getState().openTabs[0].savedScrollTop).toBe(500);
    });

    it('should only update the specified tab', () => {
      store.getState().openTab({
        type: 'session',
        sessionId: 'session-1',
        projectId: 'project-1',
        label: 'Session 1',
      });
      const tab1Id = store.getState().activeTabId!;

      store.getState().openTab({
        type: 'session',
        sessionId: 'session-2',
        projectId: 'project-1',
        label: 'Session 2',
      });

      // Save scroll position for tab 1
      store.getState().saveTabScrollPosition(tab1Id, 300);

      // Tab 1 should have scroll position, tab 2 should not
      const tab1 = store.getState().openTabs.find((t) => t.id === tab1Id);
      const tab2 = store.getState().openTabs.find((t) => t.id !== tab1Id);

      expect(tab1?.savedScrollTop).toBe(300);
      expect(tab2?.savedScrollTop).toBeUndefined();
    });
  });

  describe('setTabContextPanelVisible', () => {
    it('should set context panel visibility for a tab', () => {
      store.getState().openTab({
        type: 'session',
        sessionId: 'session-1',
        projectId: 'project-1',
        label: 'Session 1',
      });
      const tabId = store.getState().activeTabId!;

      // Initially undefined
      expect(store.getState().openTabs[0].showContextPanel).toBeUndefined();

      // Set to true
      store.getState().setTabContextPanelVisible(tabId, true);
      expect(store.getState().openTabs[0].showContextPanel).toBe(true);

      // Set to false
      store.getState().setTabContextPanelVisible(tabId, false);
      expect(store.getState().openTabs[0].showContextPanel).toBe(false);
    });

    it('should only update the specified tab', () => {
      store.getState().openTab({
        type: 'session',
        sessionId: 'session-1',
        projectId: 'project-1',
        label: 'Session 1',
      });
      const tab1Id = store.getState().activeTabId!;

      store.getState().openTab({
        type: 'session',
        sessionId: 'session-2',
        projectId: 'project-1',
        label: 'Session 2',
      });

      // Set context panel visible for tab 1
      store.getState().setTabContextPanelVisible(tab1Id, true);

      // Tab 1 should have context panel visible, tab 2 should not
      const tab1 = store.getState().openTabs.find((t) => t.id === tab1Id);
      const tab2 = store.getState().openTabs.find((t) => t.id !== tab1Id);

      expect(tab1?.showContextPanel).toBe(true);
      expect(tab2?.showContextPanel).toBeUndefined();
    });
  });

  describe('enqueueTabNavigation', () => {
    it('should set pendingNavigation on the tab', () => {
      store.getState().openTab({
        type: 'session',
        sessionId: 'session-1',
        projectId: 'project-1',
        label: 'Session 1',
      });

      const tabId = store.getState().activeTabId!;
      const request: TabNavigationRequest = {
        id: 'nav-1',
        kind: 'error',
        source: 'notification',
        highlight: 'red',
        payload: {
          errorId: 'error-1',
          errorTimestamp: 12345,
          toolUseId: 'tool-1',
          lineNumber: 42,
        },
      };

      store.getState().enqueueTabNavigation(tabId, request);

      const tab = store.getState().openTabs[0];
      expect(tab.pendingNavigation).toEqual(request);
    });

    it('should replace existing pendingNavigation with new request', () => {
      store.getState().openTab({
        type: 'session',
        sessionId: 'session-1',
        projectId: 'project-1',
        label: 'Session 1',
      });

      const tabId = store.getState().activeTabId!;
      const request1: TabNavigationRequest = {
        id: 'nav-1',
        kind: 'error',
        source: 'notification',
        highlight: 'red',
        payload: { errorId: 'e1', errorTimestamp: 100 },
      };
      const request2: TabNavigationRequest = {
        id: 'nav-2',
        kind: 'error',
        source: 'notification',
        highlight: 'red',
        payload: { errorId: 'e2', errorTimestamp: 200 },
      };

      store.getState().enqueueTabNavigation(tabId, request1);
      store.getState().enqueueTabNavigation(tabId, request2);

      const tab = store.getState().openTabs[0];
      expect(tab.pendingNavigation?.id).toBe('nav-2');
    });

    it('should only update the specified tab', () => {
      store.getState().openTab({
        type: 'session',
        sessionId: 'session-1',
        projectId: 'project-1',
        label: 'Session 1',
      });
      const tab1Id = store.getState().activeTabId!;

      store.getState().openTab({
        type: 'session',
        sessionId: 'session-2',
        projectId: 'project-1',
        label: 'Session 2',
      });

      const request: TabNavigationRequest = {
        id: 'nav-1',
        kind: 'search',
        source: 'commandPalette',
        highlight: 'yellow',
        payload: { query: 'test', messageTimestamp: 1234, matchedText: 'match' },
      };

      store.getState().enqueueTabNavigation(tab1Id, request);

      const tab1 = store.getState().openTabs.find((t) => t.id === tab1Id);
      const tab2 = store.getState().openTabs.find((t) => t.id !== tab1Id);
      expect(tab1?.pendingNavigation).toEqual(request);
      expect(tab2?.pendingNavigation).toBeUndefined();
    });
  });

  describe('consumeTabNavigation', () => {
    it('should clear pendingNavigation and set lastConsumedNavigationId', () => {
      store.getState().openTab({
        type: 'session',
        sessionId: 'session-1',
        projectId: 'project-1',
        label: 'Session 1',
      });

      const tabId = store.getState().activeTabId!;
      const request: TabNavigationRequest = {
        id: 'nav-1',
        kind: 'error',
        source: 'notification',
        highlight: 'red',
        payload: { errorId: 'error-1', errorTimestamp: 12345 },
      };

      store.getState().enqueueTabNavigation(tabId, request);
      expect(store.getState().openTabs[0].pendingNavigation).toBeDefined();

      store.getState().consumeTabNavigation(tabId, 'nav-1');

      const tab = store.getState().openTabs[0];
      expect(tab.pendingNavigation).toBeUndefined();
      expect(tab.lastConsumedNavigationId).toBe('nav-1');
    });

    it('should not clear if requestId does not match', () => {
      store.getState().openTab({
        type: 'session',
        sessionId: 'session-1',
        projectId: 'project-1',
        label: 'Session 1',
      });

      const tabId = store.getState().activeTabId!;
      const request: TabNavigationRequest = {
        id: 'nav-1',
        kind: 'error',
        source: 'notification',
        highlight: 'red',
        payload: { errorId: 'error-1', errorTimestamp: 12345 },
      };

      store.getState().enqueueTabNavigation(tabId, request);
      store.getState().consumeTabNavigation(tabId, 'wrong-id');

      // Should still have pendingNavigation since IDs don't match
      const tab = store.getState().openTabs[0];
      expect(tab.pendingNavigation).toEqual(request);
    });
  });

  describe('isSessionOpen', () => {
    it('should return true if session is open in any tab', () => {
      store.getState().openTab({
        type: 'session',
        sessionId: 'session-1',
        projectId: 'project-1',
        label: 'Session 1',
      });

      expect(store.getState().isSessionOpen('session-1')).toBe(true);
      expect(store.getState().isSessionOpen('session-2')).toBe(false);
    });
  });

  describe('navigateToSession', () => {
    it('should open new tab if session not already open', () => {
      mockAPI.getSessionDetail.mockResolvedValue({
        session: { id: 'session-1' },
        chunks: [],
      } as never);

      store.getState().navigateToSession('project-1', 'session-1', false);

      expect(store.getState().openTabs).toHaveLength(1);
      expect(store.getState().openTabs[0].sessionId).toBe('session-1');
    });

    it('should focus existing tab with search navigation request', () => {
      // First open the session
      store.getState().openTab({
        type: 'session',
        sessionId: 'session-1',
        projectId: 'project-1',
        label: 'Session 1',
      });
      const existingTabId = store.getState().activeTabId;

      // Open another tab to switch away
      store.getState().openDashboard();

      // Navigate to same session with search context
      store.getState().navigateToSession('project-1', 'session-1', true, {
        query: 'test query',
        messageTimestamp: 1234567890,
        matchedText: 'matched text',
      });

      // Should focus existing tab
      expect(store.getState().activeTabId).toBe(existingTabId);
      // Should have a pending search navigation request
      const tab = store.getState().openTabs.find((t) => t.id === existingTabId);
      expect(tab?.pendingNavigation?.kind).toBe('search');
      expect(tab?.pendingNavigation?.payload).toEqual({
        query: 'test query',
        messageTimestamp: 1234567890,
        matchedText: 'matched text',
      });
    });

    it('should enqueue search navigation on new tab', () => {
      mockAPI.getSessionDetail.mockResolvedValue({
        session: { id: 'session-1' },
        chunks: [],
      } as never);

      store.getState().navigateToSession('project-1', 'session-1', false, {
        query: 'find me',
        messageTimestamp: 9999,
        matchedText: 'found',
      });

      const tab = store.getState().openTabs[0];
      expect(tab.pendingNavigation?.kind).toBe('search');
      expect(tab.pendingNavigation?.source).toBe('commandPalette');
      expect(tab.pendingNavigation?.highlight).toBe('yellow');
    });
  });
});
