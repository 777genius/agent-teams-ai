import {
  type WorkspaceTrustArgsOnlyPlanRequest,
  type WorkspaceTrustArgsOnlyPlanResult,
  type WorkspaceTrustCoordinator,
  type WorkspaceTrustFullPlanRequest,
  type WorkspaceTrustFullPlanResult,
  type WorkspaceTrustProvider,
  type WorkspaceTrustWorkspace,
} from '@features/workspace-trust/main';

import {
  collectWorkspaceTrustProviders as collectWorkspaceTrustProvidersHelper,
  collectWorkspaceTrustWorkspaces as collectWorkspaceTrustWorkspacesHelper,
  planWorkspaceTrustArgsOnlySafely as planWorkspaceTrustArgsOnlySafelyHelper,
  planWorkspaceTrustFullSafely as planWorkspaceTrustFullSafelyHelper,
  prepareWorkspaceTrustForDeterministicRun as prepareWorkspaceTrustForDeterministicRunHelper,
  type PrepareWorkspaceTrustForDeterministicRunInput,
  type WorkspaceTrustPlanningLogger,
  type WorkspaceTrustProvisioningRun,
  type WorkspaceTrustWorkspaceCollectionPorts,
} from './TeamProvisioningWorkspaceTrust';
import { createNodeWorkspaceTrustWorkspaceCollectionPorts } from './TeamProvisioningWorkspaceTrustNodePorts';

import type {
  TeamCreateRequest,
  TeamLaunchDiagnosticItem,
  TeamProviderId,
  TeamProvisioningProgress,
  TeamProvisioningState,
} from '@shared/types';

export interface WorkspaceTrustDeterministicPreSpawnRun extends WorkspaceTrustProvisioningRun {
  teamName: string;
}

export interface WorkspaceTrustPreSpawnProvisioningEnv {
  anthropicApiKeyHelper?: { directory: string } | null;
}

export interface TeamProvisioningWorkspaceTrustPreSpawnBoundaryDeps<
  TRun extends WorkspaceTrustDeterministicPreSpawnRun,
  TProvisioningEnv extends WorkspaceTrustPreSpawnProvisioningEnv,
> {
  getWorkspaceTrustCoordinator(): WorkspaceTrustCoordinator | null;
  getStopAllTeamsGeneration(): number;
  workspaceTrustWorkspaceCollectionPorts?: WorkspaceTrustWorkspaceCollectionPorts;
  updateProgress(
    run: TRun,
    state: Exclude<TeamProvisioningState, 'idle'>,
    message: string,
    extras?: Pick<
      TeamProvisioningProgress,
      'error' | 'warnings' | 'cliLogsTail' | 'configReady' | 'messageSeverity' | 'launchDiagnostics'
    >
  ): TeamProvisioningProgress;
  boundLaunchDiagnostics(
    diagnostics?: TeamLaunchDiagnosticItem[]
  ): TeamLaunchDiagnosticItem[] | undefined;
  isLaunchRunStillCurrent(run: TRun): boolean;
  isRunStillTracked(run: TRun): boolean;
  cleanupAnthropicApiKeyHelperMaterial(input: { directory: string }): Promise<unknown>;
  restorePrelaunchConfig(teamName: string): Promise<unknown>;
  cleanupRun(run: TRun): void;
  logger?: WorkspaceTrustPlanningLogger;
}

export interface TeamProvisioningWorkspaceTrustPreSpawnBoundary<
  TRun extends WorkspaceTrustDeterministicPreSpawnRun,
  TProvisioningEnv extends WorkspaceTrustPreSpawnProvisioningEnv,
> {
  readonly workspaceTrustWorkspaceCollectionPorts: WorkspaceTrustWorkspaceCollectionPorts;
  getWorkspaceTrustCoordinator(): WorkspaceTrustCoordinator | null;
  collectWorkspaceTrustProviders(input: {
    leadProviderId?: TeamProviderId;
    members: TeamCreateRequest['members'];
  }): WorkspaceTrustProvider[];
  collectWorkspaceTrustWorkspaces(input: {
    cwd: string;
    members: TeamCreateRequest['members'];
  }): Promise<WorkspaceTrustWorkspace[]>;
  planWorkspaceTrustArgsOnlySafely(
    request: WorkspaceTrustArgsOnlyPlanRequest
  ): Promise<WorkspaceTrustArgsOnlyPlanResult>;
  planWorkspaceTrustFullSafely(
    request: WorkspaceTrustFullPlanRequest
  ): Promise<WorkspaceTrustFullPlanResult | null>;
  prepareWorkspaceTrustForDeterministicRun(
    input: PrepareWorkspaceTrustForDeterministicRunInput<TRun, TProvisioningEnv>
  ): Promise<void>;
}

export function createTeamProvisioningWorkspaceTrustPreSpawnBoundary<
  TRun extends WorkspaceTrustDeterministicPreSpawnRun,
  TProvisioningEnv extends WorkspaceTrustPreSpawnProvisioningEnv,
