import {
  buildTeamGraphDefaultLayoutSeed,
  createInitialTeamGraphLayoutState,
  createTeamGraphLayoutActions,
  getDefaultTeamGraphSlotAssignmentsForMembers,
  isTeamGraphSlotPersistenceDisabled,
  type TeamGraphLayoutSlice,
} from '@features/agent-graph';
import {
  createTeamLifecycleMutationCleanup,
  createTeamLifecycleMutationSlice,
  type TeamLifecycleMutationSlice,
} from '@features/team-lifecycle/renderer';
import { isActiveProvisioningState } from '@features/team-provisioning';
import {
  createProductTeamLaunchAnalyticsCoordinator,
  createTeamProvisioningControlSlice,
  createTeamProvisioningLaunchSlice,
  createTeamProvisioningProgressSlice,
  saveTeamToolApprovalSettings,
  type TeamLaunchAnalyticsContext,
  type TeamProvisioningControlSlice,
  type TeamProvisioningLaunchSlice,
  type TeamProvisioningProgressSlice,
  type TeamRuntimeObservationSlice,
} from '@features/team-provisioning/renderer';
import {
  clearTeamTaskBoardAnalytics,
  resetTeamTaskBoardAnalyticsForTests,
  type TeamTaskArtifactsRendererSlice,
  type TeamTaskBoardRendererSlice,
} from '@features/team-task-board/renderer';
import {
  defaultTeamMessageFeedCoordinator,
  TeamDirectoryRefreshCoordinator,
  type TeamDirectoryRendererSlice,
  type TeamMessageFeedRendererSlice,
  type TeamMessagesCacheEntry,
  type TeamViewDataRendererSlice,
} from '@features/team-view-read-model/renderer';
import { classifyAnalyticsError } from '@renderer/analytics/productAnalytics';
import * as productAnalytics from '@renderer/analytics/productAnalytics';
import { getTeamLifecycleAnalyticsContext } from '@renderer/analytics/teamAnalyticsMetadata';
import { api } from '@renderer/api';
import { normalizePath } from '@renderer/utils/pathNormalize';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';
import { createLogger } from '@shared/utils/logger';

import { createTeamCollaborationDataSlice } from '../team/createTeamCollaborationDataSlice';
import { selectTeamDataForName } from '../team/teamDataSelectors';
import { invalidateTeamLocalStateEpoch } from '../team/teamLocalStateEpoch';
import {
  loadPersistedMessagesPanelMode,
  savePersistedMessagesPanelMode,
} from '../team/teamMessagesPanelModePersistence';
import { clearPendingReplyRefreshWaits } from '../team/teamPendingReplyWaits';
import {
  buildTeamScopedProgressTombstones,
  collectTeamScopedStateRemovals,
  collectTeamScopedVisibleLoadingResets,
} from '../team/teamScopedStateCleanup';
import {
  type ContextRequestScope,
  type TeamScopedTransientStateSnapshot,
  TeamStateLifecycleCoordinator,
} from '../team/TeamStateLifecycleCoordinator';
import { parseToolApprovalSettings } from '../team/teamToolApprovalSettings';
import { noteTeamRefreshFanout } from '../teamRefreshFanoutDiagnostics';

