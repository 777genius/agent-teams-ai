import { type ChildProcess, type SpawnOptions } from 'child_process';

import { type GeminiRuntimeAuthState } from '../../runtime/geminiRuntimeAuth';
import { crossRosterLaunchInvocationBoundary } from '../TeamMembersMetaStore';
import { type TeamMetaFile } from '../TeamMetaStore';

import {
  type AnthropicApiKeyHelperRunOwner,
  cleanupRunOwnedAnthropicApiKeyHelper,
} from './TeamProvisioningAnthropicApiKeyHelperLease';
import {
  getProvisioningRunTimeoutMs,
  removeDeterministicBootstrapSpecFile,
  removeDeterministicBootstrapUserPromptFile,
  type RuntimeBootstrapMemberMcpLaunchConfig,
  writeDeterministicBootstrapSpecFile,
  writeDeterministicBootstrapUserPromptFile,
} from './TeamProvisioningBootstrapSpec';
import { createChildProcessTerminalReconciler } from './TeamProvisioningChildSettlement';
import {
  buildMembersMetaWritePayload,
  mergeMembersMetaForLaunch,
  selectMembersMetaTeammates,
} from './TeamProvisioningConfigLaunchNormalization';
import { applyAppManagedRuntimeSettingsPathEnv } from './TeamProvisioningEnvGuards';
import { mergeProvisioningWarnings } from './TeamProvisioningLaunchCompatibility';
import {
  buildDeterministicLaunchProcessArgs,
  materializeDeterministicLaunchBootstrapFiles,
  type MaterializeDeterministicLaunchBootstrapFilesPorts,
  type TeamProvisioningLaunchBootstrapRun,
} from './TeamProvisioningLaunchTeamFlow';
import { emitProvisioningCheckpoint } from './TeamProvisioningProgressBuffers';
import { buildDeterministicLaunchHydrationPrompt } from './TeamProvisioningPromptBuilders';
import { extractCliLogsFromRun } from './TeamProvisioningRetainedLogs';
import {
  asRosterLaunchKnownNoStartError,
  RosterLaunchKnownNoStartError,
  withProductionStartedLaunchStatus,
} from './TeamProvisioningRosterLaunchOutcome';
import {
  buildRuntimeLaunchWarning,
  getPromptSizeSummary,
  logRuntimeLaunchSnapshot,
} from './TeamProvisioningRuntimeDiagnostics';
import { type TeamRuntimeLaunchArgsPlanEnvResolutionLike } from './TeamProvisioningRuntimeLaunchSelection';
import { waitForSpawnBoundary } from './TeamProvisioningSpawnBoundary';

import type { PreparedMcpConfig } from '../TeamMcpConfigBuilder';
import type { PreparedRuntimeBootstrapMemberMcpLaunchConfig } from './TeamProvisioningBootstrapSpec';
import type { LaunchContinuationSourceSnapshot } from './TeamProvisioningLaunchContinuationEvidence';
import type { PreparedDeterministicLaunchMaterial } from './TeamProvisioningLaunchDeterministicSetupFlow';
import type { RuntimeLaunchLogger } from './TeamProvisioningRuntimeDiagnostics';
import type {
  ProviderModelLaunchIdentity,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamLaunchResponse,
  TeamMember,
  TeamProviderId,
  TeamProvisioningProgress,
  TeamProvisioningState,
  TeamTask,
} from '@shared/types';

export type LaunchTeamMetaPayload = Omit<TeamMetaFile, 'version'>;

export interface DeterministicLaunchSpawnFlowRun
  extends TeamProvisioningLaunchBootstrapRun, AnthropicApiKeyHelperRunOwner {
  runId: string;
  teamName: string;
  child: ChildProcess | null;
  processClosed: boolean;
  deterministicBootstrap: boolean;
  effectiveMembers: TeamCreateRequest['members'];
  lastDataReceivedAt: number;
  lastStdoutReceivedAt: number;
  timeoutHandle: NodeJS.Timeout | null;
  provisioningComplete: boolean;
  finalizingByTimeout: boolean;
  spawnContext: {
    claudePath: string;
    args: string[];
    cwd: string;
    env: NodeJS.ProcessEnv;
    prompt: string;
  } | null;
}

