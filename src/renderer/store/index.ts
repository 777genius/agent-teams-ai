/**
 * Store index - combines all slices and exports the unified store.
 */

import { api } from '@renderer/api';
import { syncRendererTelemetry } from '@renderer/sentry';
import { cleanupStale as cleanupCommentReadState } from '@renderer/services/commentReadStorage';
import { normalizePath } from '@renderer/utils/pathNormalize';
import {
  buildTaskChangePresenceKey,
  buildTaskChangeRequestOptions,
  canDisplayTaskChangesForOptions,
} from '@renderer/utils/taskChangeRequest';
import { createLogger } from '@shared/utils/logger';
import { isVersionOlder, normalizeVersion } from '@shared/utils/version';
import { create } from 'zustand';

import { createChangeReviewSlice } from './slices/changeReviewSlice';
import { createCliInstallerSlice } from './slices/cliInstallerSlice';
import { createConfigSlice } from './slices/configSlice';
import { createConnectionSlice } from './slices/connectionSlice';
import { createContextSlice } from './slices/contextSlice';
import { createConversationSlice } from './slices/conversationSlice';
import { createEditorSlice } from './slices/editorSlice';
import { createExtensionsSlice } from './slices/extensionsSlice';
import { createNotificationSlice } from './slices/notificationSlice';
import { createPaneSlice } from './slices/paneSlice';
import { createProjectSlice } from './slices/projectSlice';
import { createRepositorySlice } from './slices/repositorySlice';
import { createScheduleSlice } from './slices/scheduleSlice';
import { createSessionDetailSlice } from './slices/sessionDetailSlice';
import { createSessionSlice } from './slices/sessionSlice';
import { createSubagentSlice } from './slices/subagentSlice';
import { createTabSlice } from './slices/tabSlice';
import { createTabUISlice } from './slices/tabUISlice';
import {
  createTeamSlice,
  getLastResolvedTeamDataRefreshAt,
  isTeamDataRefreshPending,
} from './slices/teamSlice';
import { createUISlice } from './slices/uiSlice';
import { createUpdateSlice } from './slices/updateSlice';

import type { DetectedError } from '../types/data';
import type { AppState } from './types';
import type {
  ActiveToolCall,
  CliInstallerProgress,
  LeadContextUsage,
  ScheduleChangeEvent,
  TeamChangeEvent,
  ToolActivityEventPayload,
  ToolApprovalEvent,
  ToolApprovalRequest,
  UpdaterStatus,
} from '@shared/types';

const ENABLE_AUTO_TEAM_CHANGE_PRESENCE_TRACKING = false;
const IN_PROGRESS_CHANGE_PRESENCE_POLL_MS = 10_000;
const FINISHED_TOOL_DISPLAY_MS = 1_500;
const MAX_TOOL_HISTORY_PER_MEMBER = 6;
const TEAM_CHANGE_EVENT_BURST_WINDOW_MS = 4_000;
const TEAM_CHANGE_EVENT_BURST_WARN_COUNT = 8;
const TEAM_CHANGE_EVENT_WARN_THROTTLE_MS = 2_000;
const TEAM_VISIBLE_IDLE_WATCHDOG_POLL_MS = 10_000;
const TEAM_VISIBLE_IDLE_WATCHDOG_STALE_MS = 30_000;
const CURRENT_APP_VERSION =
  typeof __APP_VERSION__ === 'string' ? normalizeVersion(__APP_VERSION__) : '0.0.0';
const logger = createLogger('Store:index');
const RELEVANT_TEAM_CHANGE_EVENT_TYPES = new Set<TeamChangeEvent['type']>([
  'task',
  'config',
  'inbox',
  'lead-message',
  'lead-context',
  'lead-activity',
  'process',
  'member-spawn',
]);
const teamChangeEventDiagnostics = new Map<
  string,
  {
    windowStartedAt: number;
    count: number;
    lastWarnAt: number;
    countsByType: Record<string, number>;
  }
>();

