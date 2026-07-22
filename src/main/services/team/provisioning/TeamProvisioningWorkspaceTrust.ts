import {
  applyWorkspaceTrustLaunchArgPatches,
  budgetWorkspaceTrustDiagnosticsManifest,
  buildWorkspaceTrustPathCandidates,
  buildWorkspaceTrustPreflightEnv,
  type WorkspaceTrustArgsOnlyPlanRequest,
  type WorkspaceTrustArgsOnlyPlanResult,
  type WorkspaceTrustCoordinator,
  type WorkspaceTrustExecutionResult,
  type WorkspaceTrustFeatureFlags,
  type WorkspaceTrustFullPlanRequest,
  type WorkspaceTrustFullPlanResult,
  type WorkspaceTrustLaunchArgPatch,
  type WorkspaceTrustLaunchArgTargetSurface,
  type WorkspaceTrustProvider,
  type WorkspaceTrustWorkspace,
} from '@features/workspace-trust/main';
import { createLogger } from '@shared/utils/logger';

import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';

import { mergeProvisioningWarnings } from './TeamProvisioningLaunchCompatibility';
import {
  buildWorkspaceTrustPreflightLaunchDiagnostic,
  mergeLaunchDiagnosticItem,
} from './TeamProvisioningLaunchDiagnostics';
import { normalizeTeamMemberProviderId } from './TeamProvisioningMemberSpecs';

import type {
  TeamCreateRequest,
  TeamLaunchDiagnosticItem,
  TeamProviderId,
  TeamProvisioningProgress,
  TeamProvisioningState,
} from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');

export interface WorkspaceTrustPlanningLogger {
  warn(message: string): void;
}

export interface WorkspaceTrustGitRootResolutionPorts {
  resolveGitTopLevel(cwd: string): Promise<string | null>;
  resolveFilesystemGitRoot(cwd: string): Promise<string | null>;
  isAbsolutePath(value: string): boolean;
}

export interface WorkspaceTrustWorkspaceCollectionPorts {
  getHomeDir(): string;
  realpath(value: string): Promise<string | null>;
  resolveGitRoot(cwd: string): Promise<string | null>;
  resolveCanonicalGitRoot(gitRoot: string): Promise<string>;
  platform: 'posix' | 'win32';
}

export type WorkspaceTrustProviderArgsResolver = (input: {
  providerId: TeamProviderId;
  providerArgs: string[];
  phase: 'default-model-resolution';
}) => string[];

export interface WorkspaceTrustProvisioningRun {
  runId: string;
  cancelRequested: boolean;
  processKilled: boolean;
  progress: TeamProvisioningProgress;
  onProgress: (progress: TeamProvisioningProgress) => void;
  workspaceTrustPlan?: WorkspaceTrustFullPlanResult | null;
  workspaceTrustExecution?: WorkspaceTrustExecutionResult | null;
  workspaceTrustDiagnostics?: unknown;
}

export interface PrepareWorkspaceTrustForDeterministicRunInput<
  TRun extends WorkspaceTrustProvisioningRun,
  TProvisioningEnv,
> {
  mode: 'create' | 'launch';
  run: TRun;
  claudePath: string;
  shellEnv: NodeJS.ProcessEnv;
  stopAllGenerationAtStart: number;
  workspaceTrustPlan: WorkspaceTrustFullPlanResult | null;
  featureFlags: WorkspaceTrustFeatureFlags;
  provisioningEnv: TProvisioningEnv;
}

export interface PrepareWorkspaceTrustForDeterministicRunPorts<
  TRun extends WorkspaceTrustProvisioningRun,
  TProvisioningEnv,
> {
  workspaceTrustCoordinator: WorkspaceTrustCoordinator | null;
  stopAllTeamsGeneration: number;
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
  cancelDeterministicRunBeforeSpawn(
    run: TRun,
    input: { mode: 'create' | 'launch'; provisioningEnv: TProvisioningEnv }
  ): Promise<unknown>;
  failDeterministicRunBeforeSpawn(
    run: TRun,
    input: {
      mode: 'create' | 'launch';
      message: string;
      error: string;
      launchDiagnostics?: TeamLaunchDiagnosticItem[];
      provisioningEnv: TProvisioningEnv;
    }
  ): Promise<never>;
}

export function toWorkspaceTrustProvider(providerId: TeamProviderId): WorkspaceTrustProvider {
  return providerId === 'anthropic' ? 'claude' : providerId;
}

