import type {
  DeterministicCreateSpawnFlowPorts,
  DeterministicCreateSpawnFlowRun,
} from './TeamProvisioningCreateDeterministicSpawnFlow';
import type { TeamCreateRequest } from '@shared/types';

export interface TeamProvisioningCreateDeterministicSpawnFlowBoundaryInput {
  request: TeamCreateRequest;
  claudePath: string;
  shellEnv: NodeJS.ProcessEnv;
}

type DeterministicCreateSpawnFlowTeamMetaStore<TRun extends DeterministicCreateSpawnFlowRun> =
  DeterministicCreateSpawnFlowPorts<TRun>['teamMetaStore'];

export interface TeamProvisioningCreateDeterministicSpawnFlowBoundaryDeps<
  TRun extends DeterministicCreateSpawnFlowRun,
> {
  teamMetaStore: DeterministicCreateSpawnFlowTeamMetaStore<TRun>;
  membersMetaStore: DeterministicCreateSpawnFlowPorts<TRun>['membersMetaStore'];
  mcpConfigBuilder: DeterministicCreateSpawnFlowPorts<TRun>['mcpConfigBuilder'];
  buildMemberMcpLaunchConfigs: DeterministicCreateSpawnFlowPorts<TRun>['buildMemberMcpLaunchConfigs'];
  validateAgentTeamsMcpRuntime(input: {
    claudePath: string;
    cwd: string;
    shellEnv: NodeJS.ProcessEnv;
    mcpConfigPath: string;
    options: { isCancelled(): boolean };
  }): Promise<void>;
  buildTeamRuntimeLaunchArgsPlan: DeterministicCreateSpawnFlowPorts<TRun>['buildTeamRuntimeLaunchArgsPlan'];
  seedLeadBootstrapPermissionRules: DeterministicCreateSpawnFlowPorts<TRun>['seedLeadBootstrapPermissionRules'];
  spawnCli: DeterministicCreateSpawnFlowPorts<TRun>['spawnCli'];
  updateProgress: DeterministicCreateSpawnFlowPorts<TRun>['updateProgress'];
  attachStdoutHandler: DeterministicCreateSpawnFlowPorts<TRun>['attachStdoutHandler'];
  attachStderrHandler: DeterministicCreateSpawnFlowPorts<TRun>['attachStderrHandler'];
  startStallWatchdog: DeterministicCreateSpawnFlowPorts<TRun>['startStallWatchdog'];
  startFilesystemMonitor: DeterministicCreateSpawnFlowPorts<TRun>['startFilesystemMonitor'];
  tryCompleteAfterTimeout: DeterministicCreateSpawnFlowPorts<TRun>['tryCompleteAfterTimeout'];
  handleProcessExit: DeterministicCreateSpawnFlowPorts<TRun>['handleProcessExit'];
  killTeamProcessAndWait: DeterministicCreateSpawnFlowPorts<TRun>['killTeamProcessAndWait'];
  cleanupRun: DeterministicCreateSpawnFlowPorts<TRun>['cleanupRun'];
  removeRunMemberMcpConfigFiles: DeterministicCreateSpawnFlowPorts<TRun>['removeRunMemberMcpConfigFiles'];
  deleteRun(runId: string): void;
  deleteProvisioningRunByTeam(teamName: string): void;
  getStopAllTeamsGeneration: DeterministicCreateSpawnFlowPorts<TRun>['getStopAllTeamsGeneration'];
}

export interface TeamProvisioningCreateDeterministicSpawnFlowServiceHost<
  TRun extends DeterministicCreateSpawnFlowRun,
