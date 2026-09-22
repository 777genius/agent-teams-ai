import * as teamGraph from '@features/agent-graph';
import * as teamLifecycle from '@features/team-lifecycle/renderer';
import * as teamProvisioning from '@features/team-provisioning/renderer';
import { createTeamRosterMutationRendererSlice } from '@features/team-roster-mutations/renderer';
import { createTeamRuntimeOperationsRendererSlice } from '@features/team-runtime-operations/renderer';
import * as teamTaskBoard from '@features/team-task-board/renderer';
import * as teamViewReadModel from '@features/team-view-read-model/renderer';
import * as productAnalytics from '@renderer/analytics/productAnalytics';
import { getTeamLifecycleAnalyticsContext } from '@renderer/analytics/teamAnalyticsMetadata';
import { createTeamLifecycleMutationTransport } from '@renderer/composition/team/createTeamLifecycleMutationTransport';
import { createTeamRosterMutationTransport } from '@renderer/composition/team/createTeamRosterMutationTransport';
import { createTeamRuntimeObservationTransport } from '@renderer/composition/team/createTeamRuntimeObservationTransport';
import { createTeamRuntimeOperationsTransport } from '@renderer/composition/team/createTeamRuntimeOperationsTransport';
import { createTeamToolApprovalTransport } from '@renderer/composition/team/createTeamToolApprovalTransport';
import { createLogger } from '@shared/utils/logger';

import { createTeamCollaborationDataSlice } from './createTeamCollaborationDataSlice';
import { createTeamNavigationSlice } from './createTeamNavigationSlice';
import * as provisioningRuntime from './createTeamProvisioningRuntimeSlice';
import { selectTeamDataForName } from './teamDataSelectors';
import { invalidateTeamLocalStateEpoch } from './teamLocalStateEpoch';
import * as messagesPanelModePersistence from './teamMessagesPanelModePersistence';
import { clearPendingReplyRefreshWaits } from './teamPendingReplyWaits';
import * as scopedStateCleanup from './teamScopedStateCleanup';
import * as stateLifecycle from './TeamStateLifecycleCoordinator';
import * as toolApprovalSettings from './teamToolApprovalSettings';
import * as toolApprovalSettingsSync from './teamToolApprovalSettingsSync';

import type { TeamSlice } from '../slices/teamSlice.types';
import type { AppState } from '../types';
import type { StateCreator } from 'zustand';

const logger = createLogger('teamSlice');
const recordAttachmentAttachEnd = productAnalytics.recordAttachmentAttachEnd ?? (() => undefined);
const recordCrossTeamMessageSend = productAnalytics.recordCrossTeamMessageSend ?? (() => undefined);
const recordTeamDelete = productAnalytics.recordTeamDelete ?? (() => undefined);
const teamDirectoryRefreshCoordinator =
  new teamViewReadModel.TeamDirectoryRefreshCoordinator<stateLifecycle.ContextRequestScope>();
const teamRuntimeObservationTransport = createTeamRuntimeObservationTransport();
const teamStateLifecycleCoordinator = new stateLifecycle.TeamStateLifecycleCoordinator(
  teamDirectoryRefreshCoordinator,
  teamRuntimeObservationTransport
);
const teamToolApprovalTransport = createTeamToolApprovalTransport();
const nowIso = (): string => new Date().toISOString();

export const isTeamDataRefreshPending = (teamName: string): boolean =>
  teamStateLifecycleCoordinator.isTeamDataRefreshPending(teamName);

export function __resetTeamSliceModuleStateForTests(): void {
  toolApprovalSettingsSync.resetToolApprovalSettingsSync();
  teamStateLifecycleCoordinator.reset();
  provisioningRuntime.resetTeamProvisioningRuntimeSliceForTests();
  teamTaskBoard.resetTeamTaskBoardAnalyticsForTests();
}

export function __getTeamScopedTransientStateForTests(
  teamName: string
): stateLifecycle.TeamScopedTransientStateSnapshot {
  return teamStateLifecycleCoordinator.snapshot(teamName);
}

/**
 * App-level renderer composition for the public team store shell.
 * Feature-owned slices retain provisioning, task, messaging, read-model, and runtime behavior.
 */
