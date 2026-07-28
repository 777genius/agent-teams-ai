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
  createTeamLifecycleMutationTransport,
  type TeamLifecycleMutationSlice,
} from '@features/team-lifecycle/renderer';
import { isActiveProvisioningState } from '@features/team-provisioning';
import {
  createProductTeamLaunchAnalyticsCoordinator,
  createTeamProvisioningControlSlice,
  createTeamProvisioningLaunchSlice,
  createTeamProvisioningProgressSlice,
  createTeamToolApprovalTransport,
  loadAllTeamLaunchParams,
  saveTeamLaunchParams,
  saveTeamToolApprovalSettings,
  type TeamLaunchAnalyticsContext,
  type TeamProvisioningControlSlice,
  type TeamProvisioningLaunchSlice,
  type TeamProvisioningProgressSlice,
  type TeamRuntimeObservationSlice,
} from '@features/team-provisioning/renderer';
import {
  createTeamRosterMutationRendererSlice,
  createTeamRosterMutationTransport,
  type TeamRosterMutationRendererSlice,
} from '@features/team-roster-mutations/renderer';
import {
  createTeamRuntimeOperationsRendererSlice,
  createTeamRuntimeOperationsTransport,
  type TeamRuntimeOperationsRendererSlice,
} from '@features/team-runtime-operations/renderer';
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
import { normalizePath } from '@renderer/utils/pathNormalize';
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
import {
  loadAllToolApprovalSettingsByTeam,
  loadLegacyToolApprovalSettings,
  loadToolApprovalSettingsForTeam,
  projectToolApprovalSettings,
} from '../team/teamToolApprovalSettings';
import {
  persistAndScheduleToolApprovalSettingsSync,
  resetToolApprovalSettingsSync,
  scheduleToolApprovalSettingsSync,
} from '../team/teamToolApprovalSettingsSync';
import { noteTeamRefreshFanout } from '../teamRefreshFanoutDiagnostics';