export interface DeterministicLaunchMcpConfigBuilder {
  writeConfigFile(cwd: string, options: { controlApiBaseUrl?: string | null }): Promise<string>;
  removeConfigFile(filePath: string): Promise<void> | void;
  prepareConfig(
    cwd: string,
    options: { controlApiBaseUrl?: string | null }
  ): Promise<PreparedMcpConfig>;
  writePreparedConfigFile(prepared: PreparedMcpConfig): Promise<string>;
}

export interface DeterministicLaunchSpawnEnvResolution extends TeamRuntimeLaunchArgsPlanEnvResolutionLike {
  env: NodeJS.ProcessEnv;
  geminiRuntimeAuth?: GeminiRuntimeAuthState | null;
}

export interface RunDeterministicLaunchSpawnFlowInput<
  TRun extends DeterministicLaunchSpawnFlowRun,
> {
  request: TeamLaunchRequest;
  syntheticRequest: TeamCreateRequest;
  run: TRun;
  runId: string;
  claudePath: string;
  shellEnv: NodeJS.ProcessEnv;
  provisioningEnv: DeterministicLaunchSpawnEnvResolution;
  stopAllGenerationAtStart: number;
  resolvedProviderId: TeamProviderId;
  providerArgsForLaunch: string[];
  crossProviderMemberArgsForLaunch: { args: string[] };
  launchIdentity: ProviderModelLaunchIdentity | null;
  preparedLaunchMaterial: PreparedDeterministicLaunchMaterial;
  effectiveMemberSpecs: TeamCreateRequest['members'];
  allEffectiveMemberSpecs: TeamCreateRequest['members'];
  teammateRuntimeDisallowedTools: string;
}

export interface RunDeterministicLaunchSpawnFlowPorts<
  TRun extends DeterministicLaunchSpawnFlowRun,
> {
  logger: RuntimeLaunchLogger;
  mcpConfigBuilder: DeterministicLaunchMcpConfigBuilder;
  readTasks(teamName: string): Promise<TeamTask[]>;
  logTaskReadWarning(message: string): void;
  buildNativeAppManagedBootstrapSpecsWithDiagnostics: MaterializeDeterministicLaunchBootstrapFilesPorts<TRun>['buildNativeAppManagedBootstrapSpecsWithDiagnostics'];
  buildRuntimeBootstrapMemberMcpLaunchConfigs(input: {
    controlApiBaseUrl?: string | null;
    cwd: string;
    members: TeamCreateRequest['members'];
    run: TRun;
    preparedConfigs?: ReadonlyMap<string, PreparedRuntimeBootstrapMemberMcpLaunchConfig>;
  }): Promise<ReadonlyMap<string, RuntimeBootstrapMemberMcpLaunchConfig>>;
  validateAgentTeamsMcpRuntime(
    mcpConfigPath: string,
    options: { isCancelled(): boolean }
  ): Promise<void>;
  cleanupAnthropicApiKeyHelperMaterial(directory: string): Promise<void>;
  removeRunMemberMcpConfigFiles(run: TRun): Promise<void>;
  restorePrelaunchConfig(teamName: string): Promise<void>;
  deleteRun(runId: string): void;
  deleteProvisioningRunByTeam(teamName: string): void;
  verifyLaunchMaterialSources(snapshot: LaunchContinuationSourceSnapshot): Promise<void>;
  teamMetaStore: {
    writeMeta(teamName: string, payload: LaunchTeamMetaPayload): Promise<void>;
  };
  membersMetaStore: {
    getMembers(teamName: string): Promise<TeamMember[]>;
    writeMembers(
      teamName: string,
      members: TeamMember[],
      options?: { providerBackendId?: string | null }
    ): Promise<void>;
  };
  nowMs(): number;
  getStopAllTeamsGeneration(): number;
  seedLeadBootstrapPermissionRules(teamName: string, cwd: string): Promise<void>;
  spawnCli(command: string, args: string[], options: SpawnOptions): ChildProcess;
  updateProgress(
    run: TRun,
    state: Exclude<TeamProvisioningState, 'idle'>,
    message: string,
    extras?: Partial<
      Pick<
        TeamProvisioningProgress,
        | 'pid'
        | 'error'
        | 'warnings'
        | 'cliLogsTail'
        | 'configReady'
        | 'messageSeverity'
        | 'launchDiagnostics'
      >
    >
  ): TeamProvisioningProgress;
  attachStdoutHandler(run: TRun): void;
  attachStderrHandler(run: TRun): void;
  startStallWatchdog(run: TRun): void;
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
  tryCompleteAfterTimeout(run: TRun): Promise<boolean>;
  killTeamProcessAndWait(child: ChildProcess | null | undefined): Promise<void>;
  cleanupRun(run: TRun): void;
  handleProcessExit(run: TRun, code: number | null): Promise<void> | void;
}