export const createTeamStoreFeatureSlices: StateCreator<AppState, [], [], TeamSlice> = (
  set,
  get
) => {
  const setState = (update: Partial<AppState> | ((state: AppState) => Partial<AppState>)): void => {
    if (typeof update === 'function') set((state) => update(state));
    else set(update);
  };
  const approvalDependencies: teamProvisioning.TeamToolApprovalRendererSliceDependencies<AppState> =
    {
      log: { error: (message) => logger.error(message) },
      persistedSettings: {
        loadAll: toolApprovalSettings.loadAllToolApprovalSettingsByTeam,
        loadForTeam: toolApprovalSettings.loadToolApprovalSettingsForTeam,
        loadLegacy: toolApprovalSettings.loadLegacyToolApprovalSettings,
      },
      projection: { project: toolApprovalSettings.projectToolApprovalSettings },
      responseTransport: teamToolApprovalTransport,
      settingsSync: {
        persistAndSchedule: toolApprovalSettingsSync.persistAndScheduleToolApprovalSettingsSync,
        schedule: toolApprovalSettingsSync.scheduleToolApprovalSettingsSync,
      },
      state: { getState: get, setState },
    };

  return {
    ...createTeamCollaborationDataSlice({
      analytics: {
        recordAttachmentEnd: recordAttachmentAttachEnd,
        recordCrossTeamMessageSend,
      },
      clock: { nowIso },
      directoryCoordinator: teamDirectoryRefreshCoordinator,
      lifecycle: {
        isProvisioningActive: (teamName) =>
          provisioningRuntime.isTeamProvisioningActive(get(), teamName),
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
        loadToolApprovalSettings: (teamName) =>
          teamProvisioning.loadTeamToolApprovalSettingsIntoRenderer(approvalDependencies, teamName),
      },
      state: { getState: get, setState: set },
    }),
    ...createTeamNavigationSlice({ state: { getState: get, setState } }),
    ...teamGraph.createInitialTeamGraphLayoutState(),
    ...teamLifecycle.createTeamLifecycleMutationSlice<
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
            errorClass: productAnalytics.classifyAnalyticsError(error),
          }),
        recordSoftDeleteSuccess: (context) =>
          recordTeamDelete({
            source: 'store',
            success: true,
            ...context,
            errorClass: 'none',
          }),
      },
      cleanup: teamLifecycle.createTeamLifecycleMutationCleanup<AppState>({
        buildProgressTombstones: (state, teamName, floor) =>
          scopedStateCleanup.buildTeamScopedProgressTombstones(state, teamName, floor),
        collectStateRemovals: (state, teamName) =>
          scopedStateCleanup.collectTeamScopedStateRemovals(state, teamName),
        resetScope: (teamName, mutation) => {
          invalidateTeamLocalStateEpoch(teamName);
          if (mutation === 'soft-delete') teamTaskBoard.clearTeamTaskBoardAnalytics(teamName);
          teamViewReadModel.defaultTeamMessageFeedCoordinator.clearPendingReplyTimer(teamName);
          clearPendingReplyRefreshWaits(teamName);
          teamStateLifecycleCoordinator.clearTeam(teamName);
        },
      }),
      clock: { nowIso },
      refresh: { fetchAllTasks: () => get().fetchAllTasks(), fetchTeams: () => get().fetchTeams() },
      state: { setState },
      transport: createTeamLifecycleMutationTransport(),
    }),
    ...provisioningRuntime.createTeamProvisioningRuntimeSlice({
      lifecycle: {
        clearRuntimeFreshness: (teamName) =>
          teamStateLifecycleCoordinator.clearRuntimeFreshness(teamName),
        clearTeam: (teamName) => teamStateLifecycleCoordinator.clearTeam(teamName),
        createRuntimeObservationSlice: (dependencies) =>
          teamStateLifecycleCoordinator.createRuntimeObservationSlice(dependencies),
      },
      log: { debug: (message) => logger.debug(message) },
      state: { getState: get, setState },
    }),
    ...teamProvisioning.createTeamToolApprovalRendererSlice(approvalDependencies),
    ...teamViewReadModel.createTeamViewPreferencesRendererSlice<AppState>({
      persistence: {
        loadMessagesPanelMode: messagesPanelModePersistence.loadPersistedMessagesPanelMode,
        saveMessagesPanelMode: messagesPanelModePersistence.savePersistedMessagesPanelMode,
      },
      state: { setState },
    }),
    ...teamGraph.createTeamGraphLayoutActions<AppState>({
      setState: (updater) => set((state) => updater(state) ?? state),
      selectDefaultLayoutSeed: (state, teamName) => {
        const data = selectTeamDataForName(state, teamName);
        return data
          ? teamGraph.buildTeamGraphDefaultLayoutSeed(data.members, data.config.members ?? [])
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
  };
};