export function collectWorkspaceTrustProviders(input: {
  leadProviderId?: TeamProviderId;
  members: TeamCreateRequest['members'];
}): WorkspaceTrustProvider[] {
  const providers = new Set<WorkspaceTrustProvider>();
  providers.add(toWorkspaceTrustProvider(resolveTeamProviderId(input.leadProviderId)));
  for (const member of input.members) {
    const providerId =
      normalizeTeamMemberProviderId(member.providerId) ??
      normalizeTeamMemberProviderId((member as { provider?: unknown }).provider);
    if (providerId) {
      providers.add(toWorkspaceTrustProvider(providerId));
    }
  }
  if (providers.size === 0) {
    providers.add('claude');
  }
  const providerOrder: WorkspaceTrustProvider[] = ['claude', 'codex', 'gemini', 'opencode'];
  return providerOrder.filter((provider) => providers.has(provider));
}

export async function resolveWorkspaceTrustGitRoot(
  cwd: string,
  ports: WorkspaceTrustGitRootResolutionPorts
): Promise<string | null> {
  const normalizedCwd = cwd.trim();
  if (!normalizedCwd) {
    return null;
  }
  const gitRoot = (await ports.resolveGitTopLevel(normalizedCwd))?.trim() ?? null;
  return gitRoot && ports.isAbsolutePath(gitRoot)
    ? gitRoot
    : ports.resolveFilesystemGitRoot(normalizedCwd);
}

export async function collectWorkspaceTrustWorkspaces(input: {
  cwd: string;
  members: TeamCreateRequest['members'];
  ports: WorkspaceTrustWorkspaceCollectionPorts;
}): Promise<WorkspaceTrustWorkspace[]> {
  const homeDir = input.ports.getHomeDir();
  const candidates: WorkspaceTrustWorkspace[] = [];
  const gitRootCache = new Map<string, string | null>();
  const addPath = async (
    cwd: string,
    source: WorkspaceTrustWorkspace['source'],
    memberId?: string
  ): Promise<void> => {
    const realCwd = await input.ports.realpath(cwd);
    let gitRoot = gitRootCache.get(cwd);
    if (gitRoot === undefined) {
      const resolvedGitRoot = await input.ports.resolveGitRoot(cwd);
      const realGitRoot = resolvedGitRoot ? await input.ports.realpath(resolvedGitRoot) : null;
      gitRoot = realGitRoot
        ? await input.ports.resolveCanonicalGitRoot(realGitRoot)
        : resolvedGitRoot;
      gitRootCache.set(cwd, gitRoot);
    }
    candidates.push(
      ...buildWorkspaceTrustPathCandidates({
        cwd,
        realCwd,
        gitRoot,
        homeDir,
        source,
        memberId,
        platform: input.ports.platform,
      })
    );
  };

  await addPath(input.cwd, 'team-root');
  for (const member of input.members) {
    const memberCwd = member.cwd?.trim();
    if (!memberCwd) {
      continue;
    }
    await addPath(
      memberCwd,
      member.isolation === 'worktree' ? 'member-worktree' : 'member-cwd',
      member.name
    );
  }
  const seen = new Set<string>();
  return candidates.filter((workspace) => {
    if (seen.has(workspace.comparisonKey)) {
      return false;
    }
    seen.add(workspace.comparisonKey);
    return true;
  });
}

export function applyWorkspaceTrustArgPatches(input: {
  args: string[];
  patches: WorkspaceTrustLaunchArgPatch[];
  targetProvider: TeamProviderId;
  targetSurface: WorkspaceTrustLaunchArgTargetSurface;
}): string[] {
  if (input.patches.length === 0) {
    return input.args;
  }
  return applyWorkspaceTrustLaunchArgPatches({
    args: input.args,
    patches: input.patches,
    targetProvider: toWorkspaceTrustProvider(input.targetProvider),
    targetSurface: input.targetSurface,
  }).args;
}

export function createDefaultModelWorkspaceTrustProviderArgsResolver(
  plan: Pick<WorkspaceTrustArgsOnlyPlanResult, 'launchArgPatches'>
): WorkspaceTrustProviderArgsResolver {
  return (input) =>
    applyWorkspaceTrustArgPatches({
      args: input.providerArgs,
      patches: plan.launchArgPatches,
      targetProvider: input.providerId,
      targetSurface: 'default_model_probe',
    });
}

