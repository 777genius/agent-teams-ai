import type {
  TeamClaudeLogsApi,
  TeamDiagnosticsApi,
  TeamHttpDataApi,
  TeamMemberLifecycleApi,
  TeamProvisioningPreflightApi,
  TeamProvisioningPrepareOptions,
  TeamProvisioningRunApi,
  TeamProvisioningStartApi,
  TeamProvisioningStatusApi,
  TeamTaskActivityRepairApi,
  TeamToolApprovalApi,
} from './TeamProvisioningCapabilityApis';

function assertDensePrepareModelArray(values: unknown, field: 'modelIds' | 'modelChecks'): void {
  if (values === undefined) {
    return;
  }

  if (!Array.isArray(values)) {
    throw new TypeError(`TeamProvisioningPrepareOptions.${field} must be an array when provided`);
  }

  for (let index = 0; index < values.length; index += 1) {
    if (!Object.hasOwn(values, index) || values[index] === undefined) {
      throw new TypeError(
        `TeamProvisioningPrepareOptions.${field} must not contain missing indices`
      );
    }
  }
}

function validatePrepareModelIndexes(opts?: TeamProvisioningPrepareOptions): void {
  assertDensePrepareModelArray(opts?.modelIds, 'modelIds');
  assertDensePrepareModelArray(opts?.modelChecks, 'modelChecks');
}

export function bindTeamProvisioningStartApi(
  source: TeamProvisioningStartApi
): TeamProvisioningStartApi {
  return {
    createTeam: source.createTeam.bind(source),
    launchTeam: source.launchTeam.bind(source),
  };
}

export function bindTeamProvisioningStatusApi(
  source: TeamProvisioningStatusApi
): TeamProvisioningStatusApi {
  return {
    getProvisioningStatus: source.getProvisioningStatus.bind(source),
  };
}

export function bindTeamProvisioningPreflightApi(
  source: TeamProvisioningPreflightApi
): TeamProvisioningPreflightApi {
  return {
    getCliHelpOutput: source.getCliHelpOutput.bind(source),
    async prepareForProvisioning(cwd, opts) {
      validatePrepareModelIndexes(opts);
      return source.prepareForProvisioning.call(source, cwd, opts);
    },
  };
}

export function bindTeamProvisioningRunApi(source: TeamProvisioningRunApi): TeamProvisioningRunApi {
  return {
    cancelProvisioning: source.cancelProvisioning.bind(source),
    hasProvisioningRun: source.hasProvisioningRun.bind(source),
  };
}

export function bindTeamTaskActivityRepairApi(
  source: TeamTaskActivityRepairApi
): TeamTaskActivityRepairApi {
  return {
    repairStaleTaskActivityIntervalsBeforeSnapshot:
      source.repairStaleTaskActivityIntervalsBeforeSnapshot.bind(source),
  };
}

export function bindTeamHttpDataApi(source: TeamHttpDataApi): TeamHttpDataApi {
  return {
    listTeams: source.listTeams.bind(source),
    getTeamData: source.getTeamData.bind(source),
    getSavedRequest: source.getSavedRequest.bind(source),
    createTeamConfig: source.createTeamConfig.bind(source),
  };
}

export function bindTeamMemberLifecycleApi(source: TeamMemberLifecycleApi): TeamMemberLifecycleApi {
  return {
    getMemberSpawnStatuses: source.getMemberSpawnStatuses.bind(source),
    runLiveRosterMutation: source.runLiveRosterMutation.bind(source),
    ...(source.tryRunLiveRosterMutation
      ? { tryRunLiveRosterMutation: source.tryRunLiveRosterMutation.bind(source) }
      : {}),
    attachLiveRosterMember: source.attachLiveRosterMember.bind(source),
    detachLiveRosterMember: source.detachLiveRosterMember.bind(source),
    restartMember: source.restartMember.bind(source),
    retryFailedOpenCodeSecondaryLanes: source.retryFailedOpenCodeSecondaryLanes.bind(source),
    skipMemberForLaunch: source.skipMemberForLaunch.bind(source),
  };
}

export function bindTeamDiagnosticsApi(source: TeamDiagnosticsApi): TeamDiagnosticsApi {
  return {
    getLeadActivityState: source.getLeadActivityState.bind(source),
    getLeadContextUsage: source.getLeadContextUsage.bind(source),
    getTeamAgentRuntimeSnapshot: source.getTeamAgentRuntimeSnapshot.bind(source),
  };
}

export function bindTeamClaudeLogsApi(source: TeamClaudeLogsApi): TeamClaudeLogsApi {
  return {
    getClaudeLogs: source.getClaudeLogs.bind(source),
  };
}

export function bindTeamToolApprovalApi(source: TeamToolApprovalApi): TeamToolApprovalApi {
  return {
    getPendingToolApprovalFilePath: source.getPendingToolApprovalFilePath.bind(source),
    getPendingToolApprovalFileTarget: source.getPendingToolApprovalFileTarget.bind(source),
    respondToToolApproval: source.respondToToolApproval.bind(source),
    updateToolApprovalSettings: source.updateToolApprovalSettings.bind(source),
  };
}
