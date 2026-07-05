import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { cleanupAnthropicTeamApiKeyHelperMaterial } from '../../runtime/anthropicTeamApiKeyHelper';
import { buildNativeAppManagedBootstrapSpecsWithDiagnostics } from '../bootstrap/NativeAppManagedBootstrapContextBuilder';
import { ClaudeBinaryResolver } from '../ClaudeBinaryResolver';
import { TeamTaskReader } from '../TeamTaskReader';

import { type RuntimeBootstrapMemberMcpLaunchConfig } from './TeamProvisioningBootstrapSpec';
import { type TeamLaunchCompatibilityReport } from './TeamProvisioningLaunchCompatibility';
import {
  type DeterministicLaunchRunFlowRun,
  type PreparedDeterministicLaunchSetup,
  type RunDeterministicLaunchRunFlowPorts,
} from './TeamProvisioningLaunchDeterministicRunFlow';
import {
  type DeterministicLaunchSetupPorts,
  type DeterministicLaunchSetupResult,
} from './TeamProvisioningLaunchDeterministicSetupFlow';
import { type TeamProvisioningLaunchExpectedMembersPorts } from './TeamProvisioningLaunchExpectedMembers';
import { type TeamProvisioningProviderRuntimeFacade } from './TeamProvisioningProviderRuntimeFacade';
import { type RuntimeTurnSettledEnvironmentProvider } from './TeamProvisioningRuntimeTurnSettledPlanning';
import { type WorkspaceTrustWorkspaceCollectionPorts } from './TeamProvisioningWorkspaceTrust';

import type { ProvisioningEnvResolution } from './TeamProvisioningEnvBuilder';
import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type {
  WorkspaceTrustCoordinator,
  WorkspaceTrustFeatureFlags,
  WorkspaceTrustFullPlanResult,
} from '@features/workspace-trust/main';
import type { MemberSpawnStatusEntry, TeamCreateRequest, TeamLaunchRequest } from '@shared/types';
import type { ChildProcess } from 'child_process';

const TEAM_JSON_READ_TIMEOUT_MS = 5_000;
const TEAM_CONFIG_MAX_BYTES = 10 * 1024 * 1024;

export interface TeamProvisioningLaunchDeterministicFlowHost<
  TRun extends DeterministicLaunchRunFlowRun<TMixedSecondaryLane>,
  TMixedSecondaryLane,
