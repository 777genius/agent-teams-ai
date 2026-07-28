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
import { createTeamToolApprovalTransport } from '@features/team-provisioning/renderer';
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
  type TeamViewDataRendererSlice,
} from '@features/team-view-read-model/renderer';
import { classifyAnalyticsError } from '@renderer/analytics/productAnalytics';
import * as productAnalytics from '@renderer/analytics/productAnalytics';
import { getTeamLifecycleAnalyticsContext } from '@renderer/analytics/teamAnalyticsMetadata';
import { createLogger } from '@shared/utils/logger';

import { createTeamCollaborationDataSlice } from '../team/createTeamCollaborationDataSlice';
import {
  createTeamNavigationSlice,
  type TeamNavigationSlice,
} from '../team/createTeamNavigationSlice';
import {
  createTeamProvisioningRuntimeSlice,
  getCurrentProvisioningProgressForTeam,
  isTeamProvisioningActive,
  resetTeamProvisioningRuntimeSliceForTests,
  type TeamProvisioningRuntimeSlice,
} from '../team/createTeamProvisioningRuntimeSlice';
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

import type { AppState } from '../types';
import type { TeamMessageDeliveryRendererSlice } from '@features/team-message-delivery/renderer';
import type { TeamMessagesPanelMode } from '@renderer/types/teamMessagesPanelMode';
import type { ToolApprovalRequest, ToolApprovalSettings } from '@shared/types';
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
export type {
  GlobalTaskDetailState,
  PendingMemberProfileState,
  PendingReviewRequestState,
  PendingTeamSectionFocusState,
  TeamsProjectNavigationIntent,
} from '../team/teamSliceStateTypes';
export type { TeamLaunchParams } from '@features/team-provisioning/renderer';
export { getCurrentProvisioningProgressForTeam, isTeamProvisioningActive };
const logger = createLogger('teamSlice');
const recordAttachmentAttachEnd = productAnalytics.recordAttachmentAttachEnd ?? (() => undefined);
const recordCrossTeamMessageSend = productAnalytics.recordCrossTeamMessageSend ?? (() => undefined);
const recordTeamDelete = productAnalytics.recordTeamDelete ?? (() => undefined);
const teamDirectoryRefreshCoordinator = new TeamDirectoryRefreshCoordinator<ContextRequestScope>();
const teamStateLifecycleCoordinator = new TeamStateLifecycleCoordinator(
  teamDirectoryRefreshCoordinator
);
const teamToolApprovalTransport = createTeamToolApprovalTransport();
export const isTeamDataRefreshPending = (teamName: string): boolean =>
  teamStateLifecycleCoordinator.isTeamDataRefreshPending(teamName);
export function __resetTeamSliceModuleStateForTests(): void {
  resetToolApprovalSettingsSync();
  teamStateLifecycleCoordinator.reset();
  resetTeamProvisioningRuntimeSliceForTests();
  resetTeamTaskBoardAnalyticsForTests();
}
export function __getTeamScopedTransientStateForTests(
  teamName: string
): TeamScopedTransientStateSnapshot {
  return teamStateLifecycleCoordinator.snapshot(teamName);
}
const nowIso = (): string => new Date().toISOString();
export interface TeamSlice
  extends
    TeamGraphLayoutSlice,
    TeamLifecycleMutationSlice,
    TeamMessageDeliveryRendererSlice,
    TeamMessageFeedRendererSlice,
    TeamProvisioningRuntimeSlice,
    TeamRuntimeOperationsRendererSlice,
    TeamRosterMutationRendererSlice,
    TeamDirectoryRendererSlice,
    TeamNavigationSlice,
    TeamTaskArtifactsRendererSlice,
    TeamTaskBoardRendererSlice,
    TeamViewDataRendererSlice {
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
  ...createTeamNavigationSlice({
    state: {
      getState: get,
      setState: (update) => set(update),
    },
  }),
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
  ...createTeamProvisioningRuntimeSlice({
    lifecycle: {
      clearRuntimeFreshness: (teamName) =>
        teamStateLifecycleCoordinator.clearRuntimeFreshness(teamName),
      clearTeam: (teamName) => teamStateLifecycleCoordinator.clearTeam(teamName),
      createRuntimeObservationSlice: (dependencies) =>
        teamStateLifecycleCoordinator.createRuntimeObservationSlice(dependencies),
    },
    log: {
      debug: (message) => logger.debug(message),
    },
    state: {
      getState: get,
      setState: (update) => {
        if (typeof update === 'function') {
          set((state) => update(state));
          return;
        }
        set(update);
      },
    },
  }),
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
