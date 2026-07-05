import { killProcessTree } from '@main/utils/childProcess';

import {
  getPreCompleteCliErrorTextFromRun,
  type PreCompleteCliErrorRunLike,
} from './TeamProvisioningLeadRunDerivation';
import { getFailedSpawnMembersFromStatuses } from './TeamProvisioningMemberStatusProjection';
import { hasApiError, isAuthFailureWarning } from './TeamProvisioningOutputErrorPolicy';
import { extractCliLogsFromRun, type RetainedLogsRunLike } from './TeamProvisioningRetainedLogs';

import type {
  TeamProvisioningTurnCompletePorts,
  TeamProvisioningTurnCompleteRun,
} from './TeamProvisioningTurnComplete';
import type { MemberSpawnStatusEntry } from '@shared/types';

export type TeamProvisioningTurnCompletePortsFactoryRun = TeamProvisioningTurnCompleteRun &
  RetainedLogsRunLike &
  PreCompleteCliErrorRunLike & {
    memberSpawnStatuses?: Map<string, MemberSpawnStatusEntry>;
  };

export type TeamProvisioningTurnCompleteOutputRecoveryAdapter<
  TRun extends TeamProvisioningTurnCompletePortsFactoryRun,
  TSecondaryLaunchResult,
> = Pick<
  TeamProvisioningTurnCompletePorts<TRun, TSecondaryLaunchResult>,
  'failProvisioningWithApiError' | 'handleAuthFailureInOutput' | 'stopStallWatchdog'
>;

type ServicePortKey =
  | 'hasPendingDeterministicFirstRealTurn'
  | 'isProvisioningRunStillPromotable'
  | 'scheduleDeterministicBootstrapCompletionRecovery'
  | 'resetRuntimeToolActivity'
  | 'getRunLeadName'
  | 'setLeadActivity'
  | 'stopFilesystemMonitor'
  | 'refreshMemberSpawnStatusesFromLeadInbox'
  | 'maybeAuditMemberSpawnStatuses'
  | 'finalizeMissingRegisteredMembersAsFailed'
  | 'launchMixedSecondaryLaneIfNeeded'
  | 'reconcileFinalLaunchReportingSnapshot'
  | 'getMemberLaunchSummary'
  | 'hasPendingLaunchMembers'
  | 'isProvisioningRunPromotedToAlive'
  | 'buildAggregatePendingLaunchMessage'
  | 'fireTeamLaunchedNotification'
  | 'fireTeamLaunchIncompleteNotification'
  | 'sendMessageToRun'
  | 'relayLeadInboxMessages'
  | 'injectGeminiPostLaunchHydration'
  | 'waitForValidConfig'
  | 'writeLaunchFailureArtifactPackBestEffort'
  | 'cleanupRun';

export type TeamProvisioningTurnCompleteServiceAdapter<
  TRun extends TeamProvisioningTurnCompletePortsFactoryRun,
  TSecondaryLaunchResult,
> = Pick<TeamProvisioningTurnCompletePorts<TRun, TSecondaryLaunchResult>, ServicePortKey>;

export interface TeamProvisioningTurnCompletePortsFactoryDeps<
  TRun extends TeamProvisioningTurnCompletePortsFactoryRun,
  TSecondaryLaunchResult,
> {
  service: TeamProvisioningTurnCompleteServiceAdapter<TRun, TSecondaryLaunchResult>;
  outputRecovery: TeamProvisioningTurnCompleteOutputRecoveryAdapter<TRun, TSecondaryLaunchResult>;
  config: Pick<
    TeamProvisioningTurnCompletePorts<TRun, TSecondaryLaunchResult>,
    'updateConfigPostLaunch' | 'cleanupPrelaunchBackup' | 'persistMembersMeta'
  >;
  updateProgress: TeamProvisioningTurnCompletePorts<TRun, TSecondaryLaunchResult>['updateProgress'];
  provisioningRunByTeam: TeamProvisioningTurnCompletePorts<
    TRun,
    TSecondaryLaunchResult
  >['provisioningRunByTeam'];
  setAliveRunId: TeamProvisioningTurnCompletePorts<TRun, TSecondaryLaunchResult>['setAliveRunId'];
  emitTeamChange: TeamProvisioningTurnCompletePorts<TRun, TSecondaryLaunchResult>['emitTeamChange'];
  killTeamProcess?: TeamProvisioningTurnCompletePorts<
    TRun,
    TSecondaryLaunchResult
  >['killTeamProcess'];
}

/**
 * Kill a team CLI process using SIGKILL (uncatchable).
 *
 * Newer Claude CLI versions handle SIGTERM gracefully and run cleanup that
 * deletes team files. SIGKILL preserves the existing provisioning behavior.
 */
function defaultKillTeamProcess(
  child: Parameters<
    TeamProvisioningTurnCompletePorts<
      TeamProvisioningTurnCompletePortsFactoryRun,
      unknown
    >['killTeamProcess']
  >[0]
): void {
  killProcessTree(child, 'SIGKILL');
}