export function buildLaunchTeamMetaPayload(input: {
  request: TeamLaunchRequest;
  syntheticRequest: TeamCreateRequest;
  launchIdentity: ProviderModelLaunchIdentity | null;
  nowMs: number;
}): LaunchTeamMetaPayload {
  const { request, syntheticRequest, launchIdentity, nowMs } = input;
  return {
    displayName: syntheticRequest.displayName,
    description: syntheticRequest.description,
    color: syntheticRequest.color,
    cwd: request.cwd,
    prompt: request.prompt,
    providerId: syntheticRequest.providerId,
    providerBackendId: syntheticRequest.providerBackendId,
    model: syntheticRequest.model,
    effort: syntheticRequest.effort,
    leadRuntimeSelectionProvenance:
      request.leadRuntimeSelectionProvenance ?? syntheticRequest.leadRuntimeSelectionProvenance,
    fastMode: syntheticRequest.fastMode,
    skipPermissions: syntheticRequest.skipPermissions,
    worktree: syntheticRequest.worktree,
    extraCliArgs: syntheticRequest.extraCliArgs,
    limitContext: syntheticRequest.limitContext,
    launchIdentity: launchIdentity ?? undefined,
    createdAt: nowMs,
  };
}

export async function persistDeterministicLaunchMetadata<
  TRun extends DeterministicLaunchSpawnFlowRun,
>(
  input: {
    request: TeamLaunchRequest;
    syntheticRequest: TeamCreateRequest;
    launchIdentity: ProviderModelLaunchIdentity | null;
    allEffectiveMemberSpecs: TeamCreateRequest['members'];
  },
  ports: Pick<
    RunDeterministicLaunchSpawnFlowPorts<TRun>,
    'teamMetaStore' | 'membersMetaStore' | 'nowMs'
  >
): Promise<void> {
  const { request, syntheticRequest, launchIdentity, allEffectiveMemberSpecs } = input;
  await ports.teamMetaStore.writeMeta(
    request.teamName,
    buildLaunchTeamMetaPayload({
      request,
      syntheticRequest,
      launchIdentity,
      nowMs: ports.nowMs(),
    })
  );
  if (!request.rosterTransactionId) {
    const existingMembers = await ports.membersMetaStore.getMembers(request.teamName);
    await ports.membersMetaStore.writeMembers(
      request.teamName,
      mergeMembersMetaForLaunch(
        buildMembersMetaWritePayload(selectMembersMetaTeammates(allEffectiveMemberSpecs)),
        existingMembers
      ),
      {
        providerBackendId: syntheticRequest.providerBackendId,
      }
    );
  }
}

