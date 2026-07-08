import {
  buildIncompleteLaunchCleanupReason,
  shouldFinalizeIncompleteLaunchState,
  type TeamProvisioningCleanupPorts,
  type TeamProvisioningCleanupRun,
} from './TeamProvisioningCleanup';
import {
  buildRetainedClaudeLogsSnapshot,
  type RetainedLogsRunLike,
} from './TeamProvisioningRetainedLogs';

export type TeamProvisioningCleanupRunPortsFactoryRun = TeamProvisioningCleanupRun &
  RetainedLogsRunLike;

export type TeamProvisioningCleanupRunPortsFactoryDeps<
  TRun extends TeamProvisioningCleanupRunPortsFactoryRun,
> = Omit<
  TeamProvisioningCleanupPorts<TRun>,
  | 'buildRetainedClaudeLogsSnapshot'
  | 'shouldFinalizeIncompleteLaunchState'
  | 'buildIncompleteLaunchCleanupReason'
>;

type CleanupRunPortsFactoryDeps<TRun extends TeamProvisioningCleanupRunPortsFactoryRun> =
  TeamProvisioningCleanupRunPortsFactoryDeps<TRun>;

export interface TeamProvisioningCleanupRunServiceHost<
  TRun extends TeamProvisioningCleanupRunPortsFactoryRun,
