import { createTeamProvisioningControlTransport } from './createTeamProvisioningControlTransport';

import type {
  TeamProvisioningControlEffectsPort,
  TeamProvisioningControlStatePort,
  TeamProvisioningControlStoreState,
  TeamProvisioningControlTransportPort,
} from '../ports/TeamProvisioningControlPorts';
import type { TeamProvisioningProgress } from '@shared/types';

export interface TeamProvisioningControlSlice {
  provisioningProgressUnsubscribe: (() => void) | null;
  cancelProvisioning(runId: string): Promise<void>;
  clearMissingProvisioningRun(runId: string): void;
  getProvisioningStatus(runId: string): Promise<TeamProvisioningProgress>;
  subscribeProvisioningProgress(): void;
  unsubscribeProvisioningProgress(): void;
}

export interface TeamProvisioningControlSliceDependencies {
  effects: TeamProvisioningControlEffectsPort;
  state: TeamProvisioningControlStatePort;
  transport?: TeamProvisioningControlTransportPort;
}

function removeTeamRuntimeState(
  state: TeamProvisioningControlStoreState,
  teamName: string
): Pick<
  TeamProvisioningControlStoreState,
  | 'activeToolsByTeam'
  | 'finishedVisibleByTeam'
  | 'memberSpawnSnapshotsByTeam'
  | 'memberSpawnStatusesByTeam'
  | 'teamAgentRuntimeByTeam'
  | 'toolHistoryByTeam'
> {
  const memberSpawnStatusesByTeam = { ...state.memberSpawnStatusesByTeam };
  const memberSpawnSnapshotsByTeam = { ...state.memberSpawnSnapshotsByTeam };
  const teamAgentRuntimeByTeam = { ...state.teamAgentRuntimeByTeam };
  const activeToolsByTeam = { ...state.activeToolsByTeam };
  const finishedVisibleByTeam = { ...state.finishedVisibleByTeam };
  const toolHistoryByTeam = { ...state.toolHistoryByTeam };
  delete memberSpawnStatusesByTeam[teamName];
  delete memberSpawnSnapshotsByTeam[teamName];
  delete teamAgentRuntimeByTeam[teamName];
  delete activeToolsByTeam[teamName];
  delete finishedVisibleByTeam[teamName];
  delete toolHistoryByTeam[teamName];
  return {
    activeToolsByTeam,
    finishedVisibleByTeam,
    memberSpawnSnapshotsByTeam,
    memberSpawnStatusesByTeam,
    teamAgentRuntimeByTeam,
    toolHistoryByTeam,
  };
}

export function createTeamProvisioningControlSlice(
  dependencies: TeamProvisioningControlSliceDependencies
): TeamProvisioningControlSlice {
  const transport = dependencies.transport ?? createTeamProvisioningControlTransport();

  return {
    provisioningProgressUnsubscribe: null,

    getProvisioningStatus: async (runId) => {
      const progress = await transport.getStatus(runId);
      dependencies.effects.applyProgress(progress);
      return progress;
    },

    clearMissingProvisioningRun: (runId) => {
      dependencies.effects.clearLaunchTracking(runId);
      dependencies.state.setState((state) => {
        const existing = state.provisioningRuns[runId];
        if (!existing) return {};

        const provisioningRuns = { ...state.provisioningRuns };
        delete provisioningRuns[runId];

        const currentProvisioningRunIdByTeam = {
          ...state.currentProvisioningRunIdByTeam,
        };
        const isCanonicalRun = currentProvisioningRunIdByTeam[existing.teamName] === runId;
        if (isCanonicalRun) delete currentProvisioningRunIdByTeam[existing.teamName];

        const currentRuntimeRunIdByTeam = { ...state.currentRuntimeRunIdByTeam };
        const isCurrentRuntimeRun = currentRuntimeRunIdByTeam[existing.teamName] === runId;
        if (isCurrentRuntimeRun) delete currentRuntimeRunIdByTeam[existing.teamName];

        const runtimeState = isCanonicalRun ? removeTeamRuntimeState(state, existing.teamName) : {};
        if (isCanonicalRun) dependencies.effects.clearRuntimeFreshness(existing.teamName);

        return {
          provisioningRuns,
          currentProvisioningRunIdByTeam,
          currentRuntimeRunIdByTeam,
          ignoredProvisioningRunIds: {
            ...state.ignoredProvisioningRunIds,
            [runId]: existing.teamName,
          },
          ignoredRuntimeRunIds: isCurrentRuntimeRun
            ? {
                ...state.ignoredRuntimeRunIds,
                [runId]: existing.teamName,
              }
            : state.ignoredRuntimeRunIds,
          ...runtimeState,
        };
      });
    },

    cancelProvisioning: (runId) => transport.cancel(runId),

    subscribeProvisioningProgress: () => {
      if (dependencies.state.getState().provisioningProgressUnsubscribe) return;
      const unsubscribe = transport.subscribe((progress) =>
        dependencies.effects.applyProgress(progress)
      );
      if (unsubscribe)
        dependencies.state.setState({ provisioningProgressUnsubscribe: unsubscribe });
    },

    unsubscribeProvisioningProgress: () => {
      const unsubscribe = dependencies.state.getState().provisioningProgressUnsubscribe;
      if (!unsubscribe) return;
      unsubscribe();
      dependencies.state.setState({ provisioningProgressUnsubscribe: null });
    },
  };
}
