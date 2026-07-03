import {
  type OpenCodeRuntimeStopFlowPorts,
  stopMixedSecondaryRuntimeLanes,
  stopOpenCodeRuntimeAdapterTeam,
} from './TeamProvisioningOpenCodeRuntimeStopFlow';
import {
  stopTeamFlow,
  type TeamProvisioningStopRun,
  type TeamProvisioningStopTeamPorts,
} from './TeamProvisioningStopFlow';

type RuntimeAdapterRunMap<TRun extends TeamProvisioningStopRun> =
  OpenCodeRuntimeStopFlowPorts['runtimeAdapterRunByTeam'] &
    TeamProvisioningStopTeamPorts<TRun>['runtimeAdapterRunByTeam'];

type RuntimeAdapterProgressMap<TRun extends TeamProvisioningStopRun> =
  OpenCodeRuntimeStopFlowPorts['runtimeAdapterProgressByRunId'] &
    TeamProvisioningStopTeamPorts<TRun>['runtimeAdapterProgressByRunId'];

export interface TeamProvisioningStopFlowFactoryDeps<TRun extends TeamProvisioningStopRun> {
  getTeamsBasePath(): string;
  getSecondaryRuntimeRuns: OpenCodeRuntimeStopFlowPorts['getSecondaryRuntimeRuns'];
  stoppingSecondaryRuntimeTeams: OpenCodeRuntimeStopFlowPorts['stoppingSecondaryRuntimeTeams'];
  getOpenCodeRuntimeAdapter: OpenCodeRuntimeStopFlowPorts['getOpenCodeRuntimeAdapter'];
  readLaunchState: OpenCodeRuntimeStopFlowPorts['readLaunchState'];
  writeLaunchStateSnapshot: OpenCodeRuntimeStopFlowPorts['writeLaunchStateSnapshot'];
  readPersistedTeamProjectPath: OpenCodeRuntimeStopFlowPorts['readPersistedTeamProjectPath'];
  clearOpenCodeRuntimeLaneStorage: OpenCodeRuntimeStopFlowPorts['clearOpenCodeRuntimeLaneStorage'];
  deleteSecondaryRuntimeRun: OpenCodeRuntimeStopFlowPorts['deleteSecondaryRuntimeRun'];
  clearSecondaryRuntimeRuns: OpenCodeRuntimeStopFlowPorts['clearSecondaryRuntimeRuns'];
  runtimeAdapterRunByTeam: RuntimeAdapterRunMap<TRun>;
  runtimeAdapterProgressByRunId: RuntimeAdapterProgressMap<TRun>;
  setRuntimeAdapterProgress: OpenCodeRuntimeStopFlowPorts['setRuntimeAdapterProgress'];
  clearOpenCodeRuntimeToolApprovals: OpenCodeRuntimeStopFlowPorts['clearOpenCodeRuntimeToolApprovals'];
  getTrackedRunId: TeamProvisioningStopTeamPorts<TRun>['getTrackedRunId'];
  getAliveRunId: TeamProvisioningStopTeamPorts<TRun>['getAliveRunId'];
  deleteAliveRunId: OpenCodeRuntimeStopFlowPorts['deleteAliveRunId'];
  runs: TeamProvisioningStopTeamPorts<TRun>['runs'];
  provisioningRunByTeam: TeamProvisioningStopTeamPorts<TRun>['provisioningRunByTeam'];
  invalidateRuntimeSnapshotCaches: OpenCodeRuntimeStopFlowPorts['invalidateRuntimeSnapshotCaches'];
  pauseActiveIntervalsForTeam: TeamProvisioningStopTeamPorts<TRun>['pauseActiveIntervalsForTeam'];
  stopPersistentTeamMembers: TeamProvisioningStopTeamPorts<TRun>['stopPersistentTeamMembers'];
  isCancellableRuntimeAdapterProgress: TeamProvisioningStopTeamPorts<TRun>['isCancellableRuntimeAdapterProgress'];
  cancelRuntimeAdapterProvisioning: TeamProvisioningStopTeamPorts<TRun>['cancelRuntimeAdapterProvisioning'];
  cleanupAnthropicApiKeyHelperMaterialForStoppedTeam: TeamProvisioningStopTeamPorts<TRun>['cleanupAnthropicApiKeyHelperMaterialForStoppedTeam'];
  withTeamLock: TeamProvisioningStopTeamPorts<TRun>['withTeamLock'];
  hasSecondaryRuntimeRuns: TeamProvisioningStopTeamPorts<TRun>['hasSecondaryRuntimeRuns'];
  killTeamProcess: TeamProvisioningStopTeamPorts<TRun>['killTeamProcess'];
  updateProgress: TeamProvisioningStopTeamPorts<TRun>['updateProgress'];
  cleanupRun: TeamProvisioningStopTeamPorts<TRun>['cleanupRun'];
  emitTeamChange: OpenCodeRuntimeStopFlowPorts['emitTeamChange'];
  logger: OpenCodeRuntimeStopFlowPorts['logger'] & TeamProvisioningStopTeamPorts<TRun>['logger'];
  nowIso: OpenCodeRuntimeStopFlowPorts['nowIso'];
}

export interface TeamProvisioningStopFlowBoundary {
  stopTeam(teamName: string): Promise<void>;
  stopMixedSecondaryRuntimeLanes(teamName: string): Promise<void>;
  stopOpenCodeRuntimeAdapterTeam(teamName: string, runId: string): Promise<void>;
}