export function isDeterministicLaunchSpawnCancelled(input: {
  run: Pick<DeterministicLaunchSpawnFlowRun, 'cancelRequested' | 'processKilled'>;
  stopAllGenerationAtStart: number;
  currentStopAllGeneration: number;
}): boolean {
  return (
    input.run.cancelRequested ||
    input.run.processKilled ||
    input.currentStopAllGeneration !== input.stopAllGenerationAtStart
  );
}

async function cleanupAnthropicHelperIfPresent<TRun extends DeterministicLaunchSpawnFlowRun>(
  run: TRun,
  ports: Pick<RunDeterministicLaunchSpawnFlowPorts<TRun>, 'cleanupAnthropicApiKeyHelperMaterial'>
): Promise<boolean> {
  try {
    await cleanupRunOwnedAnthropicApiKeyHelper(run, ({ directory }) =>
      ports.cleanupAnthropicApiKeyHelperMaterial(directory)
    );
  } catch {
    return false;
  }
  return true;
}

async function removeLaunchMaterializedFiles<TRun extends DeterministicLaunchSpawnFlowRun>(
  run: TRun,
  ports: Pick<
    RunDeterministicLaunchSpawnFlowPorts<TRun>,
    'mcpConfigBuilder' | 'removeRunMemberMcpConfigFiles'
  >
): Promise<void> {
  await removeDeterministicBootstrapSpecFile(run.bootstrapSpecPath).catch(() => {});
  run.bootstrapSpecPath = null;
  await removeDeterministicBootstrapUserPromptFile(run.bootstrapUserPromptPath).catch(() => {});
  run.bootstrapUserPromptPath = null;
  if (run.mcpConfigPath) {
    await Promise.resolve(ports.mcpConfigBuilder.removeConfigFile(run.mcpConfigPath)).catch(
      () => {}
    );
    run.mcpConfigPath = null;
  }
  await ports.removeRunMemberMcpConfigFiles(run).catch(() => {});
}

export async function cleanupDeterministicLaunchMaterializationFailure<
  TRun extends DeterministicLaunchSpawnFlowRun,
>(
  input: {
    request: TeamLaunchRequest;
    run: TRun;
    runId: string;
    provisioningEnv: DeterministicLaunchSpawnEnvResolution;
  },
  ports: Pick<
    RunDeterministicLaunchSpawnFlowPorts<TRun>,
    | 'cleanupAnthropicApiKeyHelperMaterial'
    | 'deleteRun'
    | 'deleteProvisioningRunByTeam'
    | 'mcpConfigBuilder'
    | 'removeRunMemberMcpConfigFiles'
    | 'restorePrelaunchConfig'
  >
): Promise<void> {
  const helperReleased = await cleanupAnthropicHelperIfPresent(input.run, ports);
  await removeLaunchMaterializedFiles(input.run, ports);
  await ports.restorePrelaunchConfig(input.request.teamName);
  if (helperReleased) {
    ports.deleteRun(input.runId);
    ports.deleteProvisioningRunByTeam(input.request.teamName);
  }
}

export async function cleanupDeterministicLaunchSpawnFailure<
  TRun extends DeterministicLaunchSpawnFlowRun,
>(
  input: {
    request: TeamLaunchRequest;
    run: TRun;
    runId: string;
    provisioningEnv: DeterministicLaunchSpawnEnvResolution;
  },
  ports: Pick<
    RunDeterministicLaunchSpawnFlowPorts<TRun>,
    | 'cleanupAnthropicApiKeyHelperMaterial'
    | 'deleteRun'
    | 'deleteProvisioningRunByTeam'
    | 'mcpConfigBuilder'
    | 'removeRunMemberMcpConfigFiles'
    | 'restorePrelaunchConfig'
  >
): Promise<void> {
  if (input.run.mcpConfigPath) {
    await Promise.resolve(ports.mcpConfigBuilder.removeConfigFile(input.run.mcpConfigPath)).catch(
      () => {}
    );
    input.run.mcpConfigPath = null;
  }
  await removeDeterministicBootstrapSpecFile(input.run.bootstrapSpecPath).catch(() => {});
  input.run.bootstrapSpecPath = null;
  await removeDeterministicBootstrapUserPromptFile(input.run.bootstrapUserPromptPath).catch(
    () => {}
  );
  input.run.bootstrapUserPromptPath = null;
  await ports.removeRunMemberMcpConfigFiles(input.run).catch(() => {});
  const helperReleased = await cleanupAnthropicHelperIfPresent(input.run, ports);
  if (helperReleased) {
    ports.deleteRun(input.runId);
    ports.deleteProvisioningRunByTeam(input.request.teamName);
  }
  await ports.restorePrelaunchConfig(input.request.teamName);
}