> {
  teamMetaStore: DeterministicCreateSpawnFlowTeamMetaStore<TRun>;
  membersMetaStore: DeterministicCreateSpawnFlowPorts<TRun>['membersMetaStore'];
  mcpConfigBuilder: DeterministicCreateSpawnFlowPorts<TRun>['mcpConfigBuilder'];
  outputRecoveryFacade: Pick<
    TeamProvisioningCreateDeterministicSpawnFlowBoundaryDeps<TRun>,
    'attachStdoutHandler' | 'attachStderrHandler' | 'startStallWatchdog'
  >;
  runs: Map<string, TRun>;
  provisioningRunByTeam: Map<string, string>;
  stopAllTeamsGeneration: number;
  buildRuntimeBootstrapMemberMcpLaunchConfigs: TeamProvisioningCreateDeterministicSpawnFlowBoundaryDeps<TRun>['buildMemberMcpLaunchConfigs'];
  validateAgentTeamsMcpRuntime(
    claudePath: string,
    cwd: string,
    shellEnv: NodeJS.ProcessEnv,
    mcpConfigPath: string,
    options: { isCancelled(): boolean }
  ): Promise<void>;
  buildTeamRuntimeLaunchArgsPlan: TeamProvisioningCreateDeterministicSpawnFlowBoundaryDeps<TRun>['buildTeamRuntimeLaunchArgsPlan'];
  seedLeadBootstrapPermissionRules: TeamProvisioningCreateDeterministicSpawnFlowBoundaryDeps<TRun>['seedLeadBootstrapPermissionRules'];
  startFilesystemMonitor: TeamProvisioningCreateDeterministicSpawnFlowBoundaryDeps<TRun>['startFilesystemMonitor'];
  tryCompleteAfterTimeout: TeamProvisioningCreateDeterministicSpawnFlowBoundaryDeps<TRun>['tryCompleteAfterTimeout'];
  handleProcessExit: TeamProvisioningCreateDeterministicSpawnFlowBoundaryDeps<TRun>['handleProcessExit'];
  cleanupRun: TeamProvisioningCreateDeterministicSpawnFlowBoundaryDeps<TRun>['cleanupRun'];
  removeRunMemberMcpConfigFiles: TeamProvisioningCreateDeterministicSpawnFlowBoundaryDeps<TRun>['removeRunMemberMcpConfigFiles'];
}

export interface TeamProvisioningCreateDeterministicSpawnFlowServiceHostOptions<
  TRun extends DeterministicCreateSpawnFlowRun,
> {
  spawnCli: TeamProvisioningCreateDeterministicSpawnFlowBoundaryDeps<TRun>['spawnCli'];
  updateProgress: TeamProvisioningCreateDeterministicSpawnFlowBoundaryDeps<TRun>['updateProgress'];
  killTeamProcessAndWait: TeamProvisioningCreateDeterministicSpawnFlowBoundaryDeps<TRun>['killTeamProcessAndWait'];
}

export interface TeamProvisioningCreateDeterministicSpawnFlowBoundary<
  TRun extends DeterministicCreateSpawnFlowRun,
> {
  createSpawnFlowPorts(
    input: TeamProvisioningCreateDeterministicSpawnFlowBoundaryInput
  ): DeterministicCreateSpawnFlowPorts<TRun>;
}

export function createTeamProvisioningCreateDeterministicSpawnFlowDepsFromService<
  TRun extends DeterministicCreateSpawnFlowRun,
