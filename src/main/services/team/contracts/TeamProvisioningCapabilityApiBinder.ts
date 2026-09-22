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
  source: TeamProvisioningStartApi & { getAliveTeams?: () => string[] },
  options: {
    beforeStart?: (input: {
      teamName: string;
      request: Parameters<TeamProvisioningStartApi['createTeam']>[0] | Parameters<TeamProvisioningStartApi['launchTeam']>[0];
      onProgress: Parameters<TeamProvisioningStartApi['createTeam']>[1];
    }) => Promise<void>;
  } = {}
): TeamProvisioningStartApi {
  const beforeStart = options.beforeStart ?? bindOpenCodeStartPreparation(source);

  return {
    async createTeam(request, onProgress) {
      await runBeforeStart(beforeStart, { teamName: request.teamName, request, onProgress });
      return source.createTeam.call(source, request, onProgress);
    },
    async launchTeam(request, onProgress) {
      await runBeforeStart(beforeStart, { teamName: request.teamName, request, onProgress });
      return source.launchTeam.call(source, request, onProgress);
    },
  };
}

async function runBeforeStart(
  beforeStart: (input: {
    teamName: string;
    request: Parameters<TeamProvisioningStartApi['createTeam']>[0] | Parameters<TeamProvisioningStartApi['launchTeam']>[0];
    onProgress: Parameters<TeamProvisioningStartApi['createTeam']>[1];
  }) => Promise<void>,
  input: {
    teamName: string;
    request: Parameters<TeamProvisioningStartApi['createTeam']>[0] | Parameters<TeamProvisioningStartApi['launchTeam']>[0];
    onProgress: Parameters<TeamProvisioningStartApi['createTeam']>[1];
  }
): Promise<void> {
  try {
    await beforeStart(input);
  } catch (error) {
    const { OpenCodeStartupCleanupBusyError } = await import(
      '../opencode/bridge/OpenCodeStartupSweepGate'
    );
    if (error instanceof OpenCodeStartupCleanupBusyError) {
      throw error;
    }
    const { createLogger } = await import('@shared/utils/logger');
    createLogger('Service:TeamProvisioningStart').diagnostic(
      `opencode_pre_start_preparation_failed team=${input.teamName} reason=${JSON.stringify(
        error instanceof Error ? error.message : String(error)
      )}`
    );
  }
}

function startRequestMayRaceOpenCodeStartupSweep(
  request: Parameters<TeamProvisioningStartApi['createTeam']>[0] | Parameters<TeamProvisioningStartApi['launchTeam']>[0]
): boolean {
  if (request.providerId === undefined || request.providerId === 'opencode') {
    return true;
  }
  const members = 'members' in request ? request.members : undefined;
  return (
    (process.platform === 'win32' && members === undefined) ||
    members?.some((member) => member.providerId === 'opencode') === true
  );
}

function bindOpenCodeStartPreparation(source: {
  getAliveTeams?: () => string[];
}): (input: {
  teamName: string;
  request: Parameters<TeamProvisioningStartApi['createTeam']>[0] | Parameters<TeamProvisioningStartApi['launchTeam']>[0];
  onProgress: Parameters<TeamProvisioningStartApi['createTeam']>[1];
}) => Promise<void> {
  return async ({ teamName, request, onProgress }) => {
    const [{ createLogger }, { whenOpenCodeStartupRuntimeSweepSettled }] = await Promise.all([
      import('@shared/utils/logger'),
      import('../opencode/bridge/OpenCodeStartupSweepGate'),
    ]);
    const logger = createLogger('Service:TeamProvisioningStart');

    if (startRequestMayRaceOpenCodeStartupSweep(request)) {
      await whenOpenCodeStartupRuntimeSweepSettled({
        logWaited: (message) => logger.diagnostic(message),
        onWaitStart: () => {
          const observedAt = new Date().toISOString();
          onProgress({
            runId: `pending:${teamName}:opencode-startup-sweep`,
            teamName,
            state: 'validating',
            message: 'Waiting for the startup runtime host cleanup to finish...',
            startedAt: observedAt,
            updatedAt: observedAt,
          });
        },
      });
    }
    const { purgeStaleOpenCodeHostStartupLocksBeforeLaunch } = await import(
      '../opencode/bridge/OpenCodeHostStartupLockCleanup'
    );
    await purgeStaleOpenCodeHostStartupLocksBeforeLaunch({
      teamName,
      aliveTeams: source.getAliveTeams?.() ?? [],
      logRemoved: (message) => logger.diagnostic(message),
      logWarning: (message) => logger.warn(message),
    });
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
