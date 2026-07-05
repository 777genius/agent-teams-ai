import { type DeterministicLaunchSetupResult } from './TeamProvisioningLaunchDeterministicSetupFlow';
import {
  type DeterministicLaunchSpawnFlowRun,
  runDeterministicLaunchSpawnFlow,
  type RunDeterministicLaunchSpawnFlowPorts,
} from './TeamProvisioningLaunchDeterministicSpawnFlow';
import {
  createDeterministicLaunchProvisioningRun,
  type DeterministicLaunchStatePreparationRun,
  prepareDeterministicLaunchRunState,
} from './TeamProvisioningLaunchTeamFlow';

import type {
  MemberSpawnStatusEntry,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamProvisioningProgress,
} from '@shared/types';

export type PreparedDeterministicLaunchSetup<TMixedSecondaryLane> = Extract<
  DeterministicLaunchSetupResult<TMixedSecondaryLane>,
  { kind: 'prepared' }
>;

export interface DeterministicLaunchRunFlowRun<TMixedSecondaryLane>
  extends DeterministicLaunchSpawnFlowRun, DeterministicLaunchStatePreparationRun {
  mixedSecondaryLanes: TMixedSecondaryLane[];
}

export interface RunDeterministicLaunchRunFlowInput<TMixedSecondaryLane> {
  request: TeamLaunchRequest;
  setup: PreparedDeterministicLaunchSetup<TMixedSecondaryLane>;
  stopAllGenerationAtStart: number;
  onProgress(progress: TeamProvisioningProgress): void;
  teammateRuntimeDisallowedTools: string;
}

export interface RunDeterministicLaunchRunFlowPorts<
  TMixedSecondaryLane,
> extends RunDeterministicLaunchSpawnFlowPorts<DeterministicLaunchRunFlowRun<TMixedSecondaryLane>> {
  createInitialMemberSpawnStatusEntry(): MemberSpawnStatusEntry;
  prepareWorkspaceTrustForDeterministicRun(input: {
    mode: 'launch';
    run: DeterministicLaunchRunFlowRun<TMixedSecondaryLane>;
    claudePath: string;
    shellEnv: NodeJS.ProcessEnv;
    stopAllGenerationAtStart: number;
    workspaceTrustPlan: PreparedDeterministicLaunchSetup<TMixedSecondaryLane>['workspaceTrustFullPlan'];
    featureFlags: PreparedDeterministicLaunchSetup<TMixedSecondaryLane>['workspaceTrustFeatureFlags'];
    provisioningEnv: PreparedDeterministicLaunchSetup<TMixedSecondaryLane>['provisioningEnv'];
  }): Promise<void>;
  resetTeamScopedTransientStateForNewRun(teamName: string): void;
  registerRun(runId: string, run: DeterministicLaunchRunFlowRun<TMixedSecondaryLane>): void;
  setProvisioningRunByTeam(teamName: string, runId: string): void;
  clearPersistedLaunchState(teamName: string, options: { expectedRunId: string }): Promise<void>;
  publishMixedSecondaryLaneStatusChange(
    run: DeterministicLaunchRunFlowRun<TMixedSecondaryLane>,
    lane: TMixedSecondaryLane
  ): Promise<void>;
}

export async function runDeterministicLaunchRunFlow<TMixedSecondaryLane>(
  input: RunDeterministicLaunchRunFlowInput<TMixedSecondaryLane>,
  ports: RunDeterministicLaunchRunFlowPorts<TMixedSecondaryLane>
): Promise<TeamLaunchResponse> {
  const { request, setup, stopAllGenerationAtStart } = input;
  const {
    teamsBasePathsToProbe,
    runId,
    startedAt,
    claudePath,
    shellEnv,
    provisioningEnv,
    workspaceTrustFeatureFlags,
    workspaceTrustFullPlan,
    resolvedProviderId,
    providerArgsForLaunch,
    crossProviderMemberArgsForLaunch,
    expectedMembers,
    effectiveMemberSpecs,
    allEffectiveMemberSpecs,
    launchIdentity,
    syntheticRequest,
    mixedSecondaryLanes,
    initialLaunchWarnings,
    initialLaunchWarningSource,
  } = setup;

  const run = createDeterministicLaunchProvisioningRun({
    runId,
    teamName: request.teamName,
    startedAt,
    onProgress: input.onProgress,
    teamsBasePathsToProbe,
    syntheticRequest,
    expectedMembers,
    effectiveMemberSpecs,
    allEffectiveMemberSpecs,
    launchIdentity,
    mixedSecondaryLanes,
    workspaceTrustFullPlan,
    anthropicApiKeyHelper: provisioningEnv.anthropicApiKeyHelper ?? null,
    initialLaunchWarnings,
    initialLaunchWarningSource,
    createInitialMemberSpawnStatusEntry: ports.createInitialMemberSpawnStatusEntry,
  }) as DeterministicLaunchRunFlowRun<TMixedSecondaryLane>;

  await prepareDeterministicLaunchRunState({
    teamName: request.teamName,
    run,
    prepareWorkspaceTrustForDeterministicRun: () =>
      ports.prepareWorkspaceTrustForDeterministicRun({
        mode: 'launch',
        run,
        claudePath,
        shellEnv,
        stopAllGenerationAtStart,
        workspaceTrustPlan: workspaceTrustFullPlan,
        featureFlags: workspaceTrustFeatureFlags,
        provisioningEnv,
      }),
    resetTeamScopedTransientStateForNewRun: ports.resetTeamScopedTransientStateForNewRun,
    registerRun: ports.registerRun,
    setProvisioningRunByTeam: ports.setProvisioningRunByTeam,
    clearPersistedLaunchState: ports.clearPersistedLaunchState,
    publishMixedSecondaryLaneStatusChange: ports.publishMixedSecondaryLaneStatusChange,
  });

  return runDeterministicLaunchSpawnFlow(
    {
      request,
      syntheticRequest,
      run,
      runId,
      claudePath,
      shellEnv,
      provisioningEnv,
      stopAllGenerationAtStart,
      resolvedProviderId,
      providerArgsForLaunch,
      crossProviderMemberArgsForLaunch,
      launchIdentity,
      effectiveMemberSpecs,
      allEffectiveMemberSpecs,
      teammateRuntimeDisallowedTools: input.teammateRuntimeDisallowedTools,
    },
    ports
  );
}