export async function planWorkspaceTrustArgsOnlySafely(input: {
  coordinator: WorkspaceTrustCoordinator | null;
  request: WorkspaceTrustArgsOnlyPlanRequest;
  logger?: WorkspaceTrustPlanningLogger;
}): Promise<WorkspaceTrustArgsOnlyPlanResult> {
  if (!input.coordinator) {
    return { launchArgPatches: [] };
  }
  try {
    return await input.coordinator.planArgsOnly(input.request);
  } catch (error) {
    (input.logger ?? logger).warn(
      `Workspace trust args-only planning failed; continuing without trust arg patches: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return { launchArgPatches: [] };
  }
}

export async function planWorkspaceTrustFullSafely(input: {
  coordinator: WorkspaceTrustCoordinator | null;
  request: WorkspaceTrustFullPlanRequest;
  logger?: WorkspaceTrustPlanningLogger;
}): Promise<WorkspaceTrustFullPlanResult | null> {
  if (!input.coordinator) {
    return null;
  }
  try {
    return await input.coordinator.planFull(input.request);
  } catch (error) {
    (input.logger ?? logger).warn(
      `Workspace trust full planning failed; continuing without trust arg patches: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return {
      providers: input.request.providers,
      workspaces: input.request.workspaces,
      launchArgPatches: [],
    };
  }
}

export async function prepareWorkspaceTrustForDeterministicRun<
  TRun extends WorkspaceTrustProvisioningRun,
  TProvisioningEnv,
>(
  input: PrepareWorkspaceTrustForDeterministicRunInput<TRun, TProvisioningEnv>,
  ports: PrepareWorkspaceTrustForDeterministicRunPorts<TRun, TProvisioningEnv>
): Promise<void> {
  if (
    !ports.workspaceTrustCoordinator ||
    !input.workspaceTrustPlan ||
    !input.featureFlags.enabled
  ) {
    return;
  }

  input.run.workspaceTrustPlan = input.workspaceTrustPlan;
  ports.updateProgress(input.run, 'spawning', 'Preparing workspace trust', {
    warnings: input.run.progress.warnings,
  });
  input.run.onProgress(input.run.progress);

  let execution: WorkspaceTrustExecutionResult;
  try {
    execution = await ports.workspaceTrustCoordinator.execute({
      providers: input.workspaceTrustPlan.providers,
      claudePath: input.claudePath,
      workspaces: input.workspaceTrustPlan.workspaces,
      env: buildWorkspaceTrustPreflightEnv(input.shellEnv),
      featureFlags: input.featureFlags,
      isCancelled: () =>
        input.run.cancelRequested ||
        input.run.processKilled ||
        ports.stopAllTeamsGeneration !== input.stopAllGenerationAtStart,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    execution = {
      id: 'workspace-trust-coordinator',
      provider: 'claude',
      status: 'soft_failed',
      workspaceIds: input.workspaceTrustPlan.workspaces.map((workspace) => workspace.id),
      errorCode: 'workspace_trust_preflight_error',
      errorMessage: message,
      evidence: [message],
    };
  }
  input.run.workspaceTrustExecution = execution;
  input.run.workspaceTrustDiagnostics = budgetWorkspaceTrustDiagnosticsManifest({
    attempt: 1,
    featureFlags: input.featureFlags,
    strategyResults: [execution],
  });
  const workspaceTrustLaunchDiagnostic = buildWorkspaceTrustPreflightLaunchDiagnostic(execution);
  const workspaceTrustLaunchDiagnostics = workspaceTrustLaunchDiagnostic
    ? ports.boundLaunchDiagnostics(
        mergeLaunchDiagnosticItem(
          input.run.progress.launchDiagnostics,
          workspaceTrustLaunchDiagnostic
        )
      )
    : input.run.progress.launchDiagnostics;

  if (!ports.isLaunchRunStillCurrent(input.run)) {
    if (ports.isRunStillTracked(input.run)) {
      await ports.cancelDeterministicRunBeforeSpawn(input.run, {
        mode: input.mode,
        provisioningEnv: input.provisioningEnv,
      });
    }
    throw new Error('Team launch cancelled by app shutdown');
  }

  if (execution.status === 'cancelled') {
    await ports.cancelDeterministicRunBeforeSpawn(input.run, {
      mode: input.mode,
      provisioningEnv: input.provisioningEnv,
    });
  }

  if (execution.status === 'blocked') {
    await ports.failDeterministicRunBeforeSpawn(input.run, {
      mode: input.mode,
      message: 'Workspace trust required',
      error:
        execution.errorMessage ||
        execution.errorCode ||
        'Workspace trust preflight blocked this launch.',
      launchDiagnostics: workspaceTrustLaunchDiagnostics,
      provisioningEnv: input.provisioningEnv,
    });
  }

  if (execution.status === 'soft_failed') {
    const warning =
      execution.errorMessage ||
      execution.errorCode ||
      'Workspace trust preflight could not verify trust before launch.';
    input.run.progress = {
      ...input.run.progress,
      warnings: mergeProvisioningWarnings(input.run.progress.warnings, warning),
      launchDiagnostics: workspaceTrustLaunchDiagnostics,
    };
    input.run.onProgress(input.run.progress);
  } else if (workspaceTrustLaunchDiagnostics) {
    input.run.progress = {
      ...input.run.progress,
      updatedAt: new Date().toISOString(),
      launchDiagnostics: workspaceTrustLaunchDiagnostics,
    };
    input.run.onProgress(input.run.progress);
  }
}