> {
  runTracking: {
    getAliveRunId(teamName: string): string | null;
  };
  runs: Map<string, TRun>;
  provisioningRunByTeam: Map<string, string>;
  getStopAllTeamsGeneration(): number;
  providerRuntime: Pick<
    TeamProvisioningProviderRuntimeFacade,
    'buildProvisioningEnv' | 'buildCrossProviderMemberArgs' | 'validateAgentTeamsMcpRuntime'
  >;
  getWorkspaceTrustCoordinator(): WorkspaceTrustCoordinator | null;
  workspaceTrustWorkspaceCollectionPorts: WorkspaceTrustWorkspaceCollectionPorts;
  getRuntimeTurnSettledEnvironmentProvider(): RuntimeTurnSettledEnvironmentProvider | null;
  mcpConfigBuilder: RunDeterministicLaunchRunFlowPorts<TMixedSecondaryLane>['mcpConfigBuilder'];
  teamMetaStore: RunDeterministicLaunchRunFlowPorts<TMixedSecondaryLane>['teamMetaStore'];
  membersMetaStore: RunDeterministicLaunchRunFlowPorts<TMixedSecondaryLane>['membersMetaStore'];
  getRunTrackedCwd(run: TRun | null | undefined): string | null;
  materializeLaunchCompatibilityRepair(
    request: TeamLaunchRequest,
    report: TeamLaunchCompatibilityReport
  ): Promise<void>;
  normalizeTeamConfigForLaunch(teamName: string, configRaw: string): Promise<void>;
  assertConfigLeadOnlyForLaunch(teamName: string): Promise<void>;
  updateConfigProjectPath(teamName: string, cwd: string): Promise<void>;
  restorePrelaunchConfig(teamName: string): Promise<void>;
  materializeEffectiveTeamMemberSpecs: DeterministicLaunchSetupPorts<TMixedSecondaryLane>['materializeEffectiveTeamMemberSpecs'];
  resolveOpenCodeMemberWorkspacesForRuntime: DeterministicLaunchSetupPorts<TMixedSecondaryLane>['resolveOpenCodeMemberWorkspacesForRuntime'];
  planRuntimeLanesOrThrow: DeterministicLaunchSetupPorts<TMixedSecondaryLane>['planRuntimeLanesOrThrow'];
  createMixedSecondaryLaneStates(plan: TeamRuntimeLanePlan): TMixedSecondaryLane[];
  resolveAndValidateLaunchIdentity: DeterministicLaunchSetupPorts<TMixedSecondaryLane>['resolveAndValidateLaunchIdentity'];
  prepareWorkspaceTrustForDeterministicRun(input: {
    mode: 'launch';
    run: TRun;
    claudePath: string;
    shellEnv: NodeJS.ProcessEnv;
    stopAllGenerationAtStart: number;
    workspaceTrustPlan: WorkspaceTrustFullPlanResult | null;
    featureFlags: WorkspaceTrustFeatureFlags;
    provisioningEnv: ProvisioningEnvResolution;
  }): Promise<void>;
  resetTeamScopedTransientStateForNewRun(teamName: string): void;
  clearPersistedLaunchState(teamName: string, options: { expectedRunId: string }): Promise<void>;
  publishMixedSecondaryLaneStatusChange(run: TRun, lane: TMixedSecondaryLane): Promise<void>;
  buildRuntimeBootstrapMemberMcpLaunchConfigs(input: {
    controlApiBaseUrl?: string | null;
    cwd: string;
    members: TeamCreateRequest['members'];
    run: TRun;
  }): Promise<ReadonlyMap<string, RuntimeBootstrapMemberMcpLaunchConfig>>;
  buildTeamRuntimeLaunchArgsPlan: RunDeterministicLaunchRunFlowPorts<TMixedSecondaryLane>['buildTeamRuntimeLaunchArgsPlan'];
  seedLeadBootstrapPermissionRules(teamName: string, cwd: string): Promise<void>;
  attachStdoutHandler(run: TRun): void;
  attachStderrHandler(run: TRun): void;
  startStallWatchdog(run: TRun): void;
  tryCompleteAfterTimeout(run: TRun): Promise<boolean>;
  cleanupRun(run: TRun): void;
  handleProcessExit(run: TRun, code: number | null): Promise<void> | void;
  removeRunMemberMcpConfigFiles(run: TRun): Promise<void>;
}

export interface TeamProvisioningLaunchDeterministicFlowBoundaryDeps<
  TRun extends DeterministicLaunchRunFlowRun<TMixedSecondaryLane>,
  TMixedSecondaryLane,
> {
  host: TeamProvisioningLaunchDeterministicFlowHost<TRun, TMixedSecondaryLane>;
  launchExpectedMembersPorts: TeamProvisioningLaunchExpectedMembersPorts;
  createInitialMemberSpawnStatusEntry(): MemberSpawnStatusEntry;
  randomUUID(): string;
  nowIso(): string;
  logger: DeterministicLaunchSetupPorts<TMixedSecondaryLane>['logger'] &
    RunDeterministicLaunchRunFlowPorts<TMixedSecondaryLane>['logger'];
  spawnCli: RunDeterministicLaunchRunFlowPorts<TMixedSecondaryLane>['spawnCli'];
  updateProgress: RunDeterministicLaunchRunFlowPorts<TMixedSecondaryLane>['updateProgress'];
  setTimeout(callback: () => void, ms: number): NodeJS.Timeout;
  killTeamProcess(child: ChildProcess | null | undefined): void;
}

export interface TeamProvisioningLaunchDeterministicFlowBoundary<TMixedSecondaryLane> {
  createSetupPorts(): DeterministicLaunchSetupPorts<TMixedSecondaryLane>;
  createRunFlowPorts(input: {
    request: TeamLaunchRequest;
    setup: PreparedDeterministicLaunchSetup<TMixedSecondaryLane>;
  }): RunDeterministicLaunchRunFlowPorts<TMixedSecondaryLane>;
}