> {
  runTracking: {
    getTrackedRunId(teamName: string): string | null;
    deleteAliveRunId(teamName: string): void;
  };
  runs: CleanupRunPortsFactoryDeps<TRun>['runs'] & { has(runId: string): boolean };
  runtimeAdapterProgressByRunId: { has(runId: string): boolean };
  markIncompleteLaunchStateFinalized: CleanupRunPortsFactoryDeps<TRun>['markIncompleteLaunchStateFinalized'];
  persistLaunchStateSnapshot: CleanupRunPortsFactoryDeps<TRun>['persistLaunchStateSnapshot'];
  configTaskActivityBoundary: {
    writeLaunchFailureArtifactPackBestEffort: CleanupRunPortsFactoryDeps<TRun>['writeLaunchFailureArtifactPackBestEffort'];
  };
  resetRuntimeToolActivity: CleanupRunPortsFactoryDeps<TRun>['resetRuntimeToolActivity'];
  setLeadActivity: CleanupRunPortsFactoryDeps<TRun>['setLeadActivity'];
  outputRecoveryFacade: {
    stopStallWatchdog: CleanupRunPortsFactoryDeps<TRun>['stopStallWatchdog'];
  };
  stopFilesystemMonitor: CleanupRunPortsFactoryDeps<TRun>['stopFilesystemMonitor'];
  provisioningRunByTeam: CleanupRunPortsFactoryDeps<TRun>['provisioningRunByTeam'];
  aliveRunByTeam: CleanupRunPortsFactoryDeps<TRun>['aliveRunByTeam'];
  clearSecondaryRuntimeRuns: CleanupRunPortsFactoryDeps<TRun>['clearSecondaryRuntimeRuns'];
  invalidateRuntimeSnapshotCaches: CleanupRunPortsFactoryDeps<TRun>['invalidateRuntimeSnapshotCaches'];
  invalidateMemberSpawnStatusesCache: CleanupRunPortsFactoryDeps<TRun>['invalidateMemberSpawnStatusesCache'];
  leadInboxRelayInFlight: CleanupRunPortsFactoryDeps<TRun>['leadInboxRelayInFlight'];
  relayedLeadInboxMessageIds: CleanupRunPortsFactoryDeps<TRun>['relayedLeadInboxMessageIds'];
  pendingCrossTeamFirstReplies: CleanupRunPortsFactoryDeps<TRun>['pendingCrossTeamFirstReplies'];
  recentCrossTeamLeadDeliveryMessageIds: CleanupRunPortsFactoryDeps<TRun>['recentCrossTeamLeadDeliveryMessageIds'];
  sameTeamNativeDelivery: CleanupRunPortsFactoryDeps<TRun>['recentSameTeamNativeFingerprints'];
  clearSameTeamRetryTimers: CleanupRunPortsFactoryDeps<TRun>['clearSameTeamRetryTimers'];
  clearLeadInboxFollowUpRelayTimer: CleanupRunPortsFactoryDeps<TRun>['clearLeadInboxFollowUpRelayTimer'];
  getMemberLaunchGraceKey: CleanupRunPortsFactoryDeps<TRun>['getMemberLaunchGraceKey'];
  pendingTimeouts: CleanupRunPortsFactoryDeps<TRun>['pendingTimeouts'];
  memberInboxRelayInFlight: CleanupRunPortsFactoryDeps<TRun>['memberInboxRelayInFlight'];
  openCodeMemberInboxRelayInFlight: CleanupRunPortsFactoryDeps<TRun>['openCodeMemberInboxRelayInFlight'];
  openCodeMemberSendInFlightByLane: CleanupRunPortsFactoryDeps<TRun>['openCodeMemberSendInFlightByLane'];
  openCodePromptDeliveryWatchdogScheduler: CleanupRunPortsFactoryDeps<TRun>['openCodePromptDeliveryWatchdogScheduler'];
  openCodeRuntimeDeliveryAdvisory: CleanupRunPortsFactoryDeps<TRun>['openCodeRuntimeDeliveryAdvisory'];
  relayedMemberInboxMessageIds: CleanupRunPortsFactoryDeps<TRun>['relayedMemberInboxMessageIds'];
  liveLeadProcessMessages: CleanupRunPortsFactoryDeps<TRun>['liveLeadProcessMessages'];
  pruneLiveLeadMessagesForCleanedRun: CleanupRunPortsFactoryDeps<TRun>['pruneLiveLeadMessagesForCleanedRun'];
  toolApprovalFacade: {
    clearApprovalTimeout: CleanupRunPortsFactoryDeps<TRun>['clearApprovalTimeout'];
    inFlightResponsesForCleanup: CleanupRunPortsFactoryDeps<TRun>['inFlightResponses'];
    dismissApprovalNotification: CleanupRunPortsFactoryDeps<TRun>['dismissApprovalNotification'];
    emitToolApprovalEvent: CleanupRunPortsFactoryDeps<TRun>['emitToolApprovalEvent'];
  };
  mcpConfigBuilder: CleanupRunPortsFactoryDeps<TRun>['mcpConfigBuilder'];
  removeRunMemberMcpConfigFilesLater: CleanupRunPortsFactoryDeps<TRun>['removeRunMemberMcpConfigFilesLater'];
  retainedClaudeLogsByTeam: CleanupRunPortsFactoryDeps<TRun>['retainedClaudeLogsByTeam'];
  retainProvisioningProgress: CleanupRunPortsFactoryDeps<TRun>['retainProvisioningProgress'];
}

export function createTeamProvisioningCleanupRunPortsDepsFromService<
  TRun extends TeamProvisioningCleanupRunPortsFactoryRun,
