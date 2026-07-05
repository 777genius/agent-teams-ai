import {
  emitProvisioningCheckpoint,
  initializeProvisioningTrace,
  type TeamProvisioningCheckpointRun,
} from './TeamProvisioningProgressBuffers';

import type { DeterministicCreateSetupFlowResult } from './TeamProvisioningCreateDeterministicSetupFlow';
import type {
  DeterministicCreateSpawnFlowPorts,
  DeterministicCreateSpawnFlowRun,
  RunDeterministicCreateSpawnFlowInput,
} from './TeamProvisioningCreateDeterministicSpawnFlow';
import type { RuntimeLaunchLogger } from './TeamProvisioningRuntimeDiagnostics';
import type {
  WorkspaceTrustFeatureFlags,
  WorkspaceTrustFullPlanResult,
} from '@features/workspace-trust/main';
import type {
  MemberSpawnStatusEntry,
  TeamCreateRequest,
  TeamCreateResponse,
  TeamProvisioningProgress,
} from '@shared/types';

export interface DeterministicCreateRunFlowRun
  extends DeterministicCreateSpawnFlowRun, TeamProvisioningCheckpointRun {
  launchStateClearedForRun: boolean;
}

export interface DeterministicCreateProvisioningRunFactoryInput<TMixedSecondaryLane> {
  runId: string;
  teamName: string;
  request: TeamCreateRequest;
  startedAt: string;
  onProgress: (progress: TeamProvisioningProgress) => void;
  teamsBasePathsToProbe: DeterministicCreateSetupFlowResult<TMixedSecondaryLane>['teamsBasePathsToProbe'];
  effectiveMemberSpecs: TeamCreateRequest['members'];
  allEffectiveMemberSpecs: TeamCreateRequest['members'];
  launchIdentity: DeterministicCreateSetupFlowResult<TMixedSecondaryLane>['launchIdentity'];
  mixedSecondaryLanes: TMixedSecondaryLane[];
  workspaceTrustFullPlan: WorkspaceTrustFullPlanResult | null;
  largeTeamWarning: string | null;
  anthropicApiKeyHelper: NonNullable<
    DeterministicCreateSetupFlowResult<TMixedSecondaryLane>['provisioningEnv']['anthropicApiKeyHelper']
  > | null;
  createInitialMemberSpawnStatusEntry(): MemberSpawnStatusEntry;
}

export interface DeterministicCreateWorkspaceTrustPreparationInput<
  TRun extends DeterministicCreateRunFlowRun,
> {
  mode: 'create';
  run: TRun;
  claudePath: string;
  shellEnv: NodeJS.ProcessEnv;
  stopAllGenerationAtStart: number;
  workspaceTrustPlan: WorkspaceTrustFullPlanResult | null;
  featureFlags: WorkspaceTrustFeatureFlags;
  provisioningEnv: DeterministicCreateSetupFlowResult<unknown>['provisioningEnv'];
}

export interface DeterministicCreateRunFlowPorts<
  TRun extends DeterministicCreateRunFlowRun,
  TMixedSecondaryLane,
> {
  createProvisioningRun(
    input: DeterministicCreateProvisioningRunFactoryInput<TMixedSecondaryLane>
  ): TRun;
  createInitialMemberSpawnStatusEntry(): MemberSpawnStatusEntry;
  resetTeamScopedTransientStateForNewRun(teamName: string): void;
  registerRun(runId: string, run: TRun): void;
  setProvisioningRunByTeam(teamName: string, runId: string): void;
  initializeProvisioningTrace(run: TRun): void;
  prepareWorkspaceTrustForDeterministicRun(
    input: DeterministicCreateWorkspaceTrustPreparationInput<TRun>
  ): Promise<void>;
  emitProvisioningCheckpoint(run: TRun, message: string, detail?: string): void;
  clearPersistedLaunchState(teamName: string, options: { expectedRunId: string }): Promise<void>;
  runDeterministicCreateSpawnFlow(
    input: RunDeterministicCreateSpawnFlowInput<TRun>
  ): Promise<TeamCreateResponse>;
}