import type { AppState } from '../types';
import type { TeamMessageDeliveryRendererSlice } from '@features/team-message-delivery/renderer';
import type { TeamMessagesPanelMode } from '@renderer/types/teamMessagesPanelMode';
import type { TaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import type {
  ActiveToolCall,
  AddMemberRequest,
  LeadActivityState,
  LeadContextUsage,
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  NotificationTarget,
  RetryFailedOpenCodeSecondaryLanesResult,
  TeamAgentRuntimeSnapshot,
  TeamProvisioningProgress,
  TeamSummary,
  ToolApprovalRequest,
  ToolApprovalSettings,
} from '@shared/types';

interface CurrentDevProductAnalytics {
  recordAttachmentAttachEnd(input: Record<string, unknown>): void;
  recordCrossTeamMessageSend(input: Record<string, unknown>): void;
  recordTeamDelete(input: Record<string, unknown>): void;
}

const currentDevProductAnalytics =
  productAnalytics as unknown as Partial<CurrentDevProductAnalytics>;
const recordAttachmentAttachEnd =
  currentDevProductAnalytics.recordAttachmentAttachEnd ?? (() => undefined);
const recordCrossTeamMessageSend =
  currentDevProductAnalytics.recordCrossTeamMessageSend ?? (() => undefined);
const recordTeamDelete = currentDevProductAnalytics.recordTeamDelete ?? (() => undefined);
import type { StateCreator } from 'zustand';

export { getLastResolvedTeamDataRefreshAt } from '../team/teamDataRefreshTimestamps';
export {
  selectTeamDataForName,
  selectTeamIsAliveForName,
  selectTeamMemberSnapshotsForName,
  selectTeamTasksForName,
} from '../team/teamDataSelectors';
export { getDefaultTeamGraphSlotAssignmentsForMembers, isTeamGraphSlotPersistenceDisabled };
export type {
  RefreshTeamMessagesHeadResult,
  TeamMessagesCacheEntry,
} from '../team/teamMessagesCache';
export { selectMemberMessagesForTeamMember, selectTeamMessages } from '../team/teamMessagesCache';
export {
  loadPersistedMessagesPanelMode,
  savePersistedMessagesPanelMode,
} from '../team/teamMessagesPanelModePersistence';
export {
  getActiveTeamPendingReplyWaits,
  hasActiveTeamPendingReplyWait,
} from '../team/teamPendingReplyWaits';
export {
  selectResolvedMemberForTeamName,
  selectResolvedMembersForTeamName,
} from '../team/teamResolvedMembers';
export type { TeamLaunchParams } from '@features/team-provisioning/renderer';

const logger = createLogger('teamSlice');

const teamDirectoryRefreshCoordinator = new TeamDirectoryRefreshCoordinator<ContextRequestScope>();
const teamStateLifecycleCoordinator = new TeamStateLifecycleCoordinator(
  teamDirectoryRefreshCoordinator
);
const teamLaunchAnalyticsCoordinator = createProductTeamLaunchAnalyticsCoordinator();

export function isTeamDataRefreshPending(teamName: string): boolean {
  return teamStateLifecycleCoordinator.isTeamDataRefreshPending(teamName);
}

export function __resetTeamSliceModuleStateForTests(): void {
  teamStateLifecycleCoordinator.reset();
  teamLaunchAnalyticsCoordinator.reset();
  resetTeamTaskBoardAnalyticsForTests();
}

export function __getTeamScopedTransientStateForTests(
  teamName: string
): TeamScopedTransientStateSnapshot {
  return teamStateLifecycleCoordinator.snapshot(teamName);
}

function nowIso(): string {
  return new Date().toISOString();
}

export interface GlobalTaskDetailState {
  teamName: string;
  taskId: string;
  commentId?: string;
}

export interface PendingMemberProfileState {
  teamName?: string;
  memberName: string;
  focus?: 'profile' | 'messages' | 'logs';
}

type TeamSectionTarget = NonNullable<Extract<NotificationTarget, { kind: 'team' }>['section']>;

export interface PendingTeamSectionFocusState {
  teamName: string;
  section: TeamSectionTarget;
}

function isVisibleInActiveTeamSurface(
  state: Pick<AppState, 'paneLayout'>,
  teamName: string | null | undefined
): boolean {
  if (!teamName) {
    return false;
  }
  return state.paneLayout.panes.some((pane) => {
    if (!pane.activeTabId) {
      return false;
    }
    const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId);
    return (
      (activeTab?.type === 'team' || activeTab?.type === 'graph') && activeTab.teamName === teamName
    );
  });
}