async function tryReadRegularFileUtf8(
  filePath: string,
  opts: { timeoutMs: number; maxBytes: number }
): Promise<string | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.stat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }

  if (!stat.isFile() || stat.size > opts.maxBytes) {
    return null;
  }

  try {
    return await readFileUtf8WithTimeout(filePath, opts.timeoutMs);
  } catch (error) {
    if (error instanceof FileReadTimeoutError) {
      return null;
    }
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      return null;
    }
    return null;
  }
}

function assertPreparedSetup<TMixedSecondaryLane>(
  setup: DeterministicLaunchSetupResult<TMixedSecondaryLane>
): asserts setup is PreparedDeterministicLaunchSetup<TMixedSecondaryLane> {
  if (setup.kind !== 'prepared') {
    throw new Error('Expected prepared deterministic launch setup');
  }
}

export function createTeamProvisioningLaunchDeterministicFlowBoundary<
  TRun extends DeterministicLaunchRunFlowRun<TMixedSecondaryLane>,
  TMixedSecondaryLane,
>(
  deps: TeamProvisioningLaunchDeterministicFlowBoundaryDeps<TRun, TMixedSecondaryLane>
): TeamProvisioningLaunchDeterministicFlowBoundary<TMixedSecondaryLane> {
  const { host } = deps;

  return {
    createSetupPorts: () => ({
      readTeamConfigRaw: (teamName) => {
        const configPath = path.join(getTeamsBasePath(), teamName, 'config.json');
        return tryReadRegularFileUtf8(configPath, {
          timeoutMs: TEAM_JSON_READ_TIMEOUT_MS,
          maxBytes: TEAM_CONFIG_MAX_BYTES,
        });
      },
      getExistingAliveRunId: (teamName) => host.runTracking.getAliveRunId(teamName),
      getExistingRun: (runId) => host.runs.get(runId),
      getRunTrackedCwd: (existingRun) =>
        host.getRunTrackedCwd(existingRun as TRun | null | undefined),
      deleteProvisioningRunByTeam: (teamName) => {
        host.provisioningRunByTeam.delete(teamName);
      },
      launchExpectedMembersPorts: deps.launchExpectedMembersPorts,
      materializeLaunchCompatibilityRepair: (request, report) =>
        host.materializeLaunchCompatibilityRepair(request, report),
      normalizeTeamConfigForLaunch: (teamName, configRaw) =>
        host.normalizeTeamConfigForLaunch(teamName, configRaw),
      assertConfigLeadOnlyForLaunch: (teamName) => host.assertConfigLeadOnlyForLaunch(teamName),
      updateConfigProjectPath: (teamName, cwd) => host.updateConfigProjectPath(teamName, cwd),
      restorePrelaunchConfig: (teamName) => host.restorePrelaunchConfig(teamName),
      resolveClaudePath: () => ClaudeBinaryResolver.resolve(),
      buildProvisioningEnv: (providerId, providerBackendId, options) =>
        host.providerRuntime.buildProvisioningEnv(providerId, providerBackendId, options),
      workspaceTrustCoordinator: host.getWorkspaceTrustCoordinator(),
      workspaceTrustWorkspaceCollectionPorts: host.workspaceTrustWorkspaceCollectionPorts,
      materializeEffectiveTeamMemberSpecs: (params) =>
        host.materializeEffectiveTeamMemberSpecs(params),
      resolveOpenCodeMemberWorkspacesForRuntime: (params) =>
        host.resolveOpenCodeMemberWorkspacesForRuntime(params),
      runtimeTurnSettledEnvironmentProvider: host.getRuntimeTurnSettledEnvironmentProvider(),
      planRuntimeLanesOrThrow: (leadProviderId, members, baseCwd) =>
        host.planRuntimeLanesOrThrow(leadProviderId, members, baseCwd),
      createMixedSecondaryLaneStates: (lanePlan) => host.createMixedSecondaryLaneStates(lanePlan),
      buildCrossProviderMemberArgs: (primaryProviderId, memberSpecs, options) =>
        host.providerRuntime.buildCrossProviderMemberArgs(primaryProviderId, memberSpecs, options),
      resolveAndValidateLaunchIdentity: (params) => host.resolveAndValidateLaunchIdentity(params),
      randomUUID: deps.randomUUID,
      nowIso: deps.nowIso,
      logger: deps.logger,
    }),

    createRunFlowPorts: ({ request, setup }) => {
      assertPreparedSetup(setup);

      return {
        createInitialMemberSpawnStatusEntry: deps.createInitialMemberSpawnStatusEntry,
        prepareWorkspaceTrustForDeterministicRun: (input) =>
          host.prepareWorkspaceTrustForDeterministicRun({
            ...input,
            run: input.run as TRun,
          }),
        resetTeamScopedTransientStateForNewRun: (teamName) =>
          host.resetTeamScopedTransientStateForNewRun(teamName),
        registerRun: (nextRunId, nextRun) => {
          host.runs.set(nextRunId, nextRun as TRun);
        },
        setProvisioningRunByTeam: (teamName, nextRunId) => {
          host.provisioningRunByTeam.set(teamName, nextRunId);
        },
        clearPersistedLaunchState: (teamName, options) =>
          host.clearPersistedLaunchState(teamName, options),
        publishMixedSecondaryLaneStatusChange: (nextRun, lane) =>
          host.publishMixedSecondaryLaneStatusChange(nextRun as TRun, lane),
        logger: deps.logger,
        mcpConfigBuilder: host.mcpConfigBuilder,
        readTasks: (teamName) => new TeamTaskReader().getTasks(teamName),
        logTaskReadWarning: (message) => deps.logger.warn(message),
        buildNativeAppManagedBootstrapSpecsWithDiagnostics,
        buildRuntimeBootstrapMemberMcpLaunchConfigs: (input) =>
          host.buildRuntimeBootstrapMemberMcpLaunchConfigs({
            ...input,
            run: input.run as TRun,
          }),
        validateAgentTeamsMcpRuntime: (createdMcpConfigPath, options) =>
          host.providerRuntime.validateAgentTeamsMcpRuntime(
            setup.claudePath,
            request.cwd,
            setup.shellEnv,
            createdMcpConfigPath,
            options
          ),
        cleanupAnthropicApiKeyHelperMaterial: (directory) =>
          cleanupAnthropicTeamApiKeyHelperMaterial({ directory }),
        removeRunMemberMcpConfigFiles: (provisioningRun) =>
          host.removeRunMemberMcpConfigFiles(provisioningRun as TRun),
        restorePrelaunchConfig: (teamName) => host.restorePrelaunchConfig(teamName),
        deleteRun: (nextRunId) => {
          host.runs.delete(nextRunId);
        },
        deleteProvisioningRunByTeam: (teamName) => {
          host.provisioningRunByTeam.delete(teamName);
        },
        buildTeamRuntimeLaunchArgsPlan: (input) => host.buildTeamRuntimeLaunchArgsPlan(input),
        teamMetaStore: host.teamMetaStore,
        membersMetaStore: host.membersMetaStore,
        nowMs: () => Date.now(),
        getStopAllTeamsGeneration: () => host.getStopAllTeamsGeneration(),
        seedLeadBootstrapPermissionRules: (teamName, cwd) =>
          host.seedLeadBootstrapPermissionRules(teamName, cwd),
        spawnCli: deps.spawnCli,
        updateProgress: deps.updateProgress,
        attachStdoutHandler: (provisioningRun) => host.attachStdoutHandler(provisioningRun as TRun),
        attachStderrHandler: (provisioningRun) => host.attachStderrHandler(provisioningRun as TRun),
        startStallWatchdog: (provisioningRun) => host.startStallWatchdog(provisioningRun as TRun),
        setTimeout: (callback, ms) => deps.setTimeout(callback, ms),
        tryCompleteAfterTimeout: (provisioningRun) =>
          host.tryCompleteAfterTimeout(provisioningRun as TRun),
        killTeamProcess: deps.killTeamProcess,
        cleanupRun: (provisioningRun) => host.cleanupRun(provisioningRun as TRun),
        handleProcessExit: (provisioningRun, code) =>
          host.handleProcessExit(provisioningRun as TRun, code),
      };
    },
  };
}
