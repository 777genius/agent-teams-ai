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
  killTeamProcess: DeterministicCreateSpawnFlowPorts<TRun>['killTeamProcess'];
  cleanupRun: DeterministicCreateSpawnFlowPorts<TRun>['cleanupRun'];
  removeRunMemberMcpConfigFiles: DeterministicCreateSpawnFlowPorts<TRun>['removeRunMemberMcpConfigFiles'];
  deleteRun(runId: string): void;
  deleteProvisioningRunByTeam(teamName: string): void;
  getStopAllTeamsGeneration: DeterministicCreateSpawnFlowPorts<TRun>['getStopAllTeamsGeneration'];
}

export interface TeamProvisioningCreateDeterministicSpawnFlowBoundary<
  TRun extends DeterministicCreateSpawnFlowRun,
> {
  createSpawnFlowPorts(
    input: TeamProvisioningCreateDeterministicSpawnFlowBoundaryInput
  ): DeterministicCreateSpawnFlowPorts<TRun>;
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
      killTeamProcess: (child) => deps.killTeamProcess(child),
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