export function registerDeterministicLaunchChildHandlers<
  TRun extends DeterministicLaunchSpawnFlowRun,
>(
  input: {
    run: TRun;
    child: ChildProcess;
  },
  ports: Pick<
    RunDeterministicLaunchSpawnFlowPorts<TRun>,
    | 'setTimeout'
    | 'tryCompleteAfterTimeout'
    | 'killTeamProcessAndWait'
    | 'updateProgress'
    | 'cleanupAnthropicApiKeyHelperMaterial'
    | 'cleanupRun'
    | 'handleProcessExit'
  >
): void {
  const { run, child } = input;
  run.timeoutHandle = ports.setTimeout(() => {
    if (!run.processKilled && !run.provisioningComplete && run.child === child) {
      run.finalizingByTimeout = true;
      void (async () => {
        const readyOnTimeout = await ports.tryCompleteAfterTimeout(run).catch(() => false);
        if (readyOnTimeout) {
          return;
        }
        if (
          run.provisioningComplete ||
          run.cancelRequested ||
          run.processKilled ||
          run.child !== child
        ) {
          run.finalizingByTimeout = false;
          return;
        }

        run.processKilled = true;
        try {
          await ports.killTeamProcessAndWait(child);
        } catch {
          run.finalizingByTimeout = false;
          const progress = ports.updateProgress(
            run,
            'failed',
            'Failed to confirm timed-out CLI termination (launch)',
            {
              error:
                'Timed out waiting for CLI during team launch, and the app could not confirm that the owned process tree stopped. The run remains tracked so termination can be retried.',
              cliLogsTail: extractCliLogsFromRun(run),
            }
          );
          run.onProgress(progress);
          return;
        }
        const progress = ports.updateProgress(run, 'failed', 'Timed out waiting for CLI (launch)', {
          error: 'Timed out waiting for CLI during team launch.',
          cliLogsTail: extractCliLogsFromRun(run),
        });
        run.onProgress(progress);
        if (!(await cleanupAnthropicHelperIfPresent(run, ports))) {
          run.finalizingByTimeout = false;
          const cleanupProgress = ports.updateProgress(
            run,
            'failed',
            'Timed-out launch stopped; helper cleanup will be retried',
            {
              error:
                'The owned process tree stopped, but app-managed authentication material could not be removed. The run remains tracked so cleanup can be retried.',
              cliLogsTail: extractCliLogsFromRun(run),
            }
          );
          run.onProgress(cleanupProgress);
          return;
        }
        ports.cleanupRun(run);
      })();
    }
  }, getProvisioningRunTimeoutMs(run));

  const reconcileChild = createChildProcessTerminalReconciler({
    reconcile: (code) => ports.handleProcessExit(run, code),
    onReconciliationFailure: (_reconciliationError, childError) => {
      const progress = ports.updateProgress(run, 'failed', 'Claude CLI process error (launch)', {
        error: childError?.message ?? 'Claude CLI process reconciliation failed',
        cliLogsTail: extractCliLogsFromRun(run),
      });
      run.onProgress(progress);
    },
  });
  child.once('error', (error: Error) => {
    void reconcileChild(null, error);
  });

  child.once('close', (code: number | null) => {
    void reconcileChild(code);
  });
}

