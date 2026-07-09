import {
  createDefaultDeterministicCreateRunFlowPorts,
  type DeterministicCreateRunFlowPorts,
  type DeterministicCreateWorkspaceTrustPreparationInput,
} from './TeamProvisioningCreateDeterministicRunFlow';
import { runDeterministicCreateSpawnFlow } from './TeamProvisioningCreateDeterministicSpawnFlow';
import { createDeterministicCreateProvisioningRun } from './TeamProvisioningCreateTeamFlow';
import { createInitialMemberSpawnStatusEntry } from './TeamProvisioningMemberSpawnStatusPolicy';
import { type ProvisioningRun } from './TeamProvisioningRunModel';
import { type MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';

export interface TeamProvisioningCreateDeterministicRunFlowServiceHost {
  runs: Map<string, ProvisioningRun>;
  provisioningRunByTeam: Map<string, string>;
  resetTeamScopedTransientStateForNewRun(teamName: string): void;
  workspaceTrustPreSpawnBoundary: {
    prepareWorkspaceTrustForDeterministicRun(
      input: DeterministicCreateWorkspaceTrustPreparationInput<ProvisioningRun>
    ): Promise<void>;
  };
  clearPersistedLaunchState(teamName: string, options: { expectedRunId: string }): Promise<void>;
}

export function createTeamProvisioningCreateDeterministicRunFlowPortsFromService(
  service: TeamProvisioningCreateDeterministicRunFlowServiceHost
): DeterministicCreateRunFlowPorts<ProvisioningRun, MixedSecondaryRuntimeLaneState> {
  return createDefaultDeterministicCreateRunFlowPorts<
    ProvisioningRun,
    MixedSecondaryRuntimeLaneState
  >({
    createProvisioningRun: (input) =>
      createDeterministicCreateProvisioningRun({
        ...input,
        createInitialMemberSpawnStatusEntry,
      }),
    createInitialMemberSpawnStatusEntry,
    resetTeamScopedTransientStateForNewRun: (teamName) =>
      service.resetTeamScopedTransientStateForNewRun(teamName),
    registerRun: (runId, run) => {
      service.runs.set(runId, run);
    },
    setProvisioningRunByTeam: (teamName, runId) => {
      service.provisioningRunByTeam.set(teamName, runId);
    },
    prepareWorkspaceTrustForDeterministicRun: (input) =>
      service.workspaceTrustPreSpawnBoundary.prepareWorkspaceTrustForDeterministicRun(input),
    clearPersistedLaunchState: (teamName, options) =>
      service.clearPersistedLaunchState(teamName, options),
    runDeterministicCreateSpawnFlow,
  });
}