export interface TeamSlice
  extends
    TeamGraphLayoutSlice,
    TeamLifecycleMutationSlice,
    TeamMessageDeliveryRendererSlice,
    TeamMessageFeedRendererSlice,
    TeamProvisioningControlSlice,
    TeamProvisioningLaunchSlice,
    TeamProvisioningProgressSlice,
    TeamRuntimeObservationSlice,
    TeamDirectoryRendererSlice,
    TeamTaskArtifactsRendererSlice,
    TeamTaskBoardRendererSlice,
    TeamViewDataRendererSlice {
  globalTaskDetail: GlobalTaskDetailState | null;
  openGlobalTaskDetail: (teamName: string, taskId: string, commentId?: string) => void;
  closeGlobalTaskDetail: () => void;
  /** Set by MemberHoverCard to signal TeamDetailView to open MemberDetailDialog */
  pendingMemberProfile: PendingMemberProfileState | null;
  openMemberProfile: (
    memberName: string,
    teamName?: string,
    focus?: PendingMemberProfileState['focus']
  ) => void;
  closeMemberProfile: () => void;
  pendingTeamSectionFocus: PendingTeamSectionFocusState | null;
  focusTeamSection: (teamName: string, section: TeamSectionTarget) => void;
  clearTeamSectionFocus: () => void;
  /** Set by GlobalTaskDetailDialog to signal TeamDetailView to open ChangeReviewDialog */
  pendingReviewRequest: {
    taskId: string;
    filePath?: string;
    requestOptions: TaskChangeRequestOptions;
  } | null;
  setPendingReviewRequest: (
    req: { taskId: string; filePath?: string; requestOptions: TaskChangeRequestOptions } | null
  ) => void;
  teamsProjectNavigationIntent: {
    projectId: string;
    projectPath: string;
  } | null;
  provisioningRuns: Record<string, TeamProvisioningProgress>;
  /** Synthetic TeamSummary snapshots for teams currently being provisioned (before config.json exists). */
  provisioningSnapshotByTeam: Record<string, TeamSummary>;
  currentProvisioningRunIdByTeam: Record<string, string | null>;
  currentRuntimeRunIdByTeam: Record<string, string | null>;
  /** Runs explicitly cleared after Unknown runId polling; late events/progress for them are ignored. */
  ignoredProvisioningRunIds: Record<string, string>;
  /** Runtime runs explicitly tombstoned after stop/offline so late events cannot resurrect UI state. */
  ignoredRuntimeRunIds: Record<string, string>;
  /**
   * Per-team lower bound for provisioning progress timestamps.
   * Used to ignore late progress events from a previous run after stop→launch.
   */
  provisioningStartedAtFloorByTeam: Record<string, string>;
  leadActivityByTeam: Record<string, LeadActivityState>;
  leadContextByTeam: Record<string, LeadContextUsage>;
  activeTaskLogActivityByTeam: Record<string, Record<string, true>>;
  activeToolsByTeam: Record<string, Record<string, Record<string, ActiveToolCall>>>;
  finishedVisibleByTeam: Record<string, Record<string, Record<string, ActiveToolCall>>>;
  toolHistoryByTeam: Record<string, Record<string, ActiveToolCall[]>>;
  /** Per-team per-member spawn statuses during team provisioning/launch. */
  memberSpawnStatusesByTeam: Record<string, Record<string, MemberSpawnStatusEntry>>;
  memberSpawnSnapshotsByTeam: Record<string, MemberSpawnStatusesSnapshot>;
  teamAgentRuntimeByTeam: Record<string, TeamAgentRuntimeSnapshot>;
  provisioningErrorByTeam: Record<string, string | null>;
  clearProvisioningError: (teamName?: string) => void;
  kanbanFilterQuery: string | null;
  openTeamsTab: (projectPath?: string) => void;
  openTeamTab: (teamName: string, projectPath?: string, taskId?: string) => void;
  clearKanbanFilter: () => void;
  addMember: (teamName: string, request: AddMemberRequest) => Promise<void>;
  restartMember: (teamName: string, memberName: string) => Promise<void>;
  skipMemberForLaunch: (teamName: string, memberName: string) => Promise<void>;
  removeMember: (teamName: string, memberName: string) => Promise<void>;
  restoreMember: (teamName: string, memberName: string) => Promise<void>;
  updateMemberRole: (
    teamName: string,
    memberName: string,
    role: string | undefined
  ) => Promise<void>;
  retryFailedOpenCodeSecondaryLanes: (
    teamName: string
  ) => Promise<RetryFailedOpenCodeSecondaryLanesResult>;
  pendingApprovals: ToolApprovalRequest[];
  /** Resolved permission approvals: request_id → allowed (true/false). Used for noise row icons. */
  resolvedApprovals: Map<string, boolean>;
  toolApprovalSettings: ToolApprovalSettings;
  updateToolApprovalSettings: (
    patch: Partial<ToolApprovalSettings>,
    forTeam?: string
  ) => Promise<void>;
  respondToToolApproval: (
    teamName: string,
    runId: string,
    requestId: string,
    allow: boolean,
    message?: string
  ) => Promise<void>;

  // Messages panel UI state
  messagesPanelMode: TeamMessagesPanelMode;
  messagesPanelWidth: number;
  sidebarLogsHeight: number;
  setMessagesPanelMode: (mode: TeamMessagesPanelMode) => void;
  setMessagesPanelWidth: (width: number) => void;
  setSidebarLogsHeight: (height: number) => void;
}