export async function runDeterministicLaunchSpawnFlow<TRun extends DeterministicLaunchSpawnFlowRun>(
  input: RunDeterministicLaunchSpawnFlowInput<TRun>,
  ports: RunDeterministicLaunchSpawnFlowPorts<TRun>
): Promise<TeamLaunchResponse> {
  const {
    request,
    syntheticRequest,
    run,
    runId,
    claudePath,
    shellEnv,
    provisioningEnv,
    stopAllGenerationAtStart,
    resolvedProviderId,
    launchIdentity,
    preparedLaunchMaterial,
    effectiveMemberSpecs,
    allEffectiveMemberSpecs,
  } = input;

  shellEnv.CLAUDE_ENABLE_DETERMINISTIC_TEAM_BOOTSTRAP = '1';
  let prompt!: string;
  let promptSize!: ReturnType<typeof getPromptSizeSummary>;
  let mcpConfigPath: string;
  let bootstrapSpecPath: string;
  let bootstrapUserPromptPath: string | null = null;
  try {
    const materializedBootstrapFiles = await materializeDeterministicLaunchBootstrapFiles(
      {
        request,
        run,
        effectiveMemberSpecs,
        controlApiBaseUrl: provisioningEnv.env.CLAUDE_TEAM_CONTROL_URL,
        isValidationCancelled: () =>
          isDeterministicLaunchSpawnCancelled({
            run,
            stopAllGenerationAtStart,
            currentStopAllGeneration: ports.getStopAllTeamsGeneration(),
          }),
        preparedExistingTasks: preparedLaunchMaterial.existingTasks,
        preparedNativeBootstrapBuild: preparedLaunchMaterial.nativeBootstrapBuild,
        preparedLeadMcpConfig: preparedLaunchMaterial.leadMcpConfig,
        preparedMemberMcpLaunchConfigs: preparedLaunchMaterial.memberMcpLaunchConfigs,
      },
      {
        readTasks: ports.readTasks,
        logTaskReadWarning: ports.logTaskReadWarning,
        buildDeterministicLaunchHydrationPrompt,
        getPromptSizeSummary,
        buildNativeAppManagedBootstrapSpecsWithDiagnostics:
          ports.buildNativeAppManagedBootstrapSpecsWithDiagnostics,
        buildRuntimeBootstrapMemberMcpLaunchConfigs:
          ports.buildRuntimeBootstrapMemberMcpLaunchConfigs,
        writeDeterministicBootstrapSpecFile,
        writeDeterministicBootstrapUserPromptFile,
        mcpConfigBuilder: ports.mcpConfigBuilder,
        validateAgentTeamsMcpRuntime: ports.validateAgentTeamsMcpRuntime,
      }
    );
    prompt = materializedBootstrapFiles.prompt;
    promptSize = materializedBootstrapFiles.promptSize;
    mcpConfigPath = materializedBootstrapFiles.mcpConfigPath;
    bootstrapSpecPath = materializedBootstrapFiles.bootstrapSpecPath;
    bootstrapUserPromptPath = materializedBootstrapFiles.bootstrapUserPromptPath;
  } catch (error) {
    await cleanupDeterministicLaunchMaterializationFailure(
      { request, run, runId, provisioningEnv },
      ports
    );
    throw asRosterLaunchKnownNoStartError(error, 'Team launch materialization failed before spawn');
  }

  const { runtimeArgsPlan, teammateModeDecision } = preparedLaunchMaterial;
  emitProvisioningCheckpoint(run, 'Resolving cross-provider member launch args');
  const finalLaunchArgs = buildDeterministicLaunchProcessArgs({
    mcpConfigPath,
    bootstrapSpecPath,
    bootstrapUserPromptPath,
    skipPermissions: request.skipPermissions,
    worktree: request.worktree,
    providerId: resolvedProviderId,
    model: request.model,
    launchIdentity,
    runtimeArgsPlan,
    teammateModeDecision,
    disallowedTools: preparedLaunchMaterial.disallowedTools,
  });
  applyAppManagedRuntimeSettingsPathEnv(shellEnv, runtimeArgsPlan.appManagedSettingsPath);
  const runtimeWarning = buildRuntimeLaunchWarning(request, shellEnv, {
    geminiRuntimeAuth: provisioningEnv.geminiRuntimeAuth,
    promptSize,
    expectedMembersCount: effectiveMemberSpecs.length,
  });
  logRuntimeLaunchSnapshot(
    ports.logger,
    request.teamName,
    claudePath,
    finalLaunchArgs,
    request,
    shellEnv,
    {
      geminiRuntimeAuth: provisioningEnv.geminiRuntimeAuth,
      promptSize,
      expectedMembersCount: effectiveMemberSpecs.length,
      launchIdentity,
    }
  );

  let child: ChildProcess;
  try {
    if (
      isDeterministicLaunchSpawnCancelled({
        run,
        stopAllGenerationAtStart,
        currentStopAllGeneration: ports.getStopAllTeamsGeneration(),
      })
    ) {
      throw new RosterLaunchKnownNoStartError('Team launch cancelled by app shutdown');
    }
    if (request.skipPermissions === false) {
      emitProvisioningCheckpoint(run, 'Seeding lead bootstrap permission rules');
      await ports.seedLeadBootstrapPermissionRules(request.teamName, request.cwd);
    }
    if (
      isDeterministicLaunchSpawnCancelled({
        run,
        stopAllGenerationAtStart,
        currentStopAllGeneration: ports.getStopAllTeamsGeneration(),
      })
    ) {
      throw new RosterLaunchKnownNoStartError('Team launch cancelled by app shutdown');
    }
    try {
      await ports.verifyLaunchMaterialSources(preparedLaunchMaterial.sourceSnapshot);
    } catch (error) {
      throw asRosterLaunchKnownNoStartError(
        error,
        'Team launch material changed after continuation snapshot'
      );
    }
    emitProvisioningCheckpoint(run, 'Persisting team metadata before spawn');
    try {
      await persistDeterministicLaunchMetadata(
        { request, syntheticRequest, launchIdentity, allEffectiveMemberSpecs },
        ports
      );
    } catch (error) {
      throw asRosterLaunchKnownNoStartError(error, 'Team metadata persistence failed before spawn');
    }
    emitProvisioningCheckpoint(
      run,
      'Spawning Claude CLI process for team launch',
      `args=${finalLaunchArgs.length} cwd=${request.cwd}`
    );
    await ports.verifyLaunchMaterialSources(preparedLaunchMaterial.sourceSnapshot);
    const invocationLease = await crossRosterLaunchInvocationBoundary();
    child = invocationLease.invoke(() =>
      ports.spawnCli(claudePath, finalLaunchArgs, {
        cwd: request.cwd,
        env: { ...shellEnv },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
    );
    await waitForSpawnBoundary(child);
  } catch (error) {
    await cleanupDeterministicLaunchSpawnFailure({ request, run, runId, provisioningEnv }, ports);
    throw asRosterLaunchKnownNoStartError(error, 'Team launch failed before a process existed');
  }

  ports.updateProgress(run, 'spawning', 'Starting Claude CLI process for team launch', {
    pid: child.pid ?? undefined,
    warnings: mergeProvisioningWarnings(run.progress.warnings, runtimeWarning),
  });
  run.onProgress(run.progress);
  run.child = child;
  run.processClosed = false;
  run.spawnContext = {
    claudePath,
    args: finalLaunchArgs,
    cwd: request.cwd,
    env: { ...shellEnv },
    prompt,
  };

  ports.attachStdoutHandler(run);
  ports.attachStderrHandler(run);

  run.lastDataReceivedAt = Date.now();
  run.lastStdoutReceivedAt = Date.now();
  ports.startStallWatchdog(run);

  ports.updateProgress(run, 'configuring', 'CLI running - deterministic launch in progress');
  run.onProgress(run.progress);

  registerDeterministicLaunchChildHandlers({ run, child }, ports);

  return withProductionStartedLaunchStatus(request, { runId });
}
