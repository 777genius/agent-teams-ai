import {
  type TeamProvisioningProcessExitPorts,
  type TeamProvisioningProcessExitRun,
} from './TeamProvisioningProcessExit';
import { type TeamProvisioningVerificationProbePorts } from './TeamProvisioningVerificationProbePortsFactory';

type ProcessExitServicePortKey =
  | 'buildStdoutCarryDiagnostic'
  | 'flushStdoutParserCarry'
  | 'stopStallWatchdog'
  | 'hasSecondaryRuntimeRuns'
  | 'stopMixedSecondaryRuntimeLanes'
  | 'persistMembersMeta'
  | 'finalizeIncompleteLaunchStateBeforeCleanup'
  | 'cleanupRun';

type ProcessExitVerificationProbePortKey =
  | 'waitForValidConfig'
  | 'waitForTeamInList'
  | 'waitForMissingInboxes';

export type TeamProvisioningProcessExitServiceAdapter<TRun extends TeamProvisioningProcessExitRun> =
  Pick<TeamProvisioningProcessExitPorts<TRun>, ProcessExitServicePortKey>;

export type TeamProvisioningProcessExitVerificationProbeAdapter<
  TRun extends TeamProvisioningProcessExitRun,
> = Pick<TeamProvisioningVerificationProbePorts<TRun>, ProcessExitVerificationProbePortKey>;

export interface TeamProvisioningProcessExitPortsFactoryDeps<
  TRun extends TeamProvisioningProcessExitRun,
> {
  service: TeamProvisioningProcessExitServiceAdapter<TRun>;
  verificationProbePorts: TeamProvisioningProcessExitVerificationProbeAdapter<TRun>;
  logger: TeamProvisioningProcessExitPorts<TRun>['logger'];
  updateProgress: TeamProvisioningProcessExitPorts<TRun>['updateProgress'];
  getTeamsBasePath: TeamProvisioningProcessExitPorts<TRun>['getTeamsBasePath'];
  getAutoDetectedClaudeBasePath: TeamProvisioningProcessExitPorts<TRun>['getAutoDetectedClaudeBasePath'];
  getConfiguredCliCommandLabel: TeamProvisioningProcessExitPorts<TRun>['getConfiguredCliCommandLabel'];
  getRunRuntimeFailureLabel: TeamProvisioningProcessExitPorts<TRun>['getRunRuntimeFailureLabel'];
  getVerificationTimeoutMs: TeamProvisioningProcessExitPorts<TRun>['getVerificationTimeoutMs'];
  extractCliLogsFromRun: TeamProvisioningProcessExitPorts<TRun>['extractCliLogsFromRun'];
  logsSuggestShutdownOrCleanup: TeamProvisioningProcessExitPorts<TRun>['logsSuggestShutdownOrCleanup'];
}

export function createTeamProvisioningProcessExitPorts<TRun extends TeamProvisioningProcessExitRun>(
  deps: TeamProvisioningProcessExitPortsFactoryDeps<TRun>
): TeamProvisioningProcessExitPorts<TRun> {
  return {
    logger: deps.logger,
    buildStdoutCarryDiagnostic: (run) => deps.service.buildStdoutCarryDiagnostic(run),
    flushStdoutParserCarry: (run) => deps.service.flushStdoutParserCarry(run),
    stopStallWatchdog: (run) => deps.service.stopStallWatchdog(run),
    hasSecondaryRuntimeRuns: (teamName) => deps.service.hasSecondaryRuntimeRuns(teamName),
    stopMixedSecondaryRuntimeLanes: (teamName) =>
      deps.service.stopMixedSecondaryRuntimeLanes(teamName),
    waitForValidConfig: (run) => deps.verificationProbePorts.waitForValidConfig(run),
    waitForTeamInList: (teamName, run) =>
      deps.verificationProbePorts.waitForTeamInList(teamName, run),
    waitForMissingInboxes: (run) => deps.verificationProbePorts.waitForMissingInboxes(run),
    persistMembersMeta: (teamName, request) => deps.service.persistMembersMeta(teamName, request),
    updateProgress: (run, state, message, extras) =>
      deps.updateProgress(run, state, message, extras),
    cleanupRun: (run) => deps.service.cleanupRun(run),
    getTeamsBasePath: deps.getTeamsBasePath,
    getAutoDetectedClaudeBasePath: deps.getAutoDetectedClaudeBasePath,
    getConfiguredCliCommandLabel: deps.getConfiguredCliCommandLabel,
    getRunRuntimeFailureLabel: (run) => deps.getRunRuntimeFailureLabel(run),
    getVerificationTimeoutMs: deps.getVerificationTimeoutMs,
    extractCliLogsFromRun: (run) => deps.extractCliLogsFromRun(run),
    logsSuggestShutdownOrCleanup: (logs) => deps.logsSuggestShutdownOrCleanup(logs),
    finalizeIncompleteLaunchStateBeforeCleanup: (run, fallbackReason) =>
      deps.service.finalizeIncompleteLaunchStateBeforeCleanup(run, fallbackReason),
  };
}
