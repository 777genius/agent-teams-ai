import { planProvisioningProgressUpdate } from '../../core/application';
import { isTerminalProvisioningState } from '../../core/domain';

import type {
  TeamProvisioningProgressAnalyticsPort,
  TeamProvisioningProgressRefreshPort,
  TeamProvisioningProgressRuntimePort,
  TeamProvisioningProgressStatePort,
  TeamProvisioningProgressStoreState,
} from '../ports/TeamProvisioningProgressPorts';
import type { TeamProvisioningProgress } from '@shared/types';

export interface TeamProvisioningProgressSlice {
  onProvisioningProgress(progress: TeamProvisioningProgress): void;
}

export interface TeamProvisioningProgressSliceDependencies {
  analytics: TeamProvisioningProgressAnalyticsPort;
  refresh: TeamProvisioningProgressRefreshPort;
  runtime: TeamProvisioningProgressRuntimePort;
  state: TeamProvisioningProgressStatePort;
}

export function createTeamProvisioningProgressSlice(
  dependencies: TeamProvisioningProgressSliceDependencies
): TeamProvisioningProgressSlice {
  return {
    onProvisioningProgress: (progress) => {
      const plan = planProvisioningProgressUpdate(dependencies.state.getState(), progress);
      if (plan.kind === 'ignored') return;
      if (plan.kind === 'stale-run-removed') {
        dependencies.state.setState(plan.stateUpdate);
        return;
      }

      dependencies.analytics.recordStepTransition(plan.existingProgress, progress);
      dependencies.state.setState(plan.stateUpdate);

      if (isTerminalProvisioningState(progress.state)) {
        dependencies.analytics.recordTerminalProgress(progress);
      }

      let hydratedVisibleTeam = false;
      if (plan.becameConfigReady) {
        hydratedVisibleTeam = hydrateVisibleTeam(dependencies, progress.teamName);
      }

      if (isTerminalProvisioningState(progress.state)) {
        dependencies.state.setState((state) =>
          terminalRuntimeStateUpdate(state, progress, dependencies.runtime)
        );
      }

      if (progress.state === 'ready' || progress.state === 'disconnected') {
        refreshTerminalTeam(dependencies, progress, hydratedVisibleTeam);
      }
    },
  };
}

function hydrateVisibleTeam(
  dependencies: TeamProvisioningProgressSliceDependencies,
  teamName: string
): boolean {
  const surface = dependencies.refresh.getSurface(teamName);
  if (!surface.visible) return false;

  const shouldSelectTeam = surface.selected && !surface.hasSelectedTeamData;
  dependencies.analytics.noteRefreshFanout({
    teamName,
    phase: 'scheduled',
    reason: 'provisioning:config-ready',
    operation: shouldSelectTeam ? 'selectTeam' : 'refreshTeamData',
    selected: surface.selected,
    visible: true,
  });
  if (shouldSelectTeam) {
    void dependencies.refresh.selectTeam(teamName, {
      allowReloadWhileProvisioning: true,
    });
  } else {
    void dependencies.refresh.refreshTeamData(teamName, { withDedup: true });
  }
  return true;
}

function terminalRuntimeStateUpdate(
  state: TeamProvisioningProgressStoreState,
  progress: TeamProvisioningProgress,
  runtime: TeamProvisioningProgressRuntimePort
): Partial<TeamProvisioningProgressStoreState> {
  const memberSpawnStatusesByTeam = { ...state.memberSpawnStatusesByTeam };
  const memberSpawnSnapshotsByTeam = { ...state.memberSpawnSnapshotsByTeam };
  const teamAgentRuntimeByTeam = { ...state.teamAgentRuntimeByTeam };
  const currentStatuses = memberSpawnStatusesByTeam[progress.teamName];

  if (!currentStatuses) {
    if (progress.state !== 'ready') {
      delete teamAgentRuntimeByTeam[progress.teamName];
      runtime.clearFreshness(progress.teamName);
    }
    return {
      memberSpawnStatusesByTeam,
      memberSpawnSnapshotsByTeam,
      teamAgentRuntimeByTeam,
    };
  }

  if (progress.state === 'ready') {
    return {
      memberSpawnStatusesByTeam,
      memberSpawnSnapshotsByTeam,
      teamAgentRuntimeByTeam,
    };
  }

  const retainedStatuses = Object.fromEntries(
    Object.entries(currentStatuses).filter(([, entry]) => entry.status === 'error')
  );
  if (Object.keys(retainedStatuses).length > 0) {
    memberSpawnStatusesByTeam[progress.teamName] = retainedStatuses;
  } else {
    delete memberSpawnStatusesByTeam[progress.teamName];
    delete memberSpawnSnapshotsByTeam[progress.teamName];
  }
  delete teamAgentRuntimeByTeam[progress.teamName];
  runtime.clearFreshness(progress.teamName);
  return {
    memberSpawnStatusesByTeam,
    memberSpawnSnapshotsByTeam,
    teamAgentRuntimeByTeam,
  };
}

function refreshTerminalTeam(
  dependencies: TeamProvisioningProgressSliceDependencies,
  progress: TeamProvisioningProgress,
  hydratedVisibleTeam: boolean
): void {
  const reason =
    progress.state === 'ready'
      ? 'provisioning:terminal-ready'
      : 'provisioning:terminal-disconnected';
  dependencies.analytics.noteRefreshFanout({
    teamName: progress.teamName,
    phase: 'scheduled',
    reason,
    operation: 'fetchTeams',
  });
  void dependencies.refresh.fetchTeams();

  const surface = dependencies.refresh.getSurface(progress.teamName);
  if (surface.visible) {
    dependencies.analytics.noteRefreshFanout({
      teamName: progress.teamName,
      phase: 'scheduled',
      reason,
      operation: 'fetchMemberSpawnStatuses',
      visible: true,
    });
    void dependencies.refresh.fetchMemberSpawnStatuses(progress.teamName);
    dependencies.analytics.noteRefreshFanout({
      teamName: progress.teamName,
      phase: 'scheduled',
      reason,
      operation: 'fetchTeamAgentRuntime',
      visible: true,
    });
    void dependencies.refresh.fetchTeamAgentRuntime(progress.teamName);
  }

  if (hydratedVisibleTeam) {
    dependencies.analytics.noteRefreshFanout({
      teamName: progress.teamName,
      phase: 'skipped',
      reason: 'provisioning:already-hydrated-visible-team',
      operation: 'refreshTeamData',
      visible: true,
    });
    return;
  }
  if (!surface.visible) return;

  dependencies.analytics.noteRefreshFanout({
    teamName: progress.teamName,
    phase: 'scheduled',
    reason,
    operation: surface.selected ? 'selectTeam' : 'refreshTeamData',
    selected: surface.selected,
    visible: true,
  });
  if (surface.selected) {
    void dependencies.refresh.selectTeam(progress.teamName);
  } else {
    void dependencies.refresh.refreshTeamData(progress.teamName, {
      withDedup: true,
    });
  }
}
