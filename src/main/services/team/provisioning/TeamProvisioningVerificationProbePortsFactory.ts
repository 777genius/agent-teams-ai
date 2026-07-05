import {
  pathExists as provisioningPathExists,
  type TeamProvisioningProcessExitRun,
  type TeamProvisioningTimeoutCompletionPorts,
  tryCompleteAfterTimeout as tryCompleteAfterTimeoutHelper,
  type ValidConfigProbeResultLike,
  waitForMissingInboxes as waitForMissingInboxesHelper,
  waitForTeamInList as waitForTeamInListHelper,
  waitForValidConfig as waitForValidConfigHelper,
  type WaitForValidConfigPorts,
} from './TeamProvisioningProcessExit';

type TimeoutCompletionServicePortKey =
  | 'persistMembersMeta'
  | 'updateConfigPostLaunch'
  | 'refreshMemberSpawnStatusesFromLeadInbox'
  | 'maybeAuditMemberSpawnStatuses'
  | 'finalizeMissingRegisteredMembersAsFailed'
  | 'persistLaunchStateSnapshot'
  | 'cleanupRun';

export type TeamProvisioningVerificationProbeServiceAdapter<
  TRun extends TeamProvisioningProcessExitRun,
> = Pick<TeamProvisioningTimeoutCompletionPorts<TRun>, TimeoutCompletionServicePortKey>;

export interface TeamProvisioningVerificationProbePorts<
  TRun extends TeamProvisioningProcessExitRun,
> {
  waitForValidConfig(run: TRun, timeoutMs?: number): Promise<ValidConfigProbeResultLike>;
  waitForTeamInList(teamName: string, run?: TRun): Promise<boolean>;
  waitForMissingInboxes(run: TRun): Promise<string[]>;
  tryCompleteAfterTimeout(run: TRun): Promise<boolean>;
  pathExists(filePath: string): Promise<boolean>;
}

export interface TeamProvisioningVerificationProbePortsFactoryDeps<
  TRun extends TeamProvisioningProcessExitRun,
> {
  service: TeamProvisioningVerificationProbeServiceAdapter<TRun>;
  listTeams(): Promise<readonly { teamName: string }[]>;
  getTeamsBasePath(): string;
  readRegularFileUtf8: WaitForValidConfigPorts['readRegularFileUtf8'];
  updateProgress: TeamProvisioningTimeoutCompletionPorts<TRun>['updateProgress'];
  verifyTimeoutMs: number;
  verifyPollMs: number;
  teamJsonReadTimeoutMs: number;
  teamConfigMaxBytes: number;
  sleep?(ms: number): Promise<void>;
  pathExists?(filePath: string): Promise<boolean>;
}

export function createTeamProvisioningVerificationProbePorts<
  TRun extends TeamProvisioningProcessExitRun,
>(
  deps: TeamProvisioningVerificationProbePortsFactoryDeps<TRun>
): TeamProvisioningVerificationProbePorts<TRun> {
  const pathExists = deps.pathExists ?? provisioningPathExists;

  const ports: TeamProvisioningVerificationProbePorts<TRun> = {
    waitForValidConfig: (run, timeoutMs = deps.verifyTimeoutMs) =>
      waitForValidConfigHelper(run, {
        readRegularFileUtf8: deps.readRegularFileUtf8,
        timeoutMs,
        pollMs: deps.verifyPollMs,
        teamJsonReadTimeoutMs: deps.teamJsonReadTimeoutMs,
        teamConfigMaxBytes: deps.teamConfigMaxBytes,
        sleep: deps.sleep,
      }),
    waitForTeamInList: (teamName, run) =>
      waitForTeamInListHelper(teamName, {
        listTeams: deps.listTeams,
        timeoutMs: deps.verifyTimeoutMs,
        pollMs: deps.verifyPollMs,
        isCancelled: () => run?.cancelRequested === true,
        sleep: deps.sleep,
      }),
    waitForMissingInboxes: (run) =>
      waitForMissingInboxesHelper(run, {
        getTeamsBasePath: deps.getTeamsBasePath,
        pathExists,
        timeoutMs: deps.verifyTimeoutMs,
        pollMs: deps.verifyPollMs,
        sleep: deps.sleep,
      }),
    tryCompleteAfterTimeout: (run) =>
      tryCompleteAfterTimeoutHelper(run, {
        waitForValidConfig: (targetRun) => ports.waitForValidConfig(targetRun),
        waitForTeamInList: (teamName, targetRun) => ports.waitForTeamInList(teamName, targetRun),
        waitForMissingInboxes: (targetRun) => ports.waitForMissingInboxes(targetRun),
        persistMembersMeta: (teamName, request) =>
          deps.service.persistMembersMeta(teamName, request),
        updateConfigPostLaunch: (teamName, cwd, detectedSessionId, color, options) =>
          deps.service.updateConfigPostLaunch(teamName, cwd, detectedSessionId, color, options),
        refreshMemberSpawnStatusesFromLeadInbox: (targetRun) =>
          deps.service.refreshMemberSpawnStatusesFromLeadInbox(targetRun),
        maybeAuditMemberSpawnStatuses: (targetRun, options) =>
          deps.service.maybeAuditMemberSpawnStatuses(targetRun, options),
        finalizeMissingRegisteredMembersAsFailed: (targetRun) =>
          deps.service.finalizeMissingRegisteredMembersAsFailed(targetRun),
        persistLaunchStateSnapshot: (targetRun, phase) =>
          deps.service.persistLaunchStateSnapshot(targetRun, phase),
        updateProgress: (targetRun, state, message, extras) =>
          deps.updateProgress(targetRun, state, message, extras),
        cleanupRun: (targetRun) => deps.service.cleanupRun(targetRun),
      }),
    pathExists,
  };

  return ports;
}
