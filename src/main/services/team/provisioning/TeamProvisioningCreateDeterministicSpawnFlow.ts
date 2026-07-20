import { getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import { parseCliArgs } from '@shared/utils/cliArgsParser';
import { type spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';

import { cleanupAnthropicTeamApiKeyHelperMaterial } from '../../runtime/anthropicTeamApiKeyHelper';
import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';
import {
  applyDesktopTeammateModeDecisionToEnv,
  resolveDesktopTeammateModeDecision,
} from '../runtimeTeammateMode';

import {
  getProvisioningRunTimeoutMs,
  removeDeterministicBootstrapSpecFile,
  removeDeterministicBootstrapUserPromptFile,
  type RuntimeBootstrapMemberMcpLaunchConfig,
} from './TeamProvisioningBootstrapSpec';
import {
  buildDeterministicCreateSpawnArgs,
  materializeDeterministicCreateTeamBootstrapFiles,
  type TeamProvisioningCreateBootstrapRun,
  type TeamProvisioningCreateMcpConfigBuilder,
  type TeamProvisioningCreateMembersMetaStore,
  type TeamProvisioningCreateTeamMetaStore,
} from './TeamProvisioningCreateTeamFlow';
import { applyAppManagedRuntimeSettingsPathEnv } from './TeamProvisioningEnvGuards';
import { mergeProvisioningWarnings } from './TeamProvisioningLaunchCompatibility';
import { emitProvisioningCheckpoint } from './TeamProvisioningProgressBuffers';
import { extractCliLogsFromRun } from './TeamProvisioningRetainedLogs';
import {
  buildRuntimeLaunchWarning,
  getPromptSizeSummary,
  logRuntimeLaunchSnapshot,
  type RuntimeLaunchLogger,
} from './TeamProvisioningRuntimeDiagnostics';
import {
  getLaunchModelArg,
  type TeamRuntimeLaunchArgsPlan,
} from './TeamProvisioningRuntimeLaunchSelection';

import type { GeminiRuntimeAuthState } from '../../runtime/geminiRuntimeAuth';
import type { ProvisioningEnvResolution } from './TeamProvisioningEnvBuilder';
import type { spawnCli } from '@main/utils/childProcess';
import type {
  ProviderModelLaunchIdentity,
  TeamCreateRequest,
  TeamProviderId,
  TeamProvisioningProgress,
  TeamProvisioningState,
} from '@shared/types';

type SpawnedChild = ReturnType<typeof spawn>;

export interface DeterministicCreateSpawnFlowRun extends TeamProvisioningCreateBootstrapRun {
  runId: string;
  teamName: string;
  progress: TeamProvisioningProgress;
  child: SpawnedChild | null;
  processClosed: boolean;
  spawnContext: {
    claudePath: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    prompt: string;
  } | null;
  lastDataReceivedAt: number;
  lastStdoutReceivedAt: number;
  timeoutHandle: NodeJS.Timeout | null;
  processKilled: boolean;
  provisioningComplete: boolean;
  finalizingByTimeout: boolean;
  cancelRequested: boolean;
  bootstrapSpecPath: string | null;
  bootstrapUserPromptPath: string | null;
  mcpConfigPath: string | null;
  requiresFirstRealTurnSuccess: boolean;
  deterministicBootstrap: boolean;
  effectiveMembers: TeamCreateRequest['members'];
  onProgress(progress: TeamProvisioningProgress): void;
}

export interface DeterministicCreateCleanupTargets {
  teamName: string;
  teamDir: string;
  tasksDir: string;
  bootstrapSpecPath: string | null;
  bootstrapUserPromptPath: string | null;
  mcpConfigPath: string | null;
  anthropicApiKeyHelperDirectory: string | null;
}

export interface DeterministicCreateSpawnFlowPorts<TRun extends DeterministicCreateSpawnFlowRun> {
  teamMetaStore: TeamProvisioningCreateTeamMetaStore & {
    deleteMeta(teamName: string): Promise<void>;
  };
  membersMetaStore: TeamProvisioningCreateMembersMetaStore;
  mcpConfigBuilder: TeamProvisioningCreateMcpConfigBuilder & {
    removeConfigFile(configPath: string): Promise<void>;
  };
  buildMemberMcpLaunchConfigs(input: {
    controlApiBaseUrl?: string | null;
    cwd: string;
    members: TeamCreateRequest['members'];
    run: TRun;
  }): Promise<ReadonlyMap<string, RuntimeBootstrapMemberMcpLaunchConfig>>;
  validateAgentTeamsMcpRuntime(
    mcpConfigPath: string,
    options: { isCancelled(): boolean }
  ): Promise<void>;
  buildTeamRuntimeLaunchArgsPlan(input: {
    teamName: string;
    providerId: TeamProviderId;
    launchIdentity?: ProviderModelLaunchIdentity | null;
    envResolution: ProvisioningEnvResolution;
    extraArgs?: string[];
    inheritedProviderArgs?: string[];
    includeAnthropicHelper: boolean;
    contextLabel: string;
  }): Promise<TeamRuntimeLaunchArgsPlan>;
  seedLeadBootstrapPermissionRules(teamName: string, cwd: string): Promise<void>;
  spawnCli: typeof spawnCli;
  updateProgress(
    run: TRun,
    state: Exclude<TeamProvisioningState, 'idle'>,
    message: string,
    extras?: Pick<
      TeamProvisioningProgress,
      | 'pid'
      | 'error'
      | 'warnings'
      | 'cliLogsTail'
      | 'configReady'
      | 'messageSeverity'
      | 'launchDiagnostics'
    >
  ): TeamProvisioningProgress;
  attachStdoutHandler(run: TRun): void;
  attachStderrHandler(run: TRun): void;
  startStallWatchdog(run: TRun): void;
  startFilesystemMonitor(run: TRun, request: TeamCreateRequest): void;
  tryCompleteAfterTimeout(run: TRun): Promise<boolean>;
  handleProcessExit(run: TRun, code: number | null): Promise<void>;
  killTeamProcess(child: SpawnedChild | null | undefined): void;
  cleanupRun(run: TRun): void;
  removeRunMemberMcpConfigFiles(run: TRun): Promise<void>;
  unregisterRun(runId: string, teamName: string): void;
  getStopAllTeamsGeneration(): number;
}

export interface RunDeterministicCreateSpawnFlowInput<
  TRun extends DeterministicCreateSpawnFlowRun,
> {
  request: TeamCreateRequest;
  run: TRun;
  runId: string;
  effectiveMemberSpecs: TeamCreateRequest['members'];
  allEffectiveMemberSpecs: TeamCreateRequest['members'];
  launchIdentity: ProviderModelLaunchIdentity | null;
  provisioningEnv: ProvisioningEnvResolution;
  claudePath: string;
  shellEnv: NodeJS.ProcessEnv;
  resolvedProviderId: TeamProviderId;
  providerArgsForLaunch: string[];
  inheritedProviderArgsForLaunch: string[];
  geminiRuntimeAuth: GeminiRuntimeAuthState | null;
  stopAllGenerationAtStart: number;
  disallowedTools: string;
  logger: RuntimeLaunchLogger;
  ports: DeterministicCreateSpawnFlowPorts<TRun>;
}

export function buildDeterministicCreateCleanupTargets(input: {
  teamName: string;
  bootstrapSpecPath?: string | null;
  bootstrapUserPromptPath?: string | null;
  mcpConfigPath?: string | null;
  anthropicApiKeyHelperDirectory?: string | null;
}): DeterministicCreateCleanupTargets {
  return {
    teamName: input.teamName,
    teamDir: path.join(getTeamsBasePath(), input.teamName),
    tasksDir: path.join(getTasksBasePath(), input.teamName),
    bootstrapSpecPath: input.bootstrapSpecPath ?? null,
    bootstrapUserPromptPath: input.bootstrapUserPromptPath ?? null,
    mcpConfigPath: input.mcpConfigPath ?? null,
    anthropicApiKeyHelperDirectory: input.anthropicApiKeyHelperDirectory ?? null,
  };
}

export function shouldCancelDeterministicCreateSpawn(input: {
  cancelRequested: boolean;
  processKilled: boolean;
  stopAllGenerationAtStart: number;
  currentStopAllTeamsGeneration: number;
}): boolean {
  return (
    input.cancelRequested ||
    input.processKilled ||
    input.currentStopAllTeamsGeneration !== input.stopAllGenerationAtStart
  );
}

async function cleanupDeterministicCreateMaterializationFailure<
  TRun extends DeterministicCreateSpawnFlowRun,
>(
  run: TRun,
  request: TeamCreateRequest,
  provisioningEnv: ProvisioningEnvResolution,
  ports: DeterministicCreateSpawnFlowPorts<TRun>
): Promise<void> {
  ports.unregisterRun(run.runId, request.teamName);
  if (provisioningEnv.anthropicApiKeyHelper) {
    await cleanupAnthropicTeamApiKeyHelperMaterial({
      directory: provisioningEnv.anthropicApiKeyHelper.directory,
    }).catch(() => undefined);
  }
  await cleanupDeterministicCreateMaterializedFiles(run, request, ports);
}

async function cleanupDeterministicCreateSpawnFailure<TRun extends DeterministicCreateSpawnFlowRun>(
  run: TRun,
  request: TeamCreateRequest,
  provisioningEnv: ProvisioningEnvResolution,
  ports: DeterministicCreateSpawnFlowPorts<TRun>
): Promise<void> {
  await cleanupDeterministicCreateMaterializedFiles(run, request, ports);
  if (provisioningEnv.anthropicApiKeyHelper) {
    await cleanupAnthropicTeamApiKeyHelperMaterial({
      directory: provisioningEnv.anthropicApiKeyHelper.directory,
    }).catch(() => undefined);
  }
  ports.unregisterRun(run.runId, request.teamName);
}

async function cleanupDeterministicCreateMaterializedFiles<
  TRun extends DeterministicCreateSpawnFlowRun,
>(
  run: TRun,
  request: TeamCreateRequest,
  ports: DeterministicCreateSpawnFlowPorts<TRun>
): Promise<void> {
  await ports.teamMetaStore.deleteMeta(request.teamName).catch(() => {});
  const targets = buildDeterministicCreateCleanupTargets({
    teamName: request.teamName,
    bootstrapSpecPath: run.bootstrapSpecPath,
    bootstrapUserPromptPath: run.bootstrapUserPromptPath,
    mcpConfigPath: run.mcpConfigPath,
  });
  await fs.promises.rm(targets.teamDir, { recursive: true, force: true }).catch(() => {});
  await fs.promises.rm(targets.tasksDir, { recursive: true, force: true }).catch(() => {});
  await removeDeterministicBootstrapSpecFile(targets.bootstrapSpecPath).catch(() => {});
  run.bootstrapSpecPath = null;
  await removeDeterministicBootstrapUserPromptFile(targets.bootstrapUserPromptPath).catch(() => {});
  run.bootstrapUserPromptPath = null;
  if (targets.mcpConfigPath) {
    await ports.mcpConfigBuilder.removeConfigFile(targets.mcpConfigPath).catch(() => {});
    run.mcpConfigPath = null;
  }
  await ports.removeRunMemberMcpConfigFiles(run).catch(() => {});
}

export async function handleDeterministicCreateSpawnTimeout<
  TRun extends DeterministicCreateSpawnFlowRun,
>(
  run: TRun,
  ports: Pick<
    DeterministicCreateSpawnFlowPorts<TRun>,
    'tryCompleteAfterTimeout' | 'killTeamProcess' | 'updateProgress' | 'cleanupRun'
  >,
  timedOutChild = run.child
): Promise<void> {
  const readyOnTimeout = await ports.tryCompleteAfterTimeout(run).catch(() => false);
  if (readyOnTimeout) {
    return; // cleanupRun already called inside tryCompleteAfterTimeout
  }

  // The readiness probe is asynchronous. A completion/cancellation path or a
  // replacement child may have taken ownership while it was in flight.
  if (
    run.provisioningComplete ||
    run.cancelRequested ||
    run.processKilled ||
    run.child !== timedOutChild
  ) {
    run.finalizingByTimeout = false;
    return;
  }

  run.processKilled = true;
  ports.killTeamProcess(timedOutChild);
  const progress = ports.updateProgress(run, 'failed', 'Timed out waiting for CLI', {
    error:
      'Timed out waiting for CLI. Run `claude` once in terminal to complete onboarding and try again.',
    cliLogsTail: extractCliLogsFromRun(run),
  });
  run.onProgress(progress);
  ports.cleanupRun(run);
}

export async function runDeterministicCreateSpawnFlow<
  TRun extends DeterministicCreateSpawnFlowRun,
>({
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
  ports,
}: RunDeterministicCreateSpawnFlowInput<TRun>): Promise<{ runId: string }> {
  const initialUserPrompt = request.prompt?.trim() ?? '';
  const promptSize = getPromptSizeSummary(initialUserPrompt);
  let child: SpawnedChild;
  shellEnv.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP = '1';
  const teammateModeDecision = await resolveDesktopTeammateModeDecision(
    request.extraCliArgs,
    shellEnv
  );
  applyDesktopTeammateModeDecisionToEnv(shellEnv, teammateModeDecision);
  let mcpConfigPath: string;
  let bootstrapSpecPath: string;
  let bootstrapUserPromptPath: string | null = null;
  let runtimeArgsPlan: TeamRuntimeLaunchArgsPlan;
  try {
    // Pre-save our meta files before native app-managed briefing generation.
    // member_briefing intentionally reads canonical team metadata/inboxes, so
    // createTeam must materialize those files before building the bootstrap spec.
    const materializedBootstrapFiles = await materializeDeterministicCreateTeamBootstrapFiles({
      request,
      run,
      effectiveMemberSpecs,
      allEffectiveMemberSpecs,
      launchIdentity,
      initialUserPrompt,
      promptSize,
      controlApiBaseUrl: provisioningEnv.env.CLAUDE_TEAM_CONTROL_URL,
      teamMetaStore: ports.teamMetaStore,
      membersMetaStore: ports.membersMetaStore,
      mcpConfigBuilder: ports.mcpConfigBuilder,
      buildMemberMcpLaunchConfigs: () =>
        ports.buildMemberMcpLaunchConfigs({
          controlApiBaseUrl: provisioningEnv.env.CLAUDE_TEAM_CONTROL_URL,
          cwd: request.cwd,
          members: effectiveMemberSpecs,
          run,
        }),
      validateAgentTeamsMcpRuntime: (createdMcpConfigPath) =>
        ports.validateAgentTeamsMcpRuntime(createdMcpConfigPath, {
          isCancelled: () =>
            run.cancelRequested ||
            run.processKilled ||
            ports.getStopAllTeamsGeneration() !== stopAllGenerationAtStart,
        }),
    });
    mcpConfigPath = materializedBootstrapFiles.mcpConfigPath;
    bootstrapSpecPath = materializedBootstrapFiles.bootstrapSpecPath;
    bootstrapUserPromptPath = materializedBootstrapFiles.bootstrapUserPromptPath;
    const extraCliArgs = parseCliArgs(request.extraCliArgs);
    runtimeArgsPlan = await ports.buildTeamRuntimeLaunchArgsPlan({
      teamName: request.teamName,
      providerId: resolvedProviderId,
      launchIdentity,
      envResolution: { ...provisioningEnv, providerArgs: providerArgsForLaunch },
      extraArgs: extraCliArgs,
      inheritedProviderArgs: inheritedProviderArgsForLaunch,
      includeAnthropicHelper: resolvedProviderId === 'anthropic',
      contextLabel: 'Team create launch',
    });
  } catch (error) {
    await cleanupDeterministicCreateMaterializationFailure(run, request, provisioningEnv, ports);
    throw error;
  }
  const launchModelArg = getLaunchModelArg(
    resolveTeamProviderId(request.providerId),
    request.model,
    launchIdentity
  );
  const spawnArgs = buildDeterministicCreateSpawnArgs({
    mcpConfigPath,
    bootstrapSpecPath,
    bootstrapUserPromptPath,
    skipPermissions: request.skipPermissions,
    launchModelArg,
    resolvedEffort: launchIdentity?.resolvedEffort ?? undefined,
    providerArgs: runtimeArgsPlan.providerArgs,
    fastModeArgs: runtimeArgsPlan.fastModeArgs,
    runtimeTurnSettledHookArgs: runtimeArgsPlan.runtimeTurnSettledHookArgs,
    runtimeExtraArgs: runtimeArgsPlan.extraArgs,
    settingsArgs: runtimeArgsPlan.settingsArgs,
    inheritedProviderArgs: runtimeArgsPlan.inheritedProviderArgs,
    worktree: request.worktree,
    teammateModeDecision,
    disallowedTools,
  });
  applyAppManagedRuntimeSettingsPathEnv(shellEnv, runtimeArgsPlan.appManagedSettingsPath);
  const runtimeWarning = buildRuntimeLaunchWarning(request, shellEnv, {
    geminiRuntimeAuth,
    promptSize,
    expectedMembersCount: effectiveMemberSpecs.length,
  });
  logRuntimeLaunchSnapshot(logger, request.teamName, claudePath, spawnArgs, request, shellEnv, {
    geminiRuntimeAuth,
    promptSize,
    expectedMembersCount: effectiveMemberSpecs.length,
    launchIdentity,
  });
  try {
    if (
      shouldCancelDeterministicCreateSpawn({
        cancelRequested: run.cancelRequested,
        processKilled: run.processKilled,
        stopAllGenerationAtStart,
        currentStopAllTeamsGeneration: ports.getStopAllTeamsGeneration(),
      })
    ) {
      throw new Error('Team launch cancelled by app shutdown');
    }
    if (request.skipPermissions === false) {
      emitProvisioningCheckpoint(run, 'Seeding lead bootstrap permission rules');
      await ports.seedLeadBootstrapPermissionRules(request.teamName, request.cwd);
    }

    emitProvisioningCheckpoint(
      run,
      'Spawning Claude CLI process',
      `args=${spawnArgs.length} cwd=${request.cwd}`
    );
    child = ports.spawnCli(claudePath, spawnArgs, {
      cwd: request.cwd,
      env: { ...shellEnv },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
  } catch (error) {
    // Clean up pre-saved meta files if spawn failed (instant failure, not transient)
    await cleanupDeterministicCreateSpawnFailure(run, request, provisioningEnv, ports);
    throw error;
  }

  ports.updateProgress(run, 'spawning', 'Starting Claude CLI process', {
    pid: child.pid ?? undefined,
    warnings: mergeProvisioningWarnings(run.progress.warnings, runtimeWarning),
  });
  run.onProgress(run.progress);
  run.child = child;
  run.processClosed = false;
  run.spawnContext = {
    claudePath,
    args: spawnArgs,
    cwd: request.cwd,
    env: { ...shellEnv },
    prompt: initialUserPrompt,
  };

  ports.attachStdoutHandler(run);
  ports.attachStderrHandler(run);

  // Reset AFTER spawn — not at run init — because async operations (buildProvisioningEnv,
  // writeConfigFile) between init and spawn can take seconds, causing false stall warnings.
  run.lastDataReceivedAt = Date.now();
  run.lastStdoutReceivedAt = Date.now();
  ports.startStallWatchdog(run);

  // Filesystem-based progress monitor: actively polls team files instead
  // of relying on stdout (which only arrives at the end in text mode).
  // When config + members + tasks are all present, kill the process early
  // rather than waiting for it to deadlock on system-reminder shutdown.
  ports.updateProgress(run, 'configuring', 'Waiting for team configuration...');
  run.onProgress(run.progress);
  ports.startFilesystemMonitor(run, request);

  const spawnedChild = child;
  run.timeoutHandle = setTimeout(() => {
    if (!run.processKilled && !run.provisioningComplete && run.child === spawnedChild) {
      run.finalizingByTimeout = true;
      void handleDeterministicCreateSpawnTimeout(run, ports, spawnedChild);
    }
  }, getProvisioningRunTimeoutMs(run));

  child.once('error', (error) => {
    const progress = ports.updateProgress(run, 'failed', 'Failed to start Claude CLI', {
      error: error.message,
      cliLogsTail: extractCliLogsFromRun(run),
    });
    run.onProgress(progress);
    ports.cleanupRun(run);
  });

  child.once('close', (code) => {
    void ports.handleProcessExit(run, code);
  });

  return { runId };
}