>(
  deps: TeamProvisioningWorkspaceTrustPreSpawnBoundaryDeps<TRun, TProvisioningEnv>
): TeamProvisioningWorkspaceTrustPreSpawnBoundary<TRun, TProvisioningEnv> {
  const workspaceTrustWorkspaceCollectionPorts =
    deps.workspaceTrustWorkspaceCollectionPorts ??
    createNodeWorkspaceTrustWorkspaceCollectionPorts();

  return {
    workspaceTrustWorkspaceCollectionPorts,
    getWorkspaceTrustCoordinator: () => deps.getWorkspaceTrustCoordinator(),
    collectWorkspaceTrustProviders: collectWorkspaceTrustProvidersHelper,
    collectWorkspaceTrustWorkspaces: (input) =>
      collectWorkspaceTrustWorkspacesHelper({
        ...input,
        ports: workspaceTrustWorkspaceCollectionPorts,
      }),
    planWorkspaceTrustArgsOnlySafely: (request) =>
      planWorkspaceTrustArgsOnlySafelyHelper({
        coordinator: deps.getWorkspaceTrustCoordinator(),
        request,
        logger: deps.logger,
      }),
    planWorkspaceTrustFullSafely: (request) =>
      planWorkspaceTrustFullSafelyHelper({
        coordinator: deps.getWorkspaceTrustCoordinator(),
        request,
        logger: deps.logger,
      }),
    prepareWorkspaceTrustForDeterministicRun: (input) =>
      prepareWorkspaceTrustForDeterministicRunHelper(input, {
        workspaceTrustCoordinator: deps.getWorkspaceTrustCoordinator(),
        stopAllTeamsGeneration: deps.getStopAllTeamsGeneration(),
        updateProgress: deps.updateProgress,
        boundLaunchDiagnostics: deps.boundLaunchDiagnostics,
        isLaunchRunStillCurrent: deps.isLaunchRunStillCurrent,
        isRunStillTracked: deps.isRunStillTracked,
        cancelDeterministicRunBeforeSpawn: (run, cancelInput) =>
          cancelDeterministicRunBeforeSpawn(run, cancelInput, deps),
        failDeterministicRunBeforeSpawn: (run, failInput) =>
          failDeterministicRunBeforeSpawn(run, failInput, deps),
      }),
  };
}

async function failDeterministicRunBeforeSpawn<
  TRun extends WorkspaceTrustDeterministicPreSpawnRun,
  TProvisioningEnv extends WorkspaceTrustPreSpawnProvisioningEnv,
>(
  run: TRun,
  input: {
    mode: 'create' | 'launch';
    message: string;
    error: string;
    launchDiagnostics?: TeamLaunchDiagnosticItem[];
    provisioningEnv: TProvisioningEnv;
  },
  ports: TeamProvisioningWorkspaceTrustPreSpawnBoundaryDeps<TRun, TProvisioningEnv>
): Promise<never> {
  ports.updateProgress(run, 'failed', input.message, {
    error: input.error,
    warnings: run.progress.warnings,
    launchDiagnostics: input.launchDiagnostics,
  });
  run.onProgress(run.progress);

  await cleanupAnthropicHelperMaterial(input.provisioningEnv, ports);
  if (input.mode === 'launch') {
    await ports.restorePrelaunchConfig(run.teamName).catch(() => undefined);
  }
  ports.cleanupRun(run);
  throw new Error(input.error);
}

async function cancelDeterministicRunBeforeSpawn<
  TRun extends WorkspaceTrustDeterministicPreSpawnRun,
  TProvisioningEnv extends WorkspaceTrustPreSpawnProvisioningEnv,
>(
  run: TRun,
  input: {
    mode: 'create' | 'launch';
    provisioningEnv: TProvisioningEnv;
  },
  ports: TeamProvisioningWorkspaceTrustPreSpawnBoundaryDeps<TRun, TProvisioningEnv>
): Promise<never> {
  ports.updateProgress(run, 'cancelled', 'Team launch cancelled', {
    warnings: run.progress.warnings,
  });
  run.cancelRequested = true;
  run.onProgress(run.progress);

  await cleanupAnthropicHelperMaterial(input.provisioningEnv, ports);
  if (input.mode === 'launch') {
    await ports.restorePrelaunchConfig(run.teamName).catch(() => undefined);
  }
  ports.cleanupRun(run);
  throw new Error('Team launch cancelled by app shutdown');
}

async function cleanupAnthropicHelperMaterial<
  TRun extends WorkspaceTrustDeterministicPreSpawnRun,
  TProvisioningEnv extends WorkspaceTrustPreSpawnProvisioningEnv,
>(
  provisioningEnv: TProvisioningEnv,
  ports: TeamProvisioningWorkspaceTrustPreSpawnBoundaryDeps<TRun, TProvisioningEnv>
): Promise<void> {
  if (!provisioningEnv.anthropicApiKeyHelper) {
    return;
  }
  await ports
    .cleanupAnthropicApiKeyHelperMaterial({
      directory: provisioningEnv.anthropicApiKeyHelper.directory,
    })
    .catch(() => undefined);
}