export function createOpenCodeRuntimeStopFlowPortsFromDeps<TRun extends TeamProvisioningStopRun>(
  deps: TeamProvisioningStopFlowFactoryDeps<TRun>
): OpenCodeRuntimeStopFlowPorts {
  return {
    teamsBasePath: deps.getTeamsBasePath(),
    getSecondaryRuntimeRuns: (teamName) => deps.getSecondaryRuntimeRuns(teamName),
    stoppingSecondaryRuntimeTeams: deps.stoppingSecondaryRuntimeTeams,
    getOpenCodeRuntimeAdapter: () => deps.getOpenCodeRuntimeAdapter(),
    readLaunchState: (teamName) => deps.readLaunchState(teamName),
    writeLaunchStateSnapshot: (teamName, snapshot) =>
      deps.writeLaunchStateSnapshot(teamName, snapshot),
    readPersistedTeamProjectPath: (teamName) => deps.readPersistedTeamProjectPath(teamName),
    clearOpenCodeRuntimeLaneStorage: (input) => deps.clearOpenCodeRuntimeLaneStorage(input),
    deleteSecondaryRuntimeRun: (teamName, laneId) =>
      deps.deleteSecondaryRuntimeRun(teamName, laneId),
    clearSecondaryRuntimeRuns: (teamName) => deps.clearSecondaryRuntimeRuns(teamName),
    runtimeAdapterRunByTeam: deps.runtimeAdapterRunByTeam,
    runtimeAdapterProgressByRunId: deps.runtimeAdapterProgressByRunId,
    setRuntimeAdapterProgress: (progress) => deps.setRuntimeAdapterProgress(progress),
    clearOpenCodeRuntimeToolApprovals: (teamName, options) =>
      deps.clearOpenCodeRuntimeToolApprovals(teamName, options),
    deleteAliveRunId: (teamName) => deps.deleteAliveRunId(teamName),
    provisioningRunByTeam: deps.provisioningRunByTeam,
    invalidateRuntimeSnapshotCaches: (teamName) => deps.invalidateRuntimeSnapshotCaches(teamName),
    emitTeamChange: (event) => deps.emitTeamChange(event),
    logger: deps.logger,
    nowIso: deps.nowIso,
  };
}

export function createTeamProvisioningStopTeamPortsFromDeps<TRun extends TeamProvisioningStopRun>(
  deps: TeamProvisioningStopFlowFactoryDeps<TRun>
): TeamProvisioningStopTeamPorts<TRun> {
  return {
    invalidateRuntimeSnapshotCaches: (teamName) => deps.invalidateRuntimeSnapshotCaches(teamName),
    pauseActiveIntervalsForTeam: (teamName) => deps.pauseActiveIntervalsForTeam(teamName),
    stopPersistentTeamMembers: (teamName) => deps.stopPersistentTeamMembers(teamName),
    getTrackedRunId: (teamName) => deps.getTrackedRunId(teamName),
    getAliveRunId: (teamName) => deps.getAliveRunId(teamName),
    runs: deps.runs,
    runtimeAdapterProgressByRunId: deps.runtimeAdapterProgressByRunId,
    isCancellableRuntimeAdapterProgress: (progress) =>
      deps.isCancellableRuntimeAdapterProgress(progress),
    cancelRuntimeAdapterProvisioning: (runId, progress) =>
      deps.cancelRuntimeAdapterProvisioning(runId, progress),
    cleanupAnthropicApiKeyHelperMaterialForStoppedTeam: (teamName) =>
      deps.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName),
    runtimeAdapterRunByTeam: deps.runtimeAdapterRunByTeam,
    withTeamLock: (teamName, fn) => deps.withTeamLock(teamName, fn),
    stopOpenCodeRuntimeAdapterTeam: (teamName, runId) =>
      stopOpenCodeRuntimeAdapterTeam(
        teamName,
        runId,
        createOpenCodeRuntimeStopFlowPortsFromDeps(deps)
      ),
    hasSecondaryRuntimeRuns: (teamName) => deps.hasSecondaryRuntimeRuns(teamName),
    stopMixedSecondaryRuntimeLanes: (teamName) =>
      stopMixedSecondaryRuntimeLanes(teamName, createOpenCodeRuntimeStopFlowPortsFromDeps(deps)),
    provisioningRunByTeam: deps.provisioningRunByTeam,
    deleteAliveRunId: (teamName) => deps.deleteAliveRunId(teamName),
    killTeamProcess: (child) => deps.killTeamProcess(child),
    updateProgress: (run, state, message) => deps.updateProgress(run, state, message),
    cleanupRun: (run) => deps.cleanupRun(run),
    logger: deps.logger,
  };
}

export function createTeamProvisioningStopFlowBoundary<TRun extends TeamProvisioningStopRun>(
  deps: TeamProvisioningStopFlowFactoryDeps<TRun>
): TeamProvisioningStopFlowBoundary {
  return {
    stopTeam: (teamName) =>
      stopTeamFlow(teamName, createTeamProvisioningStopTeamPortsFromDeps(deps)),
    stopMixedSecondaryRuntimeLanes: (teamName) =>
      stopMixedSecondaryRuntimeLanes(teamName, createOpenCodeRuntimeStopFlowPortsFromDeps(deps)),
    stopOpenCodeRuntimeAdapterTeam: (teamName, runId) =>
      stopOpenCodeRuntimeAdapterTeam(
        teamName,
        runId,
        createOpenCodeRuntimeStopFlowPortsFromDeps(deps)
      ),
  };
}
