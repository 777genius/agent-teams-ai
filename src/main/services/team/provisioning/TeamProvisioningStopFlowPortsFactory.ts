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

type PersistentRuntimeCleanupPort<TRun extends TeamProvisioningStopRun> = Pick<
  TeamProvisioningStopTeamPorts<TRun>,
  'stopPersistentTeamMembers' | 'cleanupAnthropicApiKeyHelperMaterialForStoppedTeam'
>;

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
  persistentRuntimeCleanup: PersistentRuntimeCleanupPort<TRun>;
  openCodeRuntimeDeliveryAdvisory: TeamProvisioningStopTeamPorts<TRun>['openCodeRuntimeDeliveryAdvisory'];
  isCancellableRuntimeAdapterProgress: TeamProvisioningStopTeamPorts<TRun>['isCancellableRuntimeAdapterProgress'];
  cancelRuntimeAdapterProvisioning: TeamProvisioningStopTeamPorts<TRun>['cancelRuntimeAdapterProvisioning'];
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

export interface TeamProvisioningStopFlowServiceHost<TRun extends TeamProvisioningStopRun> {
  getSecondaryRuntimeRuns: TeamProvisioningStopFlowFactoryDeps<TRun>['getSecondaryRuntimeRuns'];
  stoppingSecondaryRuntimeTeams: TeamProvisioningStopFlowFactoryDeps<TRun>['stoppingSecondaryRuntimeTeams'];
  appShellBoundary: {
    getOpenCodeRuntimeAdapter: TeamProvisioningStopFlowFactoryDeps<TRun>['getOpenCodeRuntimeAdapter'];
  };
  launchStateStore: {
    read: TeamProvisioningStopFlowFactoryDeps<TRun>['readLaunchState'];
  };
  writeLaunchStateSnapshot: TeamProvisioningStopFlowFactoryDeps<TRun>['writeLaunchStateSnapshot'];
  readPersistedTeamProjectPath: TeamProvisioningStopFlowFactoryDeps<TRun>['readPersistedTeamProjectPath'];
  deleteSecondaryRuntimeRun: TeamProvisioningStopFlowFactoryDeps<TRun>['deleteSecondaryRuntimeRun'];
  clearSecondaryRuntimeRuns: TeamProvisioningStopFlowFactoryDeps<TRun>['clearSecondaryRuntimeRuns'];
  runtimeAdapterRunByTeam: TeamProvisioningStopFlowFactoryDeps<TRun>['runtimeAdapterRunByTeam'];
  runtimeAdapterProgressByRunId: TeamProvisioningStopFlowFactoryDeps<TRun>['runtimeAdapterProgressByRunId'];
  runtimeAdapterProgressState: {
    setRuntimeAdapterProgress: TeamProvisioningStopFlowFactoryDeps<TRun>['setRuntimeAdapterProgress'];
  };
  toolApprovalFacade: {
    clearOpenCodeRuntimeToolApprovals: TeamProvisioningStopFlowFactoryDeps<TRun>['clearOpenCodeRuntimeToolApprovals'];
  };
  runTracking: Pick<
    TeamProvisioningStopFlowFactoryDeps<TRun>,
    'getTrackedRunId' | 'getAliveRunId' | 'deleteAliveRunId'
  >;
  runs: TeamProvisioningStopFlowFactoryDeps<TRun>['runs'];
  provisioningRunByTeam: TeamProvisioningStopFlowFactoryDeps<TRun>['provisioningRunByTeam'];
  invalidateRuntimeSnapshotCaches: TeamProvisioningStopFlowFactoryDeps<TRun>['invalidateRuntimeSnapshotCaches'];
  taskActivityIntervalService: {
    pauseActiveIntervalsForTeam: TeamProvisioningStopFlowFactoryDeps<TRun>['pauseActiveIntervalsForTeam'];
  };
  persistentRuntimeCleanup: TeamProvisioningStopFlowFactoryDeps<TRun>['persistentRuntimeCleanup'];
  openCodeRuntimeDeliveryAdvisory: TeamProvisioningStopFlowFactoryDeps<TRun>['openCodeRuntimeDeliveryAdvisory'];
  cancellationBoundary: Pick<
    TeamProvisioningStopFlowFactoryDeps<TRun>,
    'isCancellableRuntimeAdapterProgress' | 'cancelRuntimeAdapterProvisioning'
  >;
  withTeamLock: TeamProvisioningStopFlowFactoryDeps<TRun>['withTeamLock'];
  hasSecondaryRuntimeRuns: TeamProvisioningStopFlowFactoryDeps<TRun>['hasSecondaryRuntimeRuns'];
  cleanupRun: TeamProvisioningStopFlowFactoryDeps<TRun>['cleanupRun'];
  teamChangeEmitter?: TeamProvisioningStopFlowFactoryDeps<TRun>['emitTeamChange'];
}

