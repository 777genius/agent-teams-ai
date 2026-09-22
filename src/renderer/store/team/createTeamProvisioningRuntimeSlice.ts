import { isActiveProvisioningState } from '@features/team-provisioning';
import {
  createProductTeamLaunchAnalyticsCoordinator,
  createTeamProvisioningControlSlice,
  createTeamProvisioningLaunchSlice,
  createTeamProvisioningProgressSlice,
  type TeamLaunchAnalyticsContext,
  type TeamProvisioningControlSlice,
  type TeamProvisioningLaunchSlice,
  type TeamProvisioningProgressSlice,
  type TeamRuntimeObservationSlice,
  type TeamRuntimeObservationStatePort,
} from '@features/team-provisioning/renderer';
import {
  defaultTeamMessageFeedCoordinator,
  type TeamMessagesCacheEntry,
} from '@features/team-view-read-model/renderer';
import { createTeamProvisioningRuntimeAdapters } from '@renderer/composition/team/createTeamProvisioningRuntimeAdapters';

import { noteTeamRefreshFanout } from '../teamRefreshFanoutDiagnostics';

import { selectTeamDataForName } from './teamDataSelectors';
import { invalidateTeamLocalStateEpoch } from './teamLocalStateEpoch';
import { clearPendingReplyRefreshWaits } from './teamPendingReplyWaits';
import { collectTeamScopedVisibleLoadingResets } from './teamScopedStateCleanup';
import { projectToolApprovalSettings } from './teamToolApprovalSettings';

import type { AppState } from '../types';
import type {
  ActiveToolCall,
  LeadActivityState,
  LeadContextUsage,
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  TeamAgentRuntimeSnapshot,
  TeamProvisioningProgress,
  TeamSummary,
} from '@shared/types';

interface RuntimeObservationCompositionDependencies {
  debug(message: string): void;
  getActiveContextState(): Pick<AppState, 'activeContextId'>;
  state: TeamRuntimeObservationStatePort;
}

interface TeamProvisioningRuntimeLifecyclePort {
  clearRuntimeFreshness(teamName: string): void;
  clearTeam(teamName: string): void;
  createRuntimeObservationSlice(
    dependencies: RuntimeObservationCompositionDependencies
  ): TeamRuntimeObservationSlice;
}

type TeamProvisioningRuntimeStateUpdate =
  | Partial<AppState>
  | ((state: AppState) => Partial<AppState>);

interface TeamProvisioningRuntimeStatePort {
  getState(): AppState;
  setState(update: TeamProvisioningRuntimeStateUpdate): void;
}

export interface TeamProvisioningRuntimeSliceDependencies {
  lifecycle: TeamProvisioningRuntimeLifecyclePort;
  log: {
    debug(message: string): void;
  };
  state: TeamProvisioningRuntimeStatePort;
}

export interface TeamProvisioningRuntimeSlice
  extends
    TeamProvisioningControlSlice,
    TeamProvisioningLaunchSlice,
    TeamProvisioningProgressSlice,
    TeamRuntimeObservationSlice {
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
  clearProvisioningError(teamName?: string): void;
}

const teamProvisioningRuntimeAdapters = createTeamProvisioningRuntimeAdapters();
const teamLaunchAnalyticsCoordinator = createProductTeamLaunchAnalyticsCoordinator(
  teamProvisioningRuntimeAdapters.launchAnalytics
);

export function resetTeamProvisioningRuntimeSliceForTests(): void {
  teamLaunchAnalyticsCoordinator.reset();
}

export function getCurrentProvisioningProgressForTeam(
  state: Pick<TeamProvisioningRuntimeSlice, 'currentProvisioningRunIdByTeam' | 'provisioningRuns'>,
  teamName: string
): TeamProvisioningProgress | null {
  const currentRunId = state.currentProvisioningRunIdByTeam[teamName];
  return currentRunId ? (state.provisioningRuns[currentRunId] ?? null) : null;
}