>(
  service: TeamProvisioningCleanupRunServiceHost<TRun>
): TeamProvisioningCleanupRunPortsFactoryDeps<TRun> {
  return {
    getTrackedRunId: (teamName) => service.runTracking.getTrackedRunId(teamName),
    isRunIdTracked: (runId) =>
      service.runs.has(runId) || service.runtimeAdapterProgressByRunId.has(runId),
    markIncompleteLaunchStateFinalized: (run, cleanupReason) =>
      service.markIncompleteLaunchStateFinalized(run, cleanupReason),
    persistLaunchStateSnapshot: (run, phase) => service.persistLaunchStateSnapshot(run, phase),
    writeLaunchFailureArtifactPackBestEffort: (run, options) =>
      service.configTaskActivityBoundary.writeLaunchFailureArtifactPackBestEffort(run, options),
    resetRuntimeToolActivity: (run) => service.resetRuntimeToolActivity(run),
    setLeadActivity: (run, state) => service.setLeadActivity(run, state),
    stopStallWatchdog: (run) => service.outputRecoveryFacade.stopStallWatchdog(run),
    stopFilesystemMonitor: (run) => service.stopFilesystemMonitor(run),
    provisioningRunByTeam: service.provisioningRunByTeam,
    aliveRunByTeam: service.aliveRunByTeam,
    deleteAliveRunId: (teamName) => service.runTracking.deleteAliveRunId(teamName),
    clearSecondaryRuntimeRuns: (teamName) => service.clearSecondaryRuntimeRuns(teamName),
    invalidateRuntimeSnapshotCaches: (teamName) =>
      service.invalidateRuntimeSnapshotCaches(teamName),
    invalidateMemberSpawnStatusesCache: (teamName) =>
      service.invalidateMemberSpawnStatusesCache(teamName),
    leadInboxRelayInFlight: service.leadInboxRelayInFlight,
    relayedLeadInboxMessageIds: service.relayedLeadInboxMessageIds,
    pendingCrossTeamFirstReplies: service.pendingCrossTeamFirstReplies,
    recentCrossTeamLeadDeliveryMessageIds: service.recentCrossTeamLeadDeliveryMessageIds,
    recentSameTeamNativeFingerprints: service.sameTeamNativeDelivery,
    clearSameTeamRetryTimers: (teamName) => service.clearSameTeamRetryTimers(teamName),
    clearLeadInboxFollowUpRelayTimer: (teamName) =>
      service.clearLeadInboxFollowUpRelayTimer(teamName),
    getMemberLaunchGraceKey: (run, memberName) => service.getMemberLaunchGraceKey(run, memberName),
    pendingTimeouts: service.pendingTimeouts,
    memberInboxRelayInFlight: service.memberInboxRelayInFlight,
    openCodeMemberInboxRelayInFlight: service.openCodeMemberInboxRelayInFlight,
    openCodeMemberSendInFlightByLane: service.openCodeMemberSendInFlightByLane,
    openCodePromptDeliveryWatchdogScheduler: service.openCodePromptDeliveryWatchdogScheduler,
    openCodeRuntimeDeliveryAdvisory: service.openCodeRuntimeDeliveryAdvisory,
    relayedMemberInboxMessageIds: service.relayedMemberInboxMessageIds,
    liveLeadProcessMessages: service.liveLeadProcessMessages,
    pruneLiveLeadMessagesForCleanedRun: (run) => service.pruneLiveLeadMessagesForCleanedRun(run),
    clearApprovalTimeout: (requestId) => service.toolApprovalFacade.clearApprovalTimeout(requestId),
    inFlightResponses: service.toolApprovalFacade.inFlightResponsesForCleanup,
    dismissApprovalNotification: (requestId) =>
      service.toolApprovalFacade.dismissApprovalNotification(requestId),
    emitToolApprovalEvent: (event) => service.toolApprovalFacade.emitToolApprovalEvent(event),
    mcpConfigBuilder: service.mcpConfigBuilder,
    removeRunMemberMcpConfigFilesLater: (run) => service.removeRunMemberMcpConfigFilesLater(run),
    retainedClaudeLogsByTeam: service.retainedClaudeLogsByTeam,
    retainProvisioningProgress: (runId, progress) =>
      service.retainProvisioningProgress(runId, progress),
    runs: service.runs,
  };
}

export function createTeamProvisioningCleanupRunPorts<
  TRun extends TeamProvisioningCleanupRunPortsFactoryRun,
>(deps: TeamProvisioningCleanupRunPortsFactoryDeps<TRun>): TeamProvisioningCleanupPorts<TRun> {
  return {
    ...deps,
    buildRetainedClaudeLogsSnapshot,
    shouldFinalizeIncompleteLaunchState,
    buildIncompleteLaunchCleanupReason,
  };
}