export interface RunDeterministicCreateRunFlowInput<
  TRun extends DeterministicCreateRunFlowRun,
  TMixedSecondaryLane,
> {
  request: TeamCreateRequest;
  onProgress: (progress: TeamProvisioningProgress) => void;
  createSetup: DeterministicCreateSetupFlowResult<TMixedSecondaryLane>;
  runId: string;
  startedAt: string;
  stopAllGenerationAtStart: number;
  disallowedTools: string;
  logger: RuntimeLaunchLogger;
  spawnPorts: DeterministicCreateSpawnFlowPorts<TRun>;
  ports: DeterministicCreateRunFlowPorts<TRun, TMixedSecondaryLane>;
}

export function createDefaultDeterministicCreateRunFlowPorts<
  TRun extends DeterministicCreateRunFlowRun,
  TMixedSecondaryLane,
>(
  ports: Omit<
    DeterministicCreateRunFlowPorts<TRun, TMixedSecondaryLane>,
    'initializeProvisioningTrace' | 'emitProvisioningCheckpoint'
  >
): DeterministicCreateRunFlowPorts<TRun, TMixedSecondaryLane> {
  return {
    ...ports,
    initializeProvisioningTrace,
    emitProvisioningCheckpoint,
  };
}

export async function runDeterministicCreateRunFlow<
  TRun extends DeterministicCreateRunFlowRun,
  TMixedSecondaryLane,
>({
  request,
  onProgress,
  createSetup,
  runId,
  startedAt,
  stopAllGenerationAtStart,
  disallowedTools,
  logger,
  spawnPorts,
  ports,
}: RunDeterministicCreateRunFlowInput<TRun, TMixedSecondaryLane>): Promise<TeamCreateResponse> {
  const {
    teamsBasePathsToProbe,
    claudePath,
    provisioningEnv,
    shellEnv,
    geminiRuntimeAuth,
    resolvedProviderId,
    providerArgsForLaunch,
    inheritedProviderArgsForLaunch,
    effectiveMemberSpecs,
    allEffectiveMemberSpecs,
    launchIdentity,
    mixedSecondaryLanes,
    workspaceTrustFeatureFlags,
    workspaceTrustFullPlan,
    largeTeamWarning,
  } = createSetup;
  const run = ports.createProvisioningRun({
    runId,
    teamName: request.teamName,
    request,
    startedAt,
    teamsBasePathsToProbe,
    onProgress,
    effectiveMemberSpecs,
    allEffectiveMemberSpecs,
    launchIdentity,
    mixedSecondaryLanes,
    workspaceTrustFullPlan,
    largeTeamWarning,
    anthropicApiKeyHelper: provisioningEnv.anthropicApiKeyHelper ?? null,
    createInitialMemberSpawnStatusEntry: ports.createInitialMemberSpawnStatusEntry,
  });

  ports.resetTeamScopedTransientStateForNewRun(request.teamName);
  ports.registerRun(runId, run);
  ports.setProvisioningRunByTeam(request.teamName, runId);
  ports.initializeProvisioningTrace(run);
  run.onProgress(run.progress);
  await ports.prepareWorkspaceTrustForDeterministicRun({
    mode: 'create',
    run,
    claudePath,
    shellEnv,
    stopAllGenerationAtStart,
    workspaceTrustPlan: workspaceTrustFullPlan,
    featureFlags: workspaceTrustFeatureFlags,
    provisioningEnv,
  });
  ports.emitProvisioningCheckpoint(run, 'Clearing persisted launch state');
  await ports.clearPersistedLaunchState(request.teamName, { expectedRunId: run.runId });
  run.launchStateClearedForRun = true;

  return await ports.runDeterministicCreateSpawnFlow({
    request,
    run,
    runId,
    effectiveMemberSpecs,
    allEffectiveMemberSpecs,
    launchIdentity,
    provisioningEnv,
    claudePath,
    shellEnv,
    resolvedProviderId,
    providerArgsForLaunch,
    inheritedProviderArgsForLaunch,
    geminiRuntimeAuth,
    stopAllGenerationAtStart,
    disallowedTools,
    logger,
    ports: spawnPorts,
  });
}