function noteTeamChangeEventBurst(teamName: string, eventType: string, visible: boolean): void {
  if (!visible) return;

  const now = Date.now();
  const diagnostic = teamChangeEventDiagnostics.get(teamName) ?? {
    windowStartedAt: now,
    count: 0,
    lastWarnAt: 0,
    countsByType: {},
  };

  if (now - diagnostic.windowStartedAt > TEAM_CHANGE_EVENT_BURST_WINDOW_MS) {
    diagnostic.windowStartedAt = now;
    diagnostic.count = 0;
    diagnostic.countsByType = {};
  }

  diagnostic.count += 1;
  diagnostic.countsByType[eventType] = (diagnostic.countsByType[eventType] ?? 0) + 1;

  if (
    diagnostic.count >= TEAM_CHANGE_EVENT_BURST_WARN_COUNT &&
    now - diagnostic.lastWarnAt >= TEAM_CHANGE_EVENT_WARN_THROTTLE_MS
  ) {
    diagnostic.lastWarnAt = now;
    const typeSummary = Object.entries(diagnostic.countsByType)
      .sort((a, b) => b[1] - a[1])
      .map(([type, count]) => `${type}:${count}`)
      .join(',');
    logger.warn(
      `[perf] team-change burst team=${teamName} total=${diagnostic.count} windowMs=${
        now - diagnostic.windowStartedAt
      } types=${typeSummary}`
    );
  }

  teamChangeEventDiagnostics.set(teamName, diagnostic);
}

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
  ...createEditorSlice(...args),
  ...createScheduleSlice(...args),
  ...createExtensionsSlice(...args),
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
  let cliStatusTimer: ReturnType<typeof setTimeout> | null = null;
  useStore.getState().subscribeProvisioningProgress();
  cleanupFns.push(() => {
    useStore.getState().unsubscribeProvisioningProgress();
  });
  // Initial data fetches. Config loads first (needed for theme), then the rest
  // run in parallel (no data dependencies between them). UV_THREADPOOL_SIZE=16
  // prevents thread pool saturation even with concurrent I/O on Windows.
  // Components also fire these from useEffect — loading guards in each action
  // prevent duplicate IPC calls (whichever caller starts first wins).
  void (async () => {
    // Config: fast (in-memory read) — needed for theme before first paint.
    await useStore.getState().fetchConfig();

    // Sync Sentry renderer telemetry gate from loaded config
    const loadedConfig = useStore.getState().appConfig;
    syncRendererTelemetry(loadedConfig?.general?.telemetryEnabled ?? true);

    if (api.cliInstaller) {
      // Resolve the configured CLI flavor after config has loaded to avoid
      // bootstrapping multimodel placeholder state in Claude-only mode.
      type NavigatorWithUserAgentData = Navigator & { userAgentData?: { platform?: string } };
      const nav: NavigatorWithUserAgentData | null =
        typeof navigator !== 'undefined' ? (navigator as NavigatorWithUserAgentData) : null;
      // Prefer UA-CH when available; fall back to deprecated-but-still-supported navigator.platform.
      // eslint-disable-next-line sonarjs/deprecation -- navigator.platform is deprecated but needed as fallback
      const platform: string =
        nav?.userAgentData?.platform ?? nav?.platform ?? nav?.userAgent ?? '';
      const isWindows = platform.toLowerCase().includes('win');
      const delayMs = isWindows ? 3000 : 0;
      cliStatusTimer = setTimeout(() => {
        const multimodelEnabled = useStore.getState().appConfig?.general?.multimodelEnabled ?? true;
        if (multimodelEnabled) {
          void useStore.getState().bootstrapCliStatus({ multimodelEnabled: true });
        } else {
          void useStore.getState().fetchCliStatus();
        }
        cliStatusTimer = null;
      }, delayMs);
    }

    // Remaining fetches have no data dependency on each other — run in parallel
    // to avoid blocking teams/notifications behind a slow repository scan.
    await Promise.all([
      useStore.getState().fetchRepositoryGroups(),
      useStore.getState().fetchAllTasks(),
      useStore.getState().fetchTeams(),
      useStore.getState().fetchNotifications(),
      useStore.getState().fetchSchedules(),
    ]);
  })();
  cleanupFns.push(() => {
    if (cliStatusTimer) clearTimeout(cliStatusTimer);
  });
  // This lightweight renderer-side poll keeps visible in-progress task badges fresh.
  // It is intentionally independent from the backend log-source tracking feature flag below.
  const inProgressChangePresencePollTimer = setInterval(() => {
    void pollVisibleTeamInProgressChangePresence();
  }, IN_PROGRESS_CHANGE_PRESENCE_POLL_MS);
  cleanupFns.push(() => {
    clearInterval(inProgressChangePresencePollTimer);
  });
  const pendingSessionRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const pendingProjectRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const teamLastRelevantActivityAt = new Map<string, number>();
  const teamLastIdleWatchdogRefreshAt = new Map<string, number>();
  let teamRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let teamPresenceRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let memberSpawnRefreshTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let toolActivityTimers = new Map<string, ReturnType<typeof setTimeout>>();
  let inProgressChangePresencePollInFlight = false;
  const inProgressChangePresenceCursorByTeam = new Map<string, number>();

  let teamListRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let globalTasksRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  const SESSION_REFRESH_DEBOUNCE_MS = 150;
  const PROJECT_REFRESH_DEBOUNCE_MS = 300;
  const TEAM_REFRESH_THROTTLE_MS = 800;
  const TEAM_PRESENCE_REFRESH_THROTTLE_MS = 400;
  const TEAM_MEMBER_SPAWN_REFRESH_THROTTLE_MS = 500;
  const TEAM_LIST_REFRESH_THROTTLE_MS = 2000;
  const GLOBAL_TASKS_REFRESH_THROTTLE_MS = 500;
  const scheduleMemberSpawnStatusesRefresh = (teamName: string | null | undefined): void => {
    if (!teamName || !isTeamVisibleInAnyPane(teamName)) {
      return;
    }
    if (memberSpawnRefreshTimers.has(teamName)) {
      return;
    }
    const timer = setTimeout(() => {
      memberSpawnRefreshTimers.delete(teamName);
      void useStore.getState().fetchMemberSpawnStatuses(teamName);
    }, TEAM_MEMBER_SPAWN_REFRESH_THROTTLE_MS);
    memberSpawnRefreshTimers.set(teamName, timer);
  };
  const buildToolActivityTimerKey = (
    teamName: string,
    memberName: string,
    toolUseId: string,
    kind: 'fade'
  ): string => `${teamName}:${memberName}:${toolUseId}:${kind}`;
  const clearToolActivityTimer = (
    teamName: string,
    memberName: string,
    toolUseId: string,
    kind: 'fade'
  ): void => {
    const key = buildToolActivityTimerKey(teamName, memberName, toolUseId, kind);
    const existing = toolActivityTimers.get(key);
    if (existing) {
      clearTimeout(existing);
      toolActivityTimers.delete(key);
    }
  };
  const scheduleToolActivityTimer = (
    teamName: string,
    memberName: string,
    toolUseId: string,
    kind: 'fade',
    delayMs: number,
    cb: () => void
  ): void => {
    clearToolActivityTimer(teamName, memberName, toolUseId, kind);
    const key = buildToolActivityTimerKey(teamName, memberName, toolUseId, kind);
    const timer = setTimeout(() => {
      toolActivityTimers.delete(key);
      cb();
    }, delayMs);
    toolActivityTimers.set(key, timer);
  };
  const clearToolActivityTimersForTeam = (teamName: string): void => {
    for (const [key, timer] of toolActivityTimers.entries()) {
      if (!key.startsWith(`${teamName}:`)) continue;
      clearTimeout(timer);
      toolActivityTimers.delete(key);
    }
  };
  const clearRuntimeToolStateForTeam = (
    prev: AppState,
    teamName: string
  ): Pick<AppState, 'activeToolsByTeam' | 'finishedVisibleByTeam' | 'toolHistoryByTeam'> => {
    const nextActive = { ...prev.activeToolsByTeam };
    const nextFinished = { ...prev.finishedVisibleByTeam };
    const nextHistory = { ...prev.toolHistoryByTeam };
    delete nextActive[teamName];
    delete nextFinished[teamName];
    delete nextHistory[teamName];
    return {
      activeToolsByTeam: nextActive,
      finishedVisibleByTeam: nextFinished,
      toolHistoryByTeam: nextHistory,
    };
  };
  const pushToolHistoryEntry = (
    history: Record<string, Record<string, ActiveToolCall[]>>,
    teamName: string,
    entry: ActiveToolCall
  ): Record<string, Record<string, ActiveToolCall[]>> => {
    const teamHistory = { ...(history[teamName] ?? {}) };
    const existing = teamHistory[entry.memberName] ?? [];
    teamHistory[entry.memberName] = [
      entry,
      ...existing.filter((t) => t.toolUseId !== entry.toolUseId),
    ].slice(0, MAX_TOOL_HISTORY_PER_MEMBER);
    return { ...history, [teamName]: teamHistory };
  };
  const upsertMemberToolEntry = (
    teamState: Record<string, Record<string, ActiveToolCall>> | undefined,
    entry: ActiveToolCall
  ): Record<string, Record<string, ActiveToolCall>> => ({
    ...(teamState ?? {}),
    [entry.memberName]: {
      ...((teamState ?? {})[entry.memberName] ?? {}),
      [entry.toolUseId]: entry,
    },
  });
  const removeMemberToolEntry = (
    teamState: Record<string, Record<string, ActiveToolCall>> | undefined,
    memberName: string,
    toolUseId: string
  ): Record<string, Record<string, ActiveToolCall>> => {
    if (!teamState?.[memberName]?.[toolUseId]) return teamState ?? {};
    const nextTeamState = { ...(teamState ?? {}) };
    const nextMemberState = { ...(nextTeamState[memberName] ?? {}) };
    delete nextMemberState[toolUseId];
    if (Object.keys(nextMemberState).length === 0) {
      delete nextTeamState[memberName];
    } else {
      nextTeamState[memberName] = nextMemberState;
    }
    return nextTeamState;
  };
  const removeMemberToolGroup = (
    teamState: Record<string, Record<string, ActiveToolCall>> | undefined,
    memberName: string
  ): Record<string, Record<string, ActiveToolCall>> => {
    if (!teamState?.[memberName]) return teamState ?? {};
    const nextTeamState = { ...(teamState ?? {}) };
    delete nextTeamState[memberName];
    return nextTeamState;
  };
  const removeMemberToolEntries = (
    teamState: Record<string, Record<string, ActiveToolCall>> | undefined,
    memberName: string,
    toolUseIds: readonly string[]
  ): Record<string, Record<string, ActiveToolCall>> => {
    if (!teamState?.[memberName] || toolUseIds.length === 0) return teamState ?? {};
    let nextTeamState = teamState ?? {};
    let changed = false;
    for (const toolUseId of toolUseIds) {
      if (!nextTeamState[memberName]?.[toolUseId]) continue;
      nextTeamState = removeMemberToolEntry(nextTeamState, memberName, toolUseId);
      changed = true;
    }
    return changed ? nextTeamState : (teamState ?? {});
  };
  const getBaseProjectId = (projectId: string | null | undefined): string | null => {
    if (!projectId) return null;
    const separatorIndex = projectId.indexOf('::');
    return separatorIndex >= 0 ? projectId.slice(0, separatorIndex) : projectId;
  };

  const pollVisibleTeamInProgressChangePresence = async (): Promise<void> => {
    if (inProgressChangePresencePollInFlight) {
      return;
    }

    const state = useStore.getState();
    const selectedTeamName = state.selectedTeamName;
    const selectedTeamData = state.selectedTeamData;
    if (
      !selectedTeamName ||
      selectedTeamData?.teamName !== selectedTeamName ||
      !isTeamVisibleInAnyPane(selectedTeamName)
    ) {
      return;
    }

    const candidateTasks = selectedTeamData.tasks.filter((task) => {
      if (task.status !== 'in_progress') {
        return false;
      }
      return canDisplayTaskChangesForOptions(buildTaskChangeRequestOptions(task));
    });
    if (candidateTasks.length === 0) {
      inProgressChangePresenceCursorByTeam.delete(selectedTeamName);
      return;
    }

    inProgressChangePresencePollInFlight = true;
    try {
      const cursor = inProgressChangePresenceCursorByTeam.get(selectedTeamName) ?? 0;
      const unknownTasks = candidateTasks.filter((task) => task.changePresence === 'unknown');
      const sourceTasks = unknownTasks.length > 0 ? unknownTasks : candidateTasks;
      const nextTask = sourceTasks[cursor % sourceTasks.length];

      inProgressChangePresenceCursorByTeam.set(selectedTeamName, (cursor + 1) % sourceTasks.length);

      const current = useStore.getState();
      if (
        current.selectedTeamName !== selectedTeamName ||
        current.selectedTeamData?.teamName !== selectedTeamName ||
        !isTeamVisibleInAnyPane(selectedTeamName)
      ) {
        return;
      }

      const currentTask = current.selectedTeamData.tasks.find((task) => task.id === nextTask.id);
      if (currentTask?.status !== 'in_progress') {
        return;
      }

      const requestOptions = buildTaskChangeRequestOptions(currentTask);
      const cacheKey = buildTaskChangePresenceKey(selectedTeamName, currentTask.id, requestOptions);
      current.invalidateTaskChangePresence([cacheKey]);
      await current.checkTaskHasChanges(selectedTeamName, currentTask.id, requestOptions);
    } catch {
      // Best-effort polling for in-progress tasks only.
    } finally {
      inProgressChangePresencePollInFlight = false;
    }
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

  // fetchNotifications() is called in the parallel init chain above.

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

  const getTrackedChangePresenceTeams = (): Set<string> => {
    const { selectedTeamName, selectedTeamData } = useStore.getState();
    if (
      !selectedTeamName ||
      selectedTeamData?.teamName !== selectedTeamName ||
      !isTeamVisibleInAnyPane(selectedTeamName)
    ) {
      return new Set<string>();
    }
    return new Set([selectedTeamName]);
  };

  const getTrackedToolActivityTeams = (): Set<string> => {
    const { paneLayout } = useStore.getState();
    const tracked = new Set<string>();
    for (const pane of paneLayout.panes) {
      if (!pane.activeTabId) continue;
      const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId);
      if (activeTab?.type === 'team' && activeTab.teamName) {
        tracked.add(activeTab.teamName);
      }
    }
    return tracked;
  };

  const noteRelevantTeamActivity = (teamName: string, timestamp = Date.now()): void => {
    teamLastRelevantActivityAt.set(teamName, timestamp);
  };

  const getFocusedVisibleTeamName = (): string | null => {
    const state = useStore.getState();
    const focusedPane = state.paneLayout.panes.find(
      (pane) => pane.id === state.paneLayout.focusedPaneId
    );
    if (!focusedPane?.activeTabId) {
      return null;
    }

    const activeTab = focusedPane.tabs.find((tab) => tab.id === focusedPane.activeTabId);
    if (activeTab?.type !== 'team' || !activeTab.teamName) {
      return null;
    }

    if (state.selectedTeamName !== activeTab.teamName) {
      return null;
    }

    if (state.selectedTeamData?.teamName !== activeTab.teamName) {
      return null;
    }

    return activeTab.teamName;
  };

  const pollFocusedVisibleTeamIdleWatchdog = async (): Promise<void> => {
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      return;
    }

    const current = useStore.getState();
    const teamName = getFocusedVisibleTeamName();
    if (!teamName || !isTeamVisibleInAnyPane(teamName)) {
      return;
    }

    if (current.selectedTeamLoading) {
      return;
    }

    if (isTeamDataRefreshPending(teamName)) {
      return;
    }

    const lastRelevantActivityAt = teamLastRelevantActivityAt.get(teamName) ?? 0;
    const lastResolvedRefreshAt = getLastResolvedTeamDataRefreshAt(teamName) ?? 0;
    const idleBaselineAt = Math.max(lastRelevantActivityAt, lastResolvedRefreshAt);
    if (idleBaselineAt === 0) {
      return;
    }

    const now = Date.now();
    if (now - idleBaselineAt < TEAM_VISIBLE_IDLE_WATCHDOG_STALE_MS) {
      return;
    }

    const lastWatchdogRefreshAt = teamLastIdleWatchdogRefreshAt.get(teamName) ?? 0;
    if (lastWatchdogRefreshAt >= idleBaselineAt) {
      return;
    }

    logger.warn(`[perf] idle-watchdog refresh team=${teamName} idleMs=${now - idleBaselineAt}`);

    try {
      await current.refreshTeamData(teamName, { withDedup: true });
    } finally {
      teamLastIdleWatchdogRefreshAt.set(
        teamName,
        Math.max(getLastResolvedTeamDataRefreshAt(teamName) ?? 0, idleBaselineAt, Date.now())
      );
    }
  };

  if (ENABLE_AUTO_TEAM_CHANGE_PRESENCE_TRACKING && api.teams?.setChangePresenceTracking) {
    let trackedTeamNames = new Set<string>();
    const syncVisibleTeamTracking = (): void => {
      const nextTrackedTeamNames = getTrackedChangePresenceTeams();

      for (const teamName of nextTrackedTeamNames) {
        if (!trackedTeamNames.has(teamName)) {
          void api.teams.setChangePresenceTracking(teamName, true).catch(() => undefined);
        }
      }

      for (const teamName of trackedTeamNames) {
        if (!nextTrackedTeamNames.has(teamName)) {
          void api.teams.setChangePresenceTracking(teamName, false).catch(() => undefined);
        }
      }

      trackedTeamNames = nextTrackedTeamNames;
    };

    syncVisibleTeamTracking();

    const unsubscribeVisibleTeamTracking = useStore.subscribe((state, prevState) => {
      if (
        state.paneLayout === prevState.paneLayout &&
        state.selectedTeamName === prevState.selectedTeamName &&
        state.selectedTeamData === prevState.selectedTeamData
      ) {
        return;
      }
      syncVisibleTeamTracking();
    });

    cleanupFns.push(() => {
      unsubscribeVisibleTeamTracking();
      for (const teamName of trackedTeamNames) {
        void api.teams.setChangePresenceTracking(teamName, false).catch(() => undefined);
      }
      trackedTeamNames.clear();
    });
  }

  if (api.teams?.setToolActivityTracking) {
    let trackedTeamNames = new Set<string>();
    const syncVisibleTeamTracking = (): void => {
      const nextTrackedTeamNames = getTrackedToolActivityTeams();

      for (const teamName of nextTrackedTeamNames) {
        if (!trackedTeamNames.has(teamName)) {
          void api.teams.setToolActivityTracking(teamName, true).catch(() => undefined);
        }
      }

      for (const teamName of trackedTeamNames) {
        if (!nextTrackedTeamNames.has(teamName)) {
          void api.teams.setToolActivityTracking(teamName, false).catch(() => undefined);
        }
      }

      trackedTeamNames = nextTrackedTeamNames;
    };

    syncVisibleTeamTracking();

    const unsubscribeVisibleTeamTracking = useStore.subscribe((state, prevState) => {
      if (state.paneLayout === prevState.paneLayout) {
        return;
      }
      syncVisibleTeamTracking();
    });

    cleanupFns.push(() => {
      unsubscribeVisibleTeamTracking();
      for (const teamName of trackedTeamNames) {
        void api.teams.setToolActivityTracking(teamName, false).catch(() => undefined);
      }
      trackedTeamNames.clear();
    });
  }

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

  const teamIdleWatchdogTimer = setInterval(() => {
    void pollFocusedVisibleTeamIdleWatchdog();
  }, TEAM_VISIBLE_IDLE_WATCHDOG_POLL_MS);
  cleanupFns.push(() => {
    clearInterval(teamIdleWatchdogTimer);
  });

  if (api.teams?.onTeamChange) {
    const cleanup = api.teams.onTeamChange((_event: unknown, event: TeamChangeEvent) => {
      const visibleTeam = Boolean(event.teamName) && isTeamVisibleInAnyPane(event.teamName);
      noteTeamChangeEventBurst(event.teamName, event.type, visibleTeam);

      const isIgnoredRuntimeRun = (() => {
        if (!event.runId) return false;
        const state = useStore.getState();
        return (
          state.ignoredProvisioningRunIds[event.runId] === event.teamName ||
          state.ignoredRuntimeRunIds[event.runId] === event.teamName
        );
      })();
      if (isIgnoredRuntimeRun) {
        return;
      }

      const isStaleRuntimeEvent = (() => {
        if (!event.runId) return false;
        const currentRunId = useStore.getState().currentRuntimeRunIdByTeam[event.teamName];
        return currentRunId != null && currentRunId !== event.runId;
      })();

      const seedCurrentRunIdIfMissing = (): void => {
        if (!event.runId) return;
        const currentRunId = useStore.getState().currentRuntimeRunIdByTeam[event.teamName];
        if (currentRunId == null) {
          useStore.setState((prev) => ({
            currentRuntimeRunIdByTeam: {
              ...prev.currentRuntimeRunIdByTeam,
              [event.teamName]: event.runId ?? null,
            },
            ignoredRuntimeRunIds: Object.fromEntries(
              Object.entries(prev.ignoredRuntimeRunIds).filter(
                ([, teamName]) => teamName !== event.teamName
              )
            ),
          }));
        }
      };

      if (RELEVANT_TEAM_CHANGE_EVENT_TYPES.has(event.type) && !isStaleRuntimeEvent) {
        noteRelevantTeamActivity(event.teamName);
      }

      // Immediate in-memory update for lead activity — no filesystem refresh needed
      if (event.type === 'lead-activity' && event.detail) {
        if (isStaleRuntimeEvent) {
          return;
        }
        seedCurrentRunIdIfMissing();
        const nextActivity = event.detail as 'active' | 'idle' | 'offline';
        useStore.setState((prev) => {
          const nextState: Partial<typeof prev> = {
            leadActivityByTeam: {
              ...prev.leadActivityByTeam,
              [event.teamName]: nextActivity,
            },
          };

          // Keep TeamDetailView in sync: it historically relied on selectedTeamData.isAlive,
          // which isn't refreshed for lead-activity events.
          if (prev.selectedTeamName === event.teamName && prev.selectedTeamData) {
            nextState.selectedTeamData = {
              ...prev.selectedTeamData,
              isAlive: nextActivity !== 'offline',
            };
          }

          // Clear context data when lead goes offline
          if (nextActivity === 'offline') {
            nextState.leadContextByTeam = { ...prev.leadContextByTeam };
            delete nextState.leadContextByTeam[event.teamName];
            Object.assign(nextState, clearRuntimeToolStateForTeam(prev, event.teamName));
            nextState.currentRuntimeRunIdByTeam = { ...prev.currentRuntimeRunIdByTeam };
            delete nextState.currentRuntimeRunIdByTeam[event.teamName];
            nextState.ignoredRuntimeRunIds = event.runId
              ? {
                  ...prev.ignoredRuntimeRunIds,
                  [event.runId]: event.teamName,
                }
              : prev.ignoredRuntimeRunIds;
            clearToolActivityTimersForTeam(event.teamName);
          }

          return nextState as typeof prev;
        });
        return;
      }

      // Immediate in-memory update for lead context usage — no filesystem refresh needed
      if (event.type === 'lead-context' && event.detail) {
        if (isStaleRuntimeEvent) {
          return;
        }
        seedCurrentRunIdIfMissing();
        try {
          const ctx = JSON.parse(event.detail) as LeadContextUsage;
          useStore.setState((prev) => ({
            ...prev,
            leadContextByTeam: { ...prev.leadContextByTeam, [event.teamName]: ctx },
          }));
        } catch {
          /* ignore malformed detail */
        }
        return;
      }

      if (event.type === 'tool-activity' && event.detail) {
        if (isStaleRuntimeEvent) {
          return;
        }
        seedCurrentRunIdIfMissing();
        try {
          const payload = JSON.parse(event.detail) as ToolActivityEventPayload;
          if (payload.action === 'start' && payload.activity) {
            const activity: ActiveToolCall = {
              memberName: payload.activity.memberName,
              toolUseId: payload.activity.toolUseId,
              toolName: payload.activity.toolName,
              preview: payload.activity.preview,
              startedAt: payload.activity.startedAt,
              source: payload.activity.source,
              state: 'running',
            };

            useStore.setState((prev) => ({
              activeToolsByTeam: {
                ...prev.activeToolsByTeam,
                [event.teamName]: upsertMemberToolEntry(
                  prev.activeToolsByTeam[event.teamName],
                  activity
                ),
              },
            }));
          } else if (payload.action === 'finish' && payload.memberName && payload.toolUseId) {
            const memberName = payload.memberName;
            const toolUseId = payload.toolUseId;
            useStore.setState((prev) => {
              const current = prev.activeToolsByTeam[event.teamName]?.[memberName]?.[toolUseId];
              if (!current) {
                return {};
              }

              const completed: ActiveToolCall = {
                ...current,
                state: payload.isError ? 'error' : 'complete',
                finishedAt: payload.finishedAt ?? new Date().toISOString(),
                resultPreview: payload.resultPreview,
              };

              scheduleToolActivityTimer(
                event.teamName,
                memberName,
                toolUseId,
                'fade',
                FINISHED_TOOL_DISPLAY_MS,
                () => {
                  useStore.setState((state) => {
                    const nextCurrent =
                      state.finishedVisibleByTeam[event.teamName]?.[memberName]?.[toolUseId];
                    if (!nextCurrent) {
                      return {};
                    }
                    return {
                      finishedVisibleByTeam: {
                        ...state.finishedVisibleByTeam,
                        [event.teamName]: removeMemberToolEntry(
                          state.finishedVisibleByTeam[event.teamName],
                          memberName,
                          toolUseId
                        ),
                      },
                    };
                  });
                }
              );

              return {
                activeToolsByTeam: {
                  ...prev.activeToolsByTeam,
                  [event.teamName]: removeMemberToolEntry(
                    prev.activeToolsByTeam[event.teamName],
                    memberName,
                    toolUseId
                  ),
                },
                finishedVisibleByTeam: {
                  ...prev.finishedVisibleByTeam,
                  [event.teamName]: upsertMemberToolEntry(
                    prev.finishedVisibleByTeam[event.teamName],
                    completed
                  ),
                },
                toolHistoryByTeam: pushToolHistoryEntry(
                  prev.toolHistoryByTeam,
                  event.teamName,
                  completed
                ),
              };
            });
          } else if (payload.action === 'reset') {
            if (payload.memberName) {
              const memberName = payload.memberName;
              const toolUseIds =
                Array.isArray(payload.toolUseIds) && payload.toolUseIds.length > 0
                  ? payload.toolUseIds
                  : null;
              useStore.setState((prev) => {
                if (!prev.activeToolsByTeam[event.teamName]?.[memberName]) {
                  return {};
                }
                return {
                  activeToolsByTeam: {
                    ...prev.activeToolsByTeam,
                    [event.teamName]: toolUseIds
                      ? removeMemberToolEntries(
                          prev.activeToolsByTeam[event.teamName],
                          memberName,
                          toolUseIds
                        )
                      : removeMemberToolGroup(prev.activeToolsByTeam[event.teamName], memberName),
                  },
                };
              });
            } else {
              useStore.setState((prev) => ({
                activeToolsByTeam: { ...prev.activeToolsByTeam, [event.teamName]: {} },
              }));
            }
          }
        } catch {
          /* ignore malformed detail */
        }
        return;
      }

      // Member spawn status change: fetch updated spawn statuses for the team.
      if (event.type === 'member-spawn') {
        if (isStaleRuntimeEvent) {
          return;
        }
        seedCurrentRunIdIfMissing();
        scheduleMemberSpawnStatusesRefresh(event.teamName);
        return;
      }

      if (event.type === 'inbox' || event.type === 'config' || event.type === 'process') {
        scheduleMemberSpawnStatusesRefresh(event.teamName);
      }

      // Live lead-message events: only refresh the visible team detail, not team/task lists.
      // This keeps the refresh lightweight and prevents one noisy team from starving another.
      if (event.type === 'lead-message') {
        if (isStaleRuntimeEvent) {
          return;
        }
        seedCurrentRunIdIfMissing();
        if (!event?.teamName || !isTeamVisibleInAnyPane(event.teamName)) {
          return;
        }
        if (teamRefreshTimers.has(event.teamName)) {
          return;
        }
        const timer = setTimeout(() => {
          teamRefreshTimers.delete(event.teamName);
          const current = useStore.getState();
          void current.refreshTeamData(event.teamName, { withDedup: true });
        }, TEAM_REFRESH_THROTTLE_MS);
        teamRefreshTimers.set(event.teamName, timer);
        return;
      }

      if (event.type === 'log-source-change') {
        if (!event?.teamName || !isTeamVisibleInAnyPane(event.teamName)) {
          return;
        }
        if (teamPresenceRefreshTimers.has(event.teamName)) {
          return;
        }
        const timer = setTimeout(() => {
          teamPresenceRefreshTimers.delete(event.teamName);
          const current = useStore.getState();
          void current.refreshSelectedTeamChangePresence(event.teamName);
        }, TEAM_PRESENCE_REFRESH_THROTTLE_MS);
        teamPresenceRefreshTimers.set(event.teamName, timer);
        return;
      }

      // Throttled refresh of summary list (keeps TeamListView current without flooding).
      if (!teamListRefreshTimer) {
        teamListRefreshTimer = setTimeout(() => {
          teamListRefreshTimer = null;
          void useStore.getState().fetchTeams();
        }, TEAM_LIST_REFRESH_THROTTLE_MS);
      }

      const shouldRefreshGlobalTasks = event.type === 'task' || event.type === 'config';

      // Throttled refresh of global tasks list for sidebar.
      if (shouldRefreshGlobalTasks && !globalTasksRefreshTimer) {
        globalTasksRefreshTimer = setTimeout(() => {
          globalTasksRefreshTimer = null;
          void useStore.getState().fetchAllTasks();
        }, GLOBAL_TASKS_REFRESH_THROTTLE_MS);
      }

      if (!event?.teamName || !isTeamVisibleInAnyPane(event.teamName)) {
        return;
      }

      // Per-team throttle (not debounce): keep at most one pending detail refresh per team.
      // Debounce would delay indefinitely while inbox messages keep arriving.
      if (teamRefreshTimers.has(event.teamName)) {
        return;
      }

      const timer = setTimeout(() => {
        teamRefreshTimers.delete(event.teamName);
        const current = useStore.getState();
        void current.refreshTeamData(event.teamName, { withDedup: true });
      }, TEAM_REFRESH_THROTTLE_MS);
      teamRefreshTimers.set(event.teamName, timer);
    });

    if (typeof cleanup === 'function') {
      cleanupFns.push(() => {
        cleanup();
        for (const t of teamRefreshTimers.values()) clearTimeout(t);
        teamRefreshTimers = new Map();
        for (const t of teamPresenceRefreshTimers.values()) clearTimeout(t);
        teamPresenceRefreshTimers = new Map();
        for (const t of memberSpawnRefreshTimers.values()) clearTimeout(t);
        memberSpawnRefreshTimers = new Map();
        for (const t of toolActivityTimers.values()) clearTimeout(t);
        toolActivityTimers = new Map();
        teamLastRelevantActivityAt.clear();
        teamLastIdleWatchdogRefreshAt.clear();
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

  if (api.teams?.onProjectBranchChange) {
    const cleanup = api.teams.onProjectBranchChange((_event: unknown, event) => {
      if (!event?.projectPath) return;
      const normalizedPath = normalizePath(event.projectPath);
      if (!normalizedPath) return;
      useStore.setState((prev) => {
        const current = prev.branchByPath[normalizedPath];
        if (current === event.branch) {
          return {};
        }
        return {
          branchByPath: {
            ...prev.branchByPath,
            [normalizedPath]: event.branch,
          },
        };
      });
    });
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }
  }

  // Tool approval events from CLI control_request protocol
  if (api.teams?.onToolApprovalEvent) {
    const cleanup = api.teams.onToolApprovalEvent((_event: unknown, data: unknown) => {
      const event = data as ToolApprovalEvent;
      if ('autoResolved' in event && event.autoResolved) {
        // Timeout or auto-allow resolved in main — remove from UI and record result
        const allowed = event.reason !== 'timeout_deny';
        useStore.setState((s) => {
          const next = new Map(s.resolvedApprovals);
          next.set(event.requestId, allowed);
          return {
            pendingApprovals: s.pendingApprovals.filter(
              (a) => !(a.runId === event.runId && a.requestId === event.requestId)
            ),
            resolvedApprovals: next,
          };
        });
      } else if ('dismissed' in event && event.dismissed) {
        const dismiss = event;
        useStore.setState((s) => ({
          pendingApprovals: s.pendingApprovals.filter(
            (a) => !(a.teamName === dismiss.teamName && a.runId === dismiss.runId)
          ),
        }));
      } else {
        const request = event as ToolApprovalRequest;
        useStore.setState((s) => ({
          pendingApprovals: [...s.pendingApprovals, request],
        }));
      }
    });
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }

    // Sync saved tool approval settings to main process on startup
    const savedSettings = useStore.getState().toolApprovalSettings;
    const activeTeam = useStore.getState().selectedTeamName ?? '__global__';
    api.teams.updateToolApprovalSettings?.(activeTeam, savedSettings).catch(() => {
      // Silently ignore — settings will use defaults until next update
    });
  }

  // Listen for editor file change events (chokidar watcher → renderer)
  if (api.editor?.onEditorChange) {
    const cleanup = api.editor.onEditorChange((event) => {
      const state = useStore.getState();
      if (state.editorProjectPath) {
        state.handleExternalFileChange(event);
      }
    });
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }
  }

  // Listen for schedule change events from main process
  if (api.schedules?.onScheduleChange) {
    const cleanup = api.schedules.onScheduleChange((_event: unknown, data: unknown) => {
      const event = data as ScheduleChangeEvent;
      if (event?.scheduleId) {
        void useStore.getState().applyScheduleChange(event.scheduleId);
      }
    });
    if (typeof cleanup === 'function') {
      cleanupFns.push(cleanup);
    }
  }

  // fetchCliStatus() is deferred 5s after app start (heavy on Windows).

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
        case 'status':
          if (progress.status) {
            useStore.setState({ cliStatus: progress.status });
          }
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
        case 'checking': {
          // Don't downgrade status if we already know about an available/downloaded update
          // or if a download is in progress (prevents UI flash during periodic re-checks)
          const current = useStore.getState().updateStatus;
          if (current !== 'available' && current !== 'downloaded' && current !== 'downloading') {
            useStore.setState({ updateStatus: 'checking' });
          }
          break;
        }
        case 'available': {
          // Don't downgrade from downloading/downloaded — the update is already
          // in progress or ready to install (prevents periodic re-check from
          // resetting the state after download completes)
          const currentStatus = useStore.getState().updateStatus;
          if (currentStatus === 'downloading' || currentStatus === 'downloaded') {
            break;
          }
          const nextVersion = s.version ? normalizeVersion(s.version) : null;
          if (!nextVersion || !isVersionOlder(CURRENT_APP_VERSION, nextVersion)) {
            break;
          }
          const dismissed = useStore.getState().dismissedUpdateVersion;
          useStore.setState({
            updateStatus: 'available',
            availableVersion: nextVersion,
            releaseNotes: s.releaseNotes ?? null,
            showUpdateDialog: nextVersion !== dismissed,
          });
          break;
        }
        case 'not-available': {
          // Don't reset status if update is already downloading or downloaded
          const notAvailCurrent = useStore.getState().updateStatus;
          if (notAvailCurrent !== 'downloading' && notAvailCurrent !== 'downloaded') {
            useStore.setState({ updateStatus: 'not-available' });
          }
          break;
        }
        case 'downloading':
          useStore.setState({
            updateStatus: 'downloading',
            downloadProgress: s.progress?.percent ?? 0,
          });
          break;
        case 'downloaded':
          if (s.version && !isVersionOlder(CURRENT_APP_VERSION, normalizeVersion(s.version))) {
            break;
          }
          useStore.setState({
            updateStatus: 'downloaded',
            downloadProgress: 100,
            availableVersion: s.version
              ? normalizeVersion(s.version)
              : useStore.getState().availableVersion,
          });
          break;
        case 'error': {
          // Don't lose downloaded state due to a transient check error —
          // the update is already on disk and ready to install
          const errCurrent = useStore.getState().updateStatus;
          if (errCurrent === 'downloaded') {
            break;
          }
          useStore.setState({
            updateStatus: 'error',
            updateError: s.error ?? 'Unknown error',
          });
          break;
        }
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