export function createTeamProvisioningTurnCompletePorts<
  TRun extends TeamProvisioningTurnCompletePortsFactoryRun,
  TSecondaryLaunchResult,
>(
  deps: TeamProvisioningTurnCompletePortsFactoryDeps<TRun, TSecondaryLaunchResult>
): TeamProvisioningTurnCompletePorts<TRun, TSecondaryLaunchResult> {
  return {
    hasPendingDeterministicFirstRealTurn: (run) =>
      deps.service.hasPendingDeterministicFirstRealTurn(run),
    isProvisioningRunStillPromotable: (run) => deps.service.isProvisioningRunStillPromotable(run),
    getPreCompleteCliErrorText: getPreCompleteCliErrorTextFromRun,
    hasApiError,
    isAuthFailureWarning,
    failProvisioningWithApiError: (run, text) =>
      deps.outputRecovery.failProvisioningWithApiError(run, text),
    handleAuthFailureInOutput: (run, text, source) =>
      deps.outputRecovery.handleAuthFailureInOutput(run, text, source),
    scheduleDeterministicBootstrapCompletionRecovery: (run) =>
      deps.service.scheduleDeterministicBootstrapCompletionRecovery(run),
    resetRuntimeToolActivity: (run, memberName) =>
      deps.service.resetRuntimeToolActivity(run, memberName),
    getRunLeadName: (run) => deps.service.getRunLeadName(run),
    setLeadActivity: (run, state) => deps.service.setLeadActivity(run, state),
    stopFilesystemMonitor: (run) => deps.service.stopFilesystemMonitor(run),
    stopStallWatchdog: (run) => deps.outputRecovery.stopStallWatchdog(run),
    updateConfigPostLaunch: (teamName, cwd, detectedSessionId, color, options) =>
      deps.config.updateConfigPostLaunch(teamName, cwd, detectedSessionId, color, options),
    cleanupPrelaunchBackup: (teamName) => deps.config.cleanupPrelaunchBackup(teamName),
    refreshMemberSpawnStatusesFromLeadInbox: (run) =>
      deps.service.refreshMemberSpawnStatusesFromLeadInbox(run),
    maybeAuditMemberSpawnStatuses: (run, options) =>
      deps.service.maybeAuditMemberSpawnStatuses(run, options),
    finalizeMissingRegisteredMembersAsFailed: (run) =>
      deps.service.finalizeMissingRegisteredMembersAsFailed(run),
    launchMixedSecondaryLaneIfNeeded: (run) => deps.service.launchMixedSecondaryLaneIfNeeded(run),
    reconcileFinalLaunchReportingSnapshot: (run, secondaryLaunchResult) =>
      deps.service.reconcileFinalLaunchReportingSnapshot(run, secondaryLaunchResult),
    getFailedSpawnMembers: (run) => getFailedSpawnMembersFromStatuses(run.memberSpawnStatuses),
    getMemberLaunchSummary: (run) => deps.service.getMemberLaunchSummary(run),
    hasPendingLaunchMembers: (run, launchSummary, snapshot) =>
      deps.service.hasPendingLaunchMembers(run, launchSummary, snapshot),
    isProvisioningRunPromotedToAlive: (run) => deps.service.isProvisioningRunPromotedToAlive(run),
    buildAggregatePendingLaunchMessage: (prefix, run, launchSummary, snapshot) =>
      deps.service.buildAggregatePendingLaunchMessage(prefix, run, launchSummary, snapshot),
    updateProgress: (run, state, message, extras) =>
      deps.updateProgress(run, state, message, extras),
    extractCliLogsFromRun,
    provisioningRunByTeam: deps.provisioningRunByTeam,
    setAliveRunId: (teamName, runId) => deps.setAliveRunId(teamName, runId),
    emitTeamChange: (event) => deps.emitTeamChange(event),
    fireTeamLaunchedNotification: (run) => deps.service.fireTeamLaunchedNotification(run),
    fireTeamLaunchIncompleteNotification: (run, failedMembers, launchSummary, snapshot) =>
      deps.service.fireTeamLaunchIncompleteNotification(
        run,
        failedMembers,
        launchSummary,
        snapshot
      ),
    sendMessageToRun: (run, message) => deps.service.sendMessageToRun(run, message),
    relayLeadInboxMessages: (teamName) => deps.service.relayLeadInboxMessages(teamName),
    injectGeminiPostLaunchHydration: (run) => deps.service.injectGeminiPostLaunchHydration(run),
    waitForValidConfig: (run, timeoutMs) => deps.service.waitForValidConfig(run, timeoutMs),
    persistMembersMeta: (teamName, request) => deps.config.persistMembersMeta(teamName, request),
    writeLaunchFailureArtifactPackBestEffort: (run, options) =>
      deps.service.writeLaunchFailureArtifactPackBestEffort(run, options),
    killTeamProcess: deps.killTeamProcess ?? defaultKillTeamProcess,
    cleanupRun: (run) => deps.service.cleanupRun(run),
  };
}