export function getCurrentProvisioningProgressForTeam(
  state: Pick<TeamSlice, 'currentProvisioningRunIdByTeam' | 'provisioningRuns'>,
  teamName: string
): TeamProvisioningProgress | null {
  const currentRunId = state.currentProvisioningRunIdByTeam[teamName];
  return currentRunId ? (state.provisioningRuns[currentRunId] ?? null) : null;
}

export function isTeamProvisioningActive(
  state: Pick<TeamSlice, 'currentProvisioningRunIdByTeam' | 'provisioningRuns'>,
  teamName: string
): boolean {
  const current = getCurrentProvisioningProgressForTeam(state, teamName);
  return current != null && isActiveProvisioningState(current.state);
}

const TOOL_APPROVAL_PREFIX = 'team:toolApprovalSettings:';

function loadToolApprovalSettingsForTeam(teamName: string): ToolApprovalSettings {
  return parseToolApprovalSettings(localStorage.getItem(TOOL_APPROVAL_PREFIX + teamName));
}

/** Load global settings (legacy fallback for first load / no team selected). */
function loadToolApprovalSettings(): ToolApprovalSettings {
  return parseToolApprovalSettings(localStorage.getItem('team:toolApprovalSettings'));
}

export const createTeamSlice: StateCreator<AppState, [], [], TeamSlice> = (set, get) => ({
  ...createTeamCollaborationDataSlice({
    analytics: {
      recordAttachmentEnd: recordAttachmentAttachEnd,
      recordCrossTeamMessageSend,
    },
    clock: { nowIso },
    directoryCoordinator: teamDirectoryRefreshCoordinator,
    lifecycle: {
      isProvisioningActive: (teamName) => isTeamProvisioningActive(get(), teamName),
    },
    log: {
      debug: (message) => logger.debug(message),
      error: (message, error) => logger.error(message, error),
      warn: (message) => logger.warn(message),
    },
    requestScope: {
      captureContext: () => teamStateLifecycleCoordinator.captureContextRequestScope(get),
      captureTeam: (teamName) =>
        teamStateLifecycleCoordinator.captureTeamRequestScope(get, teamName),
      isContextCurrent: (scope) =>
        teamStateLifecycleCoordinator.isContextRequestScopeCurrent(get, scope),
      isTeamCurrent: (teamName, scope) =>
        teamStateLifecycleCoordinator.isTeamRequestScopeCurrent(get, teamName, scope),
    },
    settings: {
      loadToolApprovalSettings: loadToolApprovalSettingsForTeam,
    },
    state: {
      getState: get,
      setState: set,
    },
  }),
  teamsProjectNavigationIntent: null,
  ...createInitialTeamGraphLayoutState(),
  ...createTeamLifecycleMutationSlice<
    AppState,
    ReturnType<typeof getTeamLifecycleAnalyticsContext>
  >({
    analytics: {
      captureSoftDelete: (teamName) =>
        getTeamLifecycleAnalyticsContext(selectTeamDataForName(get(), teamName)),
      recordSoftDeleteFailure: (context, error) =>
        recordTeamDelete({
          source: 'store',
          success: false,
          ...context,
          errorClass: classifyAnalyticsError(error),
        }),
      recordSoftDeleteSuccess: (context) =>
        recordTeamDelete({
          source: 'store',
          success: true,
          ...context,
          errorClass: 'none',
        }),
    },
    cleanup: createTeamLifecycleMutationCleanup<AppState>({
      buildProgressTombstones: (state, teamName, floor) =>
        buildTeamScopedProgressTombstones(state, teamName, floor),
      collectStateRemovals: (state, teamName) => collectTeamScopedStateRemovals(state, teamName),
      resetScope: (teamName, mutation) => {
        invalidateTeamLocalStateEpoch(teamName);
        if (mutation === 'soft-delete') {
          clearTeamTaskBoardAnalytics(teamName);
        }
        defaultTeamMessageFeedCoordinator.clearPendingReplyTimer(teamName);
        clearPendingReplyRefreshWaits(teamName);
        teamStateLifecycleCoordinator.clearTeam(teamName);
      },
    }),
    clock: {
      nowIso,
    },
    refresh: {
      fetchAllTasks: () => get().fetchAllTasks(),
      fetchTeams: () => get().fetchTeams(),
    },
    state: {
      setState: (update) => set((state) => update(state)),
    },
    transport: {
      permanentlyDelete: (teamName) =>
        unwrapIpc('team:permanentlyDeleteTeam', () => api.teams.permanentlyDeleteTeam(teamName)),
      restore: (teamName) => unwrapIpc('team:restoreTeam', () => api.teams.restoreTeam(teamName)),
      softDelete: (teamName) => unwrapIpc('team:deleteTeam', () => api.teams.deleteTeam(teamName)),
    },
  }),
  provisioningRuns: {},
  provisioningSnapshotByTeam: {},
  currentProvisioningRunIdByTeam: {},
  currentRuntimeRunIdByTeam: {},
  ignoredProvisioningRunIds: {},
  ignoredRuntimeRunIds: {},
  ...createTeamProvisioningControlSlice({
    effects: {
      applyProgress: (progress) => get().onProvisioningProgress(progress),
      clearLaunchTracking: (runId) => teamLaunchAnalyticsCoordinator.clearRun(runId),
      clearRuntimeFreshness: (teamName) =>
        teamStateLifecycleCoordinator.clearRuntimeFreshness(teamName),
    },
    state: {
      getState: () => get(),
      setState: (update) => {
        if (typeof update === 'function') {
          set((state) => update(state));
          return;
        }
        set(update);
      },
    },
  }),
  ...createTeamProvisioningLaunchSlice<TeamMessagesCacheEntry, TeamLaunchAnalyticsContext>({
    analytics: teamLaunchAnalyticsCoordinator.createLaunchPort(),
    control: {
      clearMissingRun: (runId) => get().clearMissingProvisioningRun(runId),
      getStatus: (runId) => get().getProvisioningStatus(runId),
      subscribe: () => get().subscribeProvisioningProgress(),
    },
    scope: {
      collectVisibleLoadingResets: (state, teamName) =>
        collectTeamScopedVisibleLoadingResets(state, teamName),
      getTeamData: (teamName) => selectTeamDataForName(get(), teamName),
      reset: (teamName) => {
        invalidateTeamLocalStateEpoch(teamName);
        defaultTeamMessageFeedCoordinator.clearPendingReplyTimer(teamName);
        clearPendingReplyRefreshWaits(teamName);
        teamStateLifecycleCoordinator.clearTeam(teamName);
      },
    },
    state: {
      getState: () => get(),
      setState: (update) => {
        if (typeof update === 'function') {
          set((state) => update(state));
          return;
        }
        set(update);
      },
    },
  }),
  ...createTeamProvisioningProgressSlice({
    analytics: teamLaunchAnalyticsCoordinator.createProgressPort({
      getTeamData: (teamName) => selectTeamDataForName(get(), teamName),
      noteRefreshFanout: (note) =>
        noteTeamRefreshFanout({
          ...note,
          surface: 'provisioning-progress',
        }),
    }),
    refresh: {
      fetchMemberSpawnStatuses: (teamName) => get().fetchMemberSpawnStatuses(teamName),
      fetchTeamAgentRuntime: (teamName) => get().fetchTeamAgentRuntime(teamName),
      fetchTeams: () => get().fetchTeams(),
      getSurface: (teamName) => {
        const state = get();
        return {
          hasSelectedTeamData: state.selectedTeamData != null,
          selected: state.selectedTeamName === teamName,
          visible: isVisibleInActiveTeamSurface(state, teamName),
        };
      },
      refreshTeamData: (teamName, options) => get().refreshTeamData(teamName, options),
      selectTeam: (teamName, options) => get().selectTeam(teamName, options),
    },
    runtime: {
      clearFreshness: (teamName) => teamStateLifecycleCoordinator.clearRuntimeFreshness(teamName),
    },
    state: {
      getState: () => get(),
      setState: (update) => {
        if (typeof update === 'function') {
          set((state) => update(state));
          return;
        }
        set(update);
      },
    },
  }),
  provisioningStartedAtFloorByTeam: {},
  leadActivityByTeam: {},
  leadContextByTeam: {},
  activeTaskLogActivityByTeam: {},
  activeToolsByTeam: {},
  finishedVisibleByTeam: {},
  toolHistoryByTeam: {},
  memberSpawnStatusesByTeam: {},
  memberSpawnSnapshotsByTeam: {},
  teamAgentRuntimeByTeam: {},
  ...teamStateLifecycleCoordinator.createRuntimeObservationSlice({
    debug: (message) => logger.debug(message),
    getActiveContextState: () => get(),
    state: {
      getState: () => get(),
      setState: (update) => {
        if (typeof update === 'function') {
          set((state) => update(state));
          return;
        }
        set(update);
      },
    },
  }),
  provisioningErrorByTeam: {},
  clearProvisioningError: (teamName?: string) =>
    set((state) => {
      if (!teamName) {
        return { provisioningErrorByTeam: {} };
      }

      if (!(teamName in state.provisioningErrorByTeam)) {
        return {};
      }

      const nextErrors = { ...state.provisioningErrorByTeam };
      delete nextErrors[teamName];
      return { provisioningErrorByTeam: nextErrors };
    }),
  kanbanFilterQuery: null,
  globalTaskDetail: null,
  pendingMemberProfile: null,
  pendingTeamSectionFocus: null,
  openMemberProfile: (
    memberName: string,
    teamName?: string,
    focus?: PendingMemberProfileState['focus']
  ) => set({ pendingMemberProfile: { memberName, teamName, focus } }),
  closeMemberProfile: () => set({ pendingMemberProfile: null }),
  focusTeamSection: (teamName: string, section: TeamSectionTarget) =>
    set({ pendingTeamSectionFocus: { teamName, section } }),
  clearTeamSectionFocus: () => set({ pendingTeamSectionFocus: null }),
  pendingReviewRequest: null,
  setPendingReviewRequest: (req) => set({ pendingReviewRequest: req }),
  openGlobalTaskDetail: (teamName: string, taskId: string, commentId?: string) => {
    set({ globalTaskDetail: { teamName, taskId, commentId } });
  },
  closeGlobalTaskDetail: () => set({ globalTaskDetail: null }),
  pendingApprovals: [],
  resolvedApprovals: new Map(),
  toolApprovalSettings: loadToolApprovalSettings(),

  // Messages panel UI state
  messagesPanelMode: loadPersistedMessagesPanelMode(),
  messagesPanelWidth: 340,
  sidebarLogsHeight: 213,
  setMessagesPanelMode: (mode: TeamMessagesPanelMode) => {
    savePersistedMessagesPanelMode(mode);
    set({ messagesPanelMode: mode });
  },
  setMessagesPanelWidth: (width: number) => set({ messagesPanelWidth: width }),
  setSidebarLogsHeight: (height: number) => set({ sidebarLogsHeight: height }),

  openTeamsTab: (projectPath?: string) => {
    const state = get();
    const normalizedProjectPath = projectPath?.trim() ?? '';
    set({
      teamsProjectNavigationIntent:
        normalizedProjectPath && state.selectedProjectId
          ? {
              projectId: state.selectedProjectId,
              projectPath: normalizedProjectPath,
            }
          : null,
    });
    const focusedPane = state.paneLayout.panes.find((p) => p.id === state.paneLayout.focusedPaneId);
    const teamsTab = focusedPane?.tabs.find((tab) => tab.type === 'teams');
    if (teamsTab) {
      state.setActiveTab(teamsTab.id);
      return;
    }

    state.openTab({
      type: 'teams',
      label: 'Teams',
    });
  },

  openTeamTab: (teamName: string, projectPath?: string, _taskId?: string) => {
    if (!teamName.trim()) {
      return;
    }

    // If projectPath is provided, immediately select the matching project in the sidebar.
    // This avoids a race condition where config.json hasn't been updated with projectPath yet.
    if (projectPath) {
      const stateForProject = get();
      const normalizedPath = normalizePath(projectPath);
      const matchingProject = stateForProject.projects.find(
        (p) => normalizePath(p.path) === normalizedPath
      );
      if (matchingProject && stateForProject.selectedProjectId !== matchingProject.id) {
        stateForProject.selectProject(matchingProject.id);
      }
    }

    const state = get();
    // Use display name from teams list or selected team data if available
    const teamSummary = state.teamByName[teamName];
    const selectedTeamDisplayName =
      state.selectedTeamName === teamName ? state.selectedTeamData?.config.name : undefined;
    const displayName = teamSummary?.displayName || selectedTeamDisplayName || teamName;

    const allTabs = state.getAllPaneTabs();
    const existing = allTabs.find((tab) => tab.type === 'team' && tab.teamName === teamName);
    if (existing) {
      state.setActiveTab(existing.id);
      // Sync label in case display name changed
      if (existing.label !== displayName) {
        state.updateTabLabel(existing.id, displayName);
      }
    } else {
      state.openTab({
        type: 'team',
        label: displayName,
        teamName,
      });
    }
  },

  clearKanbanFilter: () => {
    set({ kanbanFilterQuery: null });
  },

  ...createTeamGraphLayoutActions<AppState>({
    setState: (updater) => set((state) => updater(state) ?? state),
    selectDefaultLayoutSeed: (state, teamName) => {
      const teamData = selectTeamDataForName(state, teamName);
      return teamData
        ? buildTeamGraphDefaultLayoutSeed(teamData.members, teamData.config.members ?? [])
        : null;
    },
    warn: (message) => logger.warn(message),
  }),
  addMember: async (teamName: string, request: AddMemberRequest) => {
    await unwrapIpc('team:addMember', () => api.teams.addMember(teamName, request));
    await get().refreshTeamData(teamName);
  },

  restartMember: async (teamName: string, memberName: string) => {
    try {
      await unwrapIpc('team:restartMember', () => api.teams.restartMember(teamName, memberName));
    } finally {
      await Promise.allSettled([
        get().refreshTeamMessagesHead(teamName),
        get().fetchMemberSpawnStatuses(teamName),
        get().fetchTeamAgentRuntime(teamName),
      ]);
    }
  },

  retryFailedOpenCodeSecondaryLanes: async (teamName: string) => {
    try {
      return await unwrapIpc('team:retryFailedOpenCodeSecondaryLanes', () =>
        api.teams.retryFailedOpenCodeSecondaryLanes(teamName)
      );
    } finally {
      await Promise.allSettled([
        get().fetchMemberSpawnStatuses(teamName),
        get().fetchTeamAgentRuntime(teamName),
      ]);
    }
  },

  skipMemberForLaunch: async (teamName: string, memberName: string) => {
    try {
      await unwrapIpc('team:skipMemberForLaunch', () =>
        api.teams.skipMemberForLaunch(teamName, memberName)
      );
    } finally {
      await Promise.allSettled([
        get().fetchMemberSpawnStatuses(teamName),
        get().fetchTeamAgentRuntime(teamName),
        get().fetchTeams(),
      ]);
    }
  },

  removeMember: async (teamName: string, memberName: string) => {
    await unwrapIpc('team:removeMember', () => api.teams.removeMember(teamName, memberName));
    await get().refreshTeamData(teamName);
  },

  restoreMember: async (teamName: string, memberName: string) => {
    await unwrapIpc('team:restoreMember', () => api.teams.restoreMember(teamName, memberName));
    await get().refreshTeamData(teamName);
    await Promise.allSettled([
      get().fetchMemberSpawnStatuses(teamName),
      get().fetchTeamAgentRuntime(teamName),
    ]);
  },

  updateMemberRole: async (teamName: string, memberName: string, role: string | undefined) => {
    await unwrapIpc('team:updateMemberRole', () =>
      api.teams.updateMemberRole(teamName, memberName, role)
    );
    await get().refreshTeamData(teamName);
  },

  updateToolApprovalSettings: async (patch, forTeam) => {
    const teamName = forTeam ?? get().selectedTeamName;
    const current = get().toolApprovalSettings;
    const merged = { ...current, ...patch };
    set({ toolApprovalSettings: merged });
    // Save per-team if a team is selected, otherwise global fallback
    if (teamName) {
      saveTeamToolApprovalSettings(teamName, merged);
    } else {
      localStorage.setItem('team:toolApprovalSettings', JSON.stringify(merged));
    }
    try {
      await api.teams.updateToolApprovalSettings(teamName ?? '__global__', merged);
    } catch (err) {
      logger.warn('Failed to sync tool approval settings to main:', err);
    }
  },

  respondToToolApproval: async (teamName, runId, requestId, allow, message) => {
    try {
      await api.teams.respondToToolApproval(teamName, runId, requestId, allow, message);
      // Remove ONLY after successful IPC, by runId+requestId pair
      set((s) => {
        const next = new Map(s.resolvedApprovals);
        next.set(requestId, allow);
        return {
          pendingApprovals: s.pendingApprovals.filter(
            (a) => !(a.runId === runId && a.requestId === requestId)
          ),
          resolvedApprovals: next,
        };
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.error(`respondToToolApproval failed for ${teamName}/${requestId}: ${msg}`);
      // Surface the error so ToolApprovalSheet can show feedback
      throw err;
    }
  },
});