import type { AppState } from '../types';
import type { TeamMessageDeliveryRendererSlice } from '@features/team-message-delivery/renderer';
import type { TeamMessagesPanelMode } from '@renderer/types/teamMessagesPanelMode';
import type { TaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import type {
  ActiveToolCall,
  LeadActivityState,
  LeadContextUsage,
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  NotificationTarget,
  TeamAgentRuntimeSnapshot,
  TeamProvisioningProgress,
  TeamSummary,
  ToolApprovalRequest,
  ToolApprovalSettings,
} from '@shared/types';
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
const recordAttachmentAttachEnd = productAnalytics.recordAttachmentAttachEnd ?? (() => undefined);
const recordCrossTeamMessageSend = productAnalytics.recordCrossTeamMessageSend ?? (() => undefined);
const recordTeamDelete = productAnalytics.recordTeamDelete ?? (() => undefined);
const teamDirectoryRefreshCoordinator = new TeamDirectoryRefreshCoordinator<ContextRequestScope>();
const teamStateLifecycleCoordinator = new TeamStateLifecycleCoordinator(
  teamDirectoryRefreshCoordinator
);
const teamLaunchAnalyticsCoordinator = createProductTeamLaunchAnalyticsCoordinator();
const teamToolApprovalTransport = createTeamToolApprovalTransport();
export const isTeamDataRefreshPending = (teamName: string): boolean =>
  teamStateLifecycleCoordinator.isTeamDataRefreshPending(teamName);
export function __resetTeamSliceModuleStateForTests(): void {
  resetToolApprovalSettingsSync();
  teamStateLifecycleCoordinator.reset();
  teamLaunchAnalyticsCoordinator.reset();
  resetTeamTaskBoardAnalyticsForTests();
}
export function __getTeamScopedTransientStateForTests(
  teamName: string
): TeamScopedTransientStateSnapshot {
  return teamStateLifecycleCoordinator.snapshot(teamName);
}
const nowIso = (): string => new Date().toISOString();
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
const isVisibleInActiveTeamSurface = (
  state: Pick<AppState, 'paneLayout'>,
  teamName: string | null | undefined
): boolean =>
  Boolean(teamName) &&
  state.paneLayout.panes.some((pane) => {
    const activeTab = pane.tabs.find((tab) => tab.id === pane.activeTabId);
    return (
      (activeTab?.type === 'team' || activeTab?.type === 'graph') && activeTab.teamName === teamName
    );
  });
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
    TeamRuntimeOperationsRendererSlice,
    TeamRosterMutationRendererSlice,
    TeamDirectoryRendererSlice,
    TeamTaskArtifactsRendererSlice,
    TeamTaskBoardRendererSlice,
    TeamViewDataRendererSlice {
  globalTaskDetail: GlobalTaskDetailState | null;
  openGlobalTaskDetail: (teamName: string, taskId: string, commentId?: string) => void;
  closeGlobalTaskDetail: () => void;
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
  provisioningSnapshotByTeam: Record<string, TeamSummary>;
  currentProvisioningRunIdByTeam: Record<string, string | null>;
  currentRuntimeRunIdByTeam: Record<string, string | null>;
  ignoredProvisioningRunIds: Record<string, string>;
  ignoredRuntimeRunIds: Record<string, string>;
  provisioningStartedAtFloorByTeam: Record<string, string>;
  leadActivityByTeam: Record<string, LeadActivityState>;
  leadContextByTeam: Record<string, LeadContextUsage>;
  activeTaskLogActivityByTeam: Record<string, Record<string, true>>;
  activeToolsByTeam: Record<string, Record<string, Record<string, ActiveToolCall>>>;
  finishedVisibleByTeam: Record<string, Record<string, Record<string, ActiveToolCall>>>;
  toolHistoryByTeam: Record<string, Record<string, ActiveToolCall[]>>;
  memberSpawnStatusesByTeam: Record<string, Record<string, MemberSpawnStatusEntry>>;
  memberSpawnSnapshotsByTeam: Record<string, MemberSpawnStatusesSnapshot>;
  teamAgentRuntimeByTeam: Record<string, TeamAgentRuntimeSnapshot>;
  provisioningErrorByTeam: Record<string, string | null>;
  clearProvisioningError: (teamName?: string) => void;
  kanbanFilterQuery: string | null;
  openTeamsTab: (projectPath?: string) => void;
  openTeamTab: (teamName: string, projectPath?: string, taskId?: string) => void;
  clearKanbanFilter: () => void;
  pendingApprovals: ToolApprovalRequest[];
  resolvedApprovals: Map<string, boolean>;
  toolApprovalSettingsByTeam: Record<string, ToolApprovalSettings>;
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
      loadToolApprovalSettings: (teamName) => {
        const settings = loadToolApprovalSettingsForTeam(teamName);
        set((state) => projectToolApprovalSettings(state, teamName, settings, true));
        scheduleToolApprovalSettingsSync(teamName, settings);
        return settings;
      },
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
    transport: createTeamLifecycleMutationTransport(),
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
    persistence: {
      loadAllLaunchParams: loadAllTeamLaunchParams,
      saveLaunchParams: saveTeamLaunchParams,
      saveToolApprovalSettings: (teamName, settings) => {
        saveTeamToolApprovalSettings(teamName, settings);
        set((state) => projectToolApprovalSettings(state, teamName, settings));
      },
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
        if (
          Object.keys(update).length === 1 &&
          Object.prototype.hasOwnProperty.call(update, 'toolApprovalSettings')
        ) {
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
  toolApprovalSettingsByTeam: loadAllToolApprovalSettingsByTeam(),
  toolApprovalSettings: loadLegacyToolApprovalSettings(),
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
    if (!teamName.trim()) return;
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
  clearKanbanFilter: () => set({ kanbanFilterQuery: null }),
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
  ...createTeamRosterMutationRendererSlice({
    actions: { getActions: get },
    transport: createTeamRosterMutationTransport(),
  }),
  ...createTeamRuntimeOperationsRendererSlice({
    actions: { getActions: get },
    transport: createTeamRuntimeOperationsTransport(),
  }),
  updateToolApprovalSettings: async (patch, forTeam) => {
    const teamName = forTeam ?? get().selectedTeamName;
    const stateBeforeUpdate = get();
    const current = teamName
      ? (stateBeforeUpdate.toolApprovalSettingsByTeam[teamName] ??
        loadToolApprovalSettingsForTeam(teamName))
      : stateBeforeUpdate.toolApprovalSettings;
    const merged = { ...current, ...patch };
    set((state) =>
      teamName
        ? projectToolApprovalSettings(state, teamName, merged)
        : { toolApprovalSettings: merged }
    );
    persistAndScheduleToolApprovalSettingsSync(teamName, merged);
  },
  respondToToolApproval: async (teamName, runId, requestId, allow, message) => {
    try {
      await teamToolApprovalTransport.respond(teamName, runId, requestId, allow, message);
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
      throw err;
    }
  },
});
