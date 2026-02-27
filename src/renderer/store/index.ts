/**
 * Store index - combines all slices and exports the unified store.
 */

import { api } from '@renderer/api';
import { cleanupStale as cleanupCommentReadState } from '@renderer/services/commentReadStorage';
import { create } from 'zustand';

import { createChangeReviewSlice } from './slices/changeReviewSlice';
import { createCliInstallerSlice } from './slices/cliInstallerSlice';
import { createConfigSlice } from './slices/configSlice';
import { createConnectionSlice } from './slices/connectionSlice';
import { createContextSlice } from './slices/contextSlice';
import { createConversationSlice } from './slices/conversationSlice';
import { createNotificationSlice } from './slices/notificationSlice';
import { createPaneSlice } from './slices/paneSlice';
import { createProjectSlice } from './slices/projectSlice';
import { createRepositorySlice } from './slices/repositorySlice';
import { createSessionDetailSlice } from './slices/sessionDetailSlice';
import { createSessionSlice } from './slices/sessionSlice';
import { createSubagentSlice } from './slices/subagentSlice';
import { createTabSlice } from './slices/tabSlice';
import { createTabUISlice } from './slices/tabUISlice';
import { createTeamSlice } from './slices/teamSlice';
import { createUISlice } from './slices/uiSlice';
import { createUpdateSlice } from './slices/updateSlice';

import type { DetectedError } from '../types/data';
import type { AppState } from './types';
import type { CliInstallerProgress, TeamChangeEvent, UpdaterStatus } from '@shared/types';

// =============================================================================
// Store Creation
// =============================================================================

export const useStore = create<AppState>()((...args) => ({
  ...createProjectSlice(...args),
  ...createRepositorySlice(...args),
  ...createSessionSlice(...args),
  ...createSessionDetailSlice(...args),
  ...createSubagentSlice(...args),
  ...createTeamSlice(...args),
  ...createConversationSlice(...args),
  ...createTabSlice(...args),
  ...createTabUISlice(...args),
  ...createPaneSlice(...args),
  ...createUISlice(...args),
  ...createNotificationSlice(...args),
  ...createConfigSlice(...args),
  ...createConnectionSlice(...args),
  ...createContextSlice(...args),
  ...createUpdateSlice(...args),
  ...createChangeReviewSlice(...args),
  ...createCliInstallerSlice(...args),
}));

// =============================================================================
// Re-exports
// =============================================================================

// =============================================================================
// Store Initialization - Subscribe to IPC Events
// =============================================================================

/**
 * Initialize notification event listeners and fetch initial notification count.
 * Call this once when the app starts (e.g., in App.tsx useEffect).
 */