>(
  service: TeamProvisioningCreateDeterministicSpawnFlowServiceHost<TRun>,
  options: TeamProvisioningCreateDeterministicSpawnFlowServiceHostOptions<TRun>
): TeamProvisioningCreateDeterministicSpawnFlowBoundaryDeps<TRun> {
  return {
    teamMetaStore: {
      writeMeta: (teamName, payload) =>
        service.teamMetaStore.writeMeta(teamName, {
          ...payload,
          launchIdentity: payload.launchIdentity ?? undefined,
        } as unknown as Parameters<typeof service.teamMetaStore.writeMeta>[1]),
      deleteMeta: (teamName) => service.teamMetaStore.deleteMeta(teamName),
    },
    membersMetaStore: service.membersMetaStore,
    mcpConfigBuilder: service.mcpConfigBuilder,
    buildMemberMcpLaunchConfigs: (input) =>
      service.buildRuntimeBootstrapMemberMcpLaunchConfigs(input),
    validateAgentTeamsMcpRuntime: ({ claudePath, cwd, shellEnv, mcpConfigPath, options }) =>
      service.validateAgentTeamsMcpRuntime(claudePath, cwd, shellEnv, mcpConfigPath, options),
    buildTeamRuntimeLaunchArgsPlan: (input) => service.buildTeamRuntimeLaunchArgsPlan(input),
    seedLeadBootstrapPermissionRules: (teamName, cwd) =>
      service.seedLeadBootstrapPermissionRules(teamName, cwd),
    spawnCli: options.spawnCli,
    updateProgress: options.updateProgress,
    attachStdoutHandler: (run) => service.outputRecoveryFacade.attachStdoutHandler(run),
    attachStderrHandler: (run) => service.outputRecoveryFacade.attachStderrHandler(run),
    startStallWatchdog: (run) => service.outputRecoveryFacade.startStallWatchdog(run),
    startFilesystemMonitor: (run, request) => service.startFilesystemMonitor(run, request),
    tryCompleteAfterTimeout: (run) => service.tryCompleteAfterTimeout(run),
    handleProcessExit: (run, code) => service.handleProcessExit(run, code),
    killTeamProcessAndWait: options.killTeamProcessAndWait,
    cleanupRun: (run) => service.cleanupRun(run),
    removeRunMemberMcpConfigFiles: (run) => service.removeRunMemberMcpConfigFiles(run),
    deleteRun: (runId) => {
      service.runs.delete(runId);
    },
    deleteProvisioningRunByTeam: (teamName) => {
      service.provisioningRunByTeam.delete(teamName);
    },
    getStopAllTeamsGeneration: () => service.stopAllTeamsGeneration,
  };
}

export function createTeamProvisioningCreateDeterministicSpawnFlowBoundary<
  TRun extends DeterministicCreateSpawnFlowRun,
>(
  deps: TeamProvisioningCreateDeterministicSpawnFlowBoundaryDeps<TRun>
): TeamProvisioningCreateDeterministicSpawnFlowBoundary<TRun> {
  return {
    createSpawnFlowPorts: ({ request, claudePath, shellEnv }) => ({
      teamMetaStore: deps.teamMetaStore,
      membersMetaStore: deps.membersMetaStore,
      mcpConfigBuilder: deps.mcpConfigBuilder,
      buildMemberMcpLaunchConfigs: (buildInput) => deps.buildMemberMcpLaunchConfigs(buildInput),
      validateAgentTeamsMcpRuntime: (mcpConfigPath, options) =>
        deps.validateAgentTeamsMcpRuntime({
          claudePath,
          cwd: request.cwd,
          shellEnv,
          mcpConfigPath,
          options,
        }),
      buildTeamRuntimeLaunchArgsPlan: (buildInput) =>
        deps.buildTeamRuntimeLaunchArgsPlan(buildInput),
      seedLeadBootstrapPermissionRules: (teamName, cwd) =>
        deps.seedLeadBootstrapPermissionRules(teamName, cwd),
      spawnCli: deps.spawnCli,
      updateProgress: deps.updateProgress,
      attachStdoutHandler: (run) => deps.attachStdoutHandler(run),
      attachStderrHandler: (run) => deps.attachStderrHandler(run),
      startStallWatchdog: (run) => deps.startStallWatchdog(run),
      startFilesystemMonitor: (run, targetRequest) =>
        deps.startFilesystemMonitor(run, targetRequest),
      tryCompleteAfterTimeout: (run) => deps.tryCompleteAfterTimeout(run),
      handleProcessExit: (run, code) => deps.handleProcessExit(run, code),
      killTeamProcessAndWait: (child) => deps.killTeamProcessAndWait(child),
      cleanupRun: (run) => deps.cleanupRun(run),
      removeRunMemberMcpConfigFiles: (run) => deps.removeRunMemberMcpConfigFiles(run),
      unregisterRun: (runId, teamName) => {
        deps.deleteRun(runId);
        deps.deleteProvisioningRunByTeam(teamName);
      },
      getStopAllTeamsGeneration: () => deps.getStopAllTeamsGeneration(),
    }),
  };
}