export interface TeamProvisioningStopFlowServiceHostOptions<TRun extends TeamProvisioningStopRun> {
  getTeamsBasePath: TeamProvisioningStopFlowFactoryDeps<TRun>['getTeamsBasePath'];
  clearOpenCodeRuntimeLaneStorage: TeamProvisioningStopFlowFactoryDeps<TRun>['clearOpenCodeRuntimeLaneStorage'];
  killTeamProcess: TeamProvisioningStopFlowFactoryDeps<TRun>['killTeamProcess'];
  updateProgress: TeamProvisioningStopFlowFactoryDeps<TRun>['updateProgress'];
  logger: TeamProvisioningStopFlowFactoryDeps<TRun>['logger'];
  nowIso: TeamProvisioningStopFlowFactoryDeps<TRun>['nowIso'];
}

export function createTeamProvisioningStopFlowDepsFromService<TRun extends TeamProvisioningStopRun>(
  service: TeamProvisioningStopFlowServiceHost<TRun>,
  options: TeamProvisioningStopFlowServiceHostOptions<TRun>
): TeamProvisioningStopFlowFactoryDeps<TRun> {
  return {
    getTeamsBasePath: options.getTeamsBasePath,
    getSecondaryRuntimeRuns: (teamName) => service.getSecondaryRuntimeRuns(teamName),
    stoppingSecondaryRuntimeTeams: service.stoppingSecondaryRuntimeTeams,
    getOpenCodeRuntimeAdapter: () => service.appShellBoundary.getOpenCodeRuntimeAdapter(),
    readLaunchState: (teamName) => service.launchStateStore.read(teamName),
    writeLaunchStateSnapshot: (teamName, snapshot) =>
      service.writeLaunchStateSnapshot(teamName, snapshot),
    readPersistedTeamProjectPath: (teamName) => service.readPersistedTeamProjectPath(teamName),
    clearOpenCodeRuntimeLaneStorage: options.clearOpenCodeRuntimeLaneStorage,
    deleteSecondaryRuntimeRun: (teamName, laneId) =>
      service.deleteSecondaryRuntimeRun(teamName, laneId),
    clearSecondaryRuntimeRuns: (teamName) => service.clearSecondaryRuntimeRuns(teamName),
    runtimeAdapterRunByTeam: service.runtimeAdapterRunByTeam,
    runtimeAdapterProgressByRunId: service.runtimeAdapterProgressByRunId,
    setRuntimeAdapterProgress: (progress) =>
      service.runtimeAdapterProgressState.setRuntimeAdapterProgress(progress),
    clearOpenCodeRuntimeToolApprovals: (teamName, approvalOptions) =>
      service.toolApprovalFacade.clearOpenCodeRuntimeToolApprovals(teamName, approvalOptions),
    getTrackedRunId: (teamName) => service.runTracking.getTrackedRunId(teamName),
    getAliveRunId: (teamName) => service.runTracking.getAliveRunId(teamName),
    deleteAliveRunId: (teamName) => service.runTracking.deleteAliveRunId(teamName),
    runs: service.runs,
    provisioningRunByTeam: service.provisioningRunByTeam,
    invalidateRuntimeSnapshotCaches: (teamName) =>
      service.invalidateRuntimeSnapshotCaches(teamName),
    pauseActiveIntervalsForTeam: (teamName) =>
      service.taskActivityIntervalService.pauseActiveIntervalsForTeam(teamName),
    persistentRuntimeCleanup: service.persistentRuntimeCleanup,
    openCodeRuntimeDeliveryAdvisory: service.openCodeRuntimeDeliveryAdvisory,
    isCancellableRuntimeAdapterProgress: (progress) =>
      service.cancellationBoundary.isCancellableRuntimeAdapterProgress(progress),
    cancelRuntimeAdapterProvisioning: (runId, progress) =>
      service.cancellationBoundary.cancelRuntimeAdapterProvisioning(runId, progress),
    withTeamLock: (teamName, fn) => service.withTeamLock(teamName, fn),
    hasSecondaryRuntimeRuns: (teamName) => service.hasSecondaryRuntimeRuns(teamName),
    killTeamProcess: (child) => options.killTeamProcess(child),
    updateProgress: (run, state, message) => options.updateProgress(run, state, message),
    cleanupRun: (run) => service.cleanupRun(run),
    emitTeamChange: (event) => service.teamChangeEmitter?.(event),
    logger: options.logger,
    nowIso: options.nowIso,
  };
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
    getAliveRunId: (teamName) => deps.getAliveRunId(teamName),
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
    stopPersistentTeamMembers: (teamName) =>
      deps.persistentRuntimeCleanup.stopPersistentTeamMembers(teamName),
    openCodeRuntimeDeliveryAdvisory: deps.openCodeRuntimeDeliveryAdvisory,
    getTrackedRunId: (teamName) => deps.getTrackedRunId(teamName),
    getAliveRunId: (teamName) => deps.getAliveRunId(teamName),
    runs: deps.runs,
    runtimeAdapterProgressByRunId: deps.runtimeAdapterProgressByRunId,
    isCancellableRuntimeAdapterProgress: (progress) =>
      deps.isCancellableRuntimeAdapterProgress(progress),
    cancelRuntimeAdapterProvisioning: (runId, progress) =>
      deps.cancelRuntimeAdapterProvisioning(runId, progress),
    cleanupAnthropicApiKeyHelperMaterialForStoppedTeam: (teamName) =>
      deps.persistentRuntimeCleanup.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName),
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