export function initializeNotificationListeners(): () => void {
  void cleanupCommentReadState();
  const cleanupFns: (() => void)[] = [];
  useStore.getState().subscribeProvisioningProgress();
  cleanupFns.push(() => {
    useStore.getState().unsubscribeProvisioningProgress();
  });
  void useStore.getState().fetchTeams();
  const pendingSessionRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingProjectRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let teamRefreshTimer: ReturnType<typeof setTimeout> | null = null;

  let teamListRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let globalTasksRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const SESSION_REFRESH_DEBOUNCE_MS = 150;
  const PROJECT_REFRESH_DEBOUNCE_MS = 300;
  const TEAM_REFRESH_THROTTLE_MS = 800;
  const TEAM_LIST_REFRESH_THROTTLE_MS = 2000;
  const GLOBAL_TASKS_REFRESH_THROTTLE_MS = 500;
  const getBaseProjectId = (projectId: string | null | undefined): string | null => {
    if (!projectId) return null;
    const separatorIndex = projectId.indexOf('::');
    return separatorIndex >= 0 ? projectId.slice(0, separatorIndex) : projectId;
  };

  const scheduleSessionRefresh = (projectId: string, sessionId: string): void => {
    const key = `${projectId}/${sessionId}`;
    // Throttle (not trailing debounce): keep at most one pending refresh per session.
    // Debounce can delay updates indefinitely while the file is continuously appended.
    if (pendingSessionRefreshTimers.has(key)) {
      return;
    }
    const timer = setTimeout(() => {
      pendingSessionRefreshTimers.delete(key);
      const state = useStore.getState();
      void state.refreshSessionInPlace(projectId, sessionId);
    }, SESSION_REFRESH_DEBOUNCE_MS);
    pendingSessionRefreshTimers.set(key, timer);
  };

  const scheduleProjectRefresh = (projectId: string): void => {
    const existingTimer = pendingProjectRefreshTimers.get(projectId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }
    const timer = setTimeout(() => {
      pendingProjectRefreshTimers.delete(projectId);
      const state = useStore.getState();
      void state.refreshSessionsInPlace(projectId);
    }, PROJECT_REFRESH_DEBOUNCE_MS);
    pendingProjectRefreshTimers.set(projectId, timer);
  };

  // Listen for new notifications from main process
  if (api.notifications?.onNew) {
    const cleanup = api.notifications.onNew((_event: unknown, error: unknown) => {
      // Cast the error to DetectedError type
      const notification = error as DetectedError;
      if (notification?.id) {
        // Keep list in sync immediately; unread count is synced via notification:updated/fetch.
        useStore.setState((state) => {
          if (state.notifications.some((n) => n.id === notification.id)) {
            return {};
          }
          return { notifications: [notification, ...state.notifications].slice(0, 200) };
        });
      }
    });
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }
  }

  // Listen for notification updates from main process
  if (api.notifications?.onUpdated) {
    const cleanup = api.notifications.onUpdated(
      (_event: unknown, payload: { total: number; unreadCount: number }) => {
        const unreadCount =
          typeof payload.unreadCount === 'number' && Number.isFinite(payload.unreadCount)
            ? Math.max(0, Math.floor(payload.unreadCount))
            : 0;
        useStore.setState({ unreadCount });
      }
    );
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }
  }

  // Navigate to error when user clicks a native OS notification
  if (api.notifications?.onClicked) {
    const cleanup = api.notifications.onClicked((_event: unknown, data: unknown) => {
      const error = data as DetectedError;
      if (error?.id && error?.sessionId && error?.projectId) {
        useStore.getState().navigateToError(error);
      }
    });
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }
  }

  // Fetch after listeners are attached so startup events do not get overwritten by a stale response.
  void useStore.getState().fetchNotifications();

  /**
   * Check if a session is visible in any pane (not just the focused pane's active tab).
   * This ensures file change and task-list listeners refresh sessions shown in any split pane.
   */
  const isSessionVisibleInAnyPane = (sessionId: string): boolean => {
    const { paneLayout } = useStore.getState();
    return paneLayout.panes.some(
      (pane) =>
        pane.activeTabId != null &&
        pane.tabs.some(
          (tab) =>
            tab.id === pane.activeTabId && tab.type === 'session' && tab.sessionId === sessionId
        )
    );
  };

  const isTeamVisibleInAnyPane = (teamName: string): boolean => {
    const { paneLayout } = useStore.getState();
    return paneLayout.panes.some((pane) => {
      if (!pane.activeTabId) return false;
      return pane.tabs.some(
        (tab) => tab.id === pane.activeTabId && tab.type === 'team' && tab.teamName === teamName
      );
    });
  };

  // Listen for task-list file changes to refresh currently viewed session metadata
  if (api.onTodoChange) {
    const cleanup = api.onTodoChange((event) => {
      if (!event.sessionId || event.type === 'unlink') {
        return;
      }

      const state = useStore.getState();
      const isViewingSession =
        state.selectedSessionId === event.sessionId || isSessionVisibleInAnyPane(event.sessionId);

      if (isViewingSession) {
        // Find the project ID from any pane's tab that shows this session
        const allTabs = state.getAllPaneTabs();
        const sessionTab = allTabs.find(
          (t) => t.type === 'session' && t.sessionId === event.sessionId
        );
        if (sessionTab?.projectId) {
          scheduleSessionRefresh(sessionTab.projectId, event.sessionId);
        }
      }

      // Refresh project sessions list if applicable
      const activeTab = state.getActiveTab();
      const activeProjectId =
        activeTab?.type === 'session' && typeof activeTab.projectId === 'string'
          ? activeTab.projectId
          : null;
      if (activeProjectId && activeProjectId === state.selectedProjectId) {
        scheduleProjectRefresh(activeProjectId);
      }
    });
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }
  }

  // Listen for file changes to auto-refresh current session and detect new sessions
  if (api.onFileChange) {
    const cleanup = api.onFileChange((event) => {
      // Skip unlink events
      if (event.type === 'unlink') {
        return;
      }

      const state = useStore.getState();
      const selectedProjectId = state.selectedProjectId;
      const selectedProjectBaseId = getBaseProjectId(selectedProjectId);
      const eventProjectBaseId = getBaseProjectId(event.projectId);
      const matchesSelectedProject =
        !!selectedProjectId &&
        (eventProjectBaseId == null || selectedProjectBaseId === eventProjectBaseId);
      const isTopLevelSessionEvent = !event.isSubagent;
      const isUnknownSessionInSidebar =
        event.sessionId == null ||
        !state.sessions.some((session) => session.id === event.sessionId);
      const shouldRefreshForPotentialNewSession =
        isTopLevelSessionEvent &&
        matchesSelectedProject &&
        isUnknownSessionInSidebar &&
        (event.type === 'add' || (state.connectionMode === 'local' && event.type === 'change'));

      // Refresh sidebar session list only when a truly new top-level session appears.
      // Local fs.watch can report "change" before/without "add" for newly created files.
      if (shouldRefreshForPotentialNewSession) {
        if (matchesSelectedProject && selectedProjectId) {
          scheduleProjectRefresh(selectedProjectId);
        }
      }

      // Keep opened session view in sync on content changes.
      // Some local writers emit rename/add for in-place updates, so include "add".
      if ((event.type === 'change' || event.type === 'add') && selectedProjectId) {
        const activeSessionId = state.selectedSessionId;
        const eventSessionId = event.sessionId;
        const isViewingEventSession =
          !!eventSessionId &&
          (activeSessionId === eventSessionId || isSessionVisibleInAnyPane(eventSessionId));
        const shouldFallbackRefreshActiveSession =
          matchesSelectedProject && !eventSessionId && !!activeSessionId;
        const sessionIdToRefresh =
          (isViewingEventSession ? eventSessionId : null) ??
          (shouldFallbackRefreshActiveSession ? activeSessionId : null);

        if (sessionIdToRefresh) {
          const allTabs = state.getAllPaneTabs();
          const visibleSessionTab = allTabs.find(
            (tab) => tab.type === 'session' && tab.sessionId === sessionIdToRefresh
          );
          const refreshProjectId = visibleSessionTab?.projectId ?? selectedProjectId;

          // Use refreshSessionInPlace to avoid flickering and preserve UI state
          scheduleSessionRefresh(refreshProjectId, sessionIdToRefresh);
        }
      }
    });
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }
  }

  if (api.teams?.onTeamChange) {
    const cleanup = api.teams.onTeamChange((_event: unknown, event: TeamChangeEvent) => {
      // Immediate in-memory update for lead activity — no filesystem refresh needed
      if (event.type === 'lead-activity' && event.detail) {
        useStore.setState((prev) => ({
          leadActivityByTeam: {
            ...prev.leadActivityByTeam,
            [event.teamName]: event.detail as 'active' | 'idle' | 'offline',
          },
        }));
        return;
      }

      // Throttled refresh of summary list (keeps TeamListView current without flooding).
      if (!teamListRefreshTimer) {
        teamListRefreshTimer = setTimeout(() => {
          teamListRefreshTimer = null;
          void useStore.getState().fetchTeams();
        }, TEAM_LIST_REFRESH_THROTTLE_MS);
      }

      // Throttled refresh of global tasks list for sidebar.
      if (!globalTasksRefreshTimer) {
        globalTasksRefreshTimer = setTimeout(() => {
          globalTasksRefreshTimer = null;
          void useStore.getState().fetchAllTasks();
        }, GLOBAL_TASKS_REFRESH_THROTTLE_MS);
      }

      if (!event?.teamName || !isTeamVisibleInAnyPane(event.teamName)) {
        return;
      }

      // Throttle (not debounce): keep at most one pending detail refresh.
      // Debounce would delay indefinitely while inbox messages keep arriving.
      if (teamRefreshTimer) {
        return;
      }

      teamRefreshTimer = setTimeout(() => {
        teamRefreshTimer = null;
        const current = useStore.getState();
        void current.refreshTeamData(event.teamName);
      }, TEAM_REFRESH_THROTTLE_MS);
    });

    if (typeof cleanup === 'function') {
      cleanupFns.push(() => {
        cleanup();
        if (teamRefreshTimer) {
          clearTimeout(teamRefreshTimer);
          teamRefreshTimer = null;
        }
        if (teamListRefreshTimer) {
          clearTimeout(teamListRefreshTimer);
          teamListRefreshTimer = null;
        }
        if (globalTasksRefreshTimer) {
          clearTimeout(globalTasksRefreshTimer);
          globalTasksRefreshTimer = null;
        }
      });
    }
  }

  // Auto-check CLI status on startup
  if (api.cliInstaller) {
    void useStore.getState().fetchCliStatus();
  }

  // Listen for CLI installer progress events from main process
  let cliCompletedRevertTimer: ReturnType<typeof setTimeout> | null = null;
  if (api.cliInstaller?.onProgress) {
    const cleanup = api.cliInstaller.onProgress((_event: unknown, data: unknown) => {
      const progress = data as CliInstallerProgress;

      // Clear any pending auto-revert timer on new events
      if (progress.type !== 'completed' && cliCompletedRevertTimer) {
        clearTimeout(cliCompletedRevertTimer);
        cliCompletedRevertTimer = null;
      }

      const detail = progress.detail ?? null;

      switch (progress.type) {
        case 'checking':
          useStore.setState({ cliInstallerState: 'checking', cliInstallerDetail: detail });
          break;
        case 'downloading':
          useStore.setState({
            cliInstallerState: 'downloading',
            cliDownloadProgress: progress.percent ?? 0,
            cliDownloadTransferred: progress.transferred ?? 0,
            cliDownloadTotal: progress.total ?? 0,
            cliInstallerDetail: detail,
          });
          break;
        case 'verifying':
          useStore.setState({ cliInstallerState: 'verifying', cliInstallerDetail: detail });
          break;
        case 'installing': {
          // Accumulate log lines and raw chunks for xterm.js rendering
          const prevLogs = useStore.getState().cliInstallerLogs;
          const prevRaw = useStore.getState().cliInstallerRawChunks;
          const newLogs = detail ? [...prevLogs, detail].slice(-50) : prevLogs;
          const newRaw = progress.rawChunk ? [...prevRaw, progress.rawChunk].slice(-200) : prevRaw;
          useStore.setState({
            cliInstallerState: 'installing',
            cliInstallerDetail: detail,
            cliInstallerLogs: newLogs,
            cliInstallerRawChunks: newRaw,
          });
          break;
        }
        case 'completed':
          useStore.setState({
            cliInstallerState: 'completed',
            cliCompletedVersion: progress.version ?? null,
            cliInstallerDetail: null,
          });
          // Re-fetch status after install and auto-revert to idle after 3s
          void useStore.getState().fetchCliStatus();
          cliCompletedRevertTimer = setTimeout(() => {
            cliCompletedRevertTimer = null;
            // Only revert if still in 'completed' state (not overwritten by a new install)
            if (useStore.getState().cliInstallerState === 'completed') {
              useStore.setState({ cliInstallerState: 'idle' });
            }
          }, 3000);
          break;
        case 'error':
          useStore.setState({
            cliInstallerState: 'error',
            cliInstallerError: progress.error ?? 'Unknown error',
          });
          break;
      }
    });
    if (typeof cleanup === 'function') {
      cleanupFns.push(() => {
        cleanup();
        if (cliCompletedRevertTimer) {
          clearTimeout(cliCompletedRevertTimer);
          cliCompletedRevertTimer = null;
        }
      });
    }
  }

  // Listen for updater status events from main process
  if (api.updater?.onStatus) {
    const cleanup = api.updater.onStatus((_event: unknown, status: unknown) => {
      const s = status as UpdaterStatus;
      switch (s.type) {
        case 'checking':
          useStore.setState({ updateStatus: 'checking' });
          break;
        case 'available':
          useStore.setState({
            updateStatus: 'available',
            availableVersion: s.version ?? null,
            releaseNotes: s.releaseNotes ?? null,
            showUpdateDialog: true,
          });
          break;
        case 'not-available':
          useStore.setState({ updateStatus: 'not-available' });
          break;
        case 'downloading':
          useStore.setState({
            updateStatus: 'downloading',
            downloadProgress: s.progress?.percent ?? 0,
          });
          break;
        case 'downloaded':
          useStore.setState({
            updateStatus: 'downloaded',
            downloadProgress: 100,
            availableVersion: s.version ?? useStore.getState().availableVersion,
          });
          break;
        case 'error':
          useStore.setState({
            updateStatus: 'error',
            updateError: s.error ?? 'Unknown error',
          });
          break;
      }
    });
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }
  }

  // Listen for SSH connection status changes from main process
  // NOTE: Only syncs connection status here. Data fetching is handled by
  // connectionSlice.connectSsh/disconnectSsh and contextSlice.switchContext.
  if (api.ssh?.onStatus) {
    const cleanup = api.ssh.onStatus((_event: unknown, status: unknown) => {
      const s = status as { state: string; host: string | null; error: string | null };
      useStore
        .getState()
        .setConnectionStatus(
          s.state as 'disconnected' | 'connecting' | 'connected' | 'error',
          s.host,
          s.error
        );
    });
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }
  }

  // Listen for context changes from main process (e.g., SSH disconnect)
  if (api.context?.onChanged) {
    const cleanup = api.context.onChanged((_event: unknown, data: unknown) => {
      const { id } = data as { id: string; type: string };
      const currentContextId = useStore.getState().activeContextId;
      if (id !== currentContextId) {
        // Main process switched context externally (e.g., SSH disconnect)
        // Trigger renderer-side context switch to sync state
        void useStore.getState().switchContext(id);
      }
    });
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }
  }

  // Return cleanup function
  return () => {
    for (const timer of pendingSessionRefreshTimers.values()) {
      clearTimeout(timer);
    }
    pendingSessionRefreshTimers.clear();
    for (const timer of pendingProjectRefreshTimers.values()) {
      clearTimeout(timer);
    }
    pendingProjectRefreshTimers.clear();
    cleanupFns.forEach((fn) => fn());
  };
}