export function isTeamProvisioningActive(
  state: Pick<TeamProvisioningRuntimeSlice, 'currentProvisioningRunIdByTeam' | 'provisioningRuns'>,
  teamName: string
): boolean {
  const current = getCurrentProvisioningProgressForTeam(state, teamName);
  return current != null && isActiveProvisioningState(current.state);
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

export function createTeamProvisioningRuntimeSlice(
  dependencies: TeamProvisioningRuntimeSliceDependencies
): TeamProvisioningRuntimeSlice {
  const getState = (): AppState => dependencies.state.getState();
  const setState = (update: TeamProvisioningRuntimeStateUpdate): void =>
    dependencies.state.setState(update);
  const resetTeamScope = (teamName: string): void => {
    invalidateTeamLocalStateEpoch(teamName);
    defaultTeamMessageFeedCoordinator.clearPendingReplyTimer(teamName);
    clearPendingReplyRefreshWaits(teamName);
    dependencies.lifecycle.clearTeam(teamName);
  };

  const controlSlice = createTeamProvisioningControlSlice({
    effects: {
      applyProgress: (progress) => getState().onProvisioningProgress(progress),
      clearLaunchTracking: (runId) => teamLaunchAnalyticsCoordinator.clearRun(runId),
      clearRuntimeFreshness: (teamName) => dependencies.lifecycle.clearRuntimeFreshness(teamName),
    },
    state: {
      getState,
      setState: (update) => {
        if (typeof update === 'function') {
          setState((state) => update(state));
          return;
        }
        setState(update);
      },
    },
    transport: teamProvisioningRuntimeAdapters.control,
  });

  const launchSlice = createTeamProvisioningLaunchSlice<
    TeamMessagesCacheEntry,
    TeamLaunchAnalyticsContext
  >({
    analytics: teamLaunchAnalyticsCoordinator.createLaunchPort(),
    control: {
      clearMissingRun: (runId) => getState().clearMissingProvisioningRun(runId),
      getStatus: (runId) => getState().getProvisioningStatus(runId),
      subscribe: () => getState().subscribeProvisioningProgress(),
    },
    persistence: {
      loadAllLaunchParams: teamProvisioningRuntimeAdapters.persistence.loadAllLaunchParams,
      saveLaunchParams: teamProvisioningRuntimeAdapters.persistence.saveLaunchParams,
      saveToolApprovalSettings: (teamName, settings) => {
        teamProvisioningRuntimeAdapters.persistence.saveToolApprovalSettings(teamName, settings);
        setState((state) => projectToolApprovalSettings(state, teamName, settings));
      },
    },
    scope: {
      collectVisibleLoadingResets: (state, teamName) =>
        collectTeamScopedVisibleLoadingResets(state, teamName),
      getTeamData: (teamName) => selectTeamDataForName(getState(), teamName),
      reset: resetTeamScope,
    },
    state: {
      getState,
      setState: (update) => {
        if (typeof update === 'function') {
          setState((state) => update(state));
          return;
        }
        if (
          Object.keys(update).length === 1 &&
          Object.prototype.hasOwnProperty.call(update, 'toolApprovalSettings')
        ) {
          return;
        }
        setState(update);
      },
    },
    transport: teamProvisioningRuntimeAdapters.launch,
  });

  const progressSlice = createTeamProvisioningProgressSlice({
    analytics: teamLaunchAnalyticsCoordinator.createProgressPort({
      getTeamData: (teamName) => selectTeamDataForName(getState(), teamName),
      noteRefreshFanout: (note) =>
        noteTeamRefreshFanout({
          ...note,
          surface: 'provisioning-progress',
        }),
    }),
    refresh: {
      fetchMemberSpawnStatuses: (teamName) => getState().fetchMemberSpawnStatuses(teamName),
      fetchTeamAgentRuntime: (teamName) => getState().fetchTeamAgentRuntime(teamName),
      fetchTeams: () => getState().fetchTeams(),
      getSurface: (teamName) => {
        const state = getState();
        return {
          hasSelectedTeamData: state.selectedTeamData != null,
          selected: state.selectedTeamName === teamName,
          visible: isVisibleInActiveTeamSurface(state, teamName),
        };
      },
      refreshTeamData: (teamName, options) => getState().refreshTeamData(teamName, options),
      selectTeam: (teamName, options) => getState().selectTeam(teamName, options),
    },
    runtime: {
      clearFreshness: (teamName) => dependencies.lifecycle.clearRuntimeFreshness(teamName),
    },
    state: {
      getState,
      setState: (update) => {
        if (typeof update === 'function') {
          setState((state) => update(state));
          return;
        }
        setState(update);
      },
    },
  });

  const runtimeObservationSlice = dependencies.lifecycle.createRuntimeObservationSlice({
    debug: (message) => dependencies.log.debug(message),
    getActiveContextState: getState,
    state: {
      getState,
      setState: (update) => {
        if (typeof update === 'function') {
          setState((state) => update(state));
          return;
        }
        setState(update);
      },
    },
  });

  return {
    provisioningRuns: {},
    provisioningSnapshotByTeam: {},
    currentProvisioningRunIdByTeam: {},
    currentRuntimeRunIdByTeam: {},
    ignoredProvisioningRunIds: {},
    ignoredRuntimeRunIds: {},
    ...controlSlice,
    ...launchSlice,
    ...progressSlice,
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
    ...runtimeObservationSlice,
    provisioningErrorByTeam: {},
    clearProvisioningError: (teamName?: string) =>
      setState((state) => {
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
  };
}
