/**
 * Exact-team stop shared by headless HTTP and budget enforcement.
 * The bounded normal stop escalates only on failure. It never signals
 * a shared runtime without the existing lane/ownership evidence.
 */
import { getTeamsBasePath } from '@main/utils/pathDecoder';

import { assertEscalatedStopConfirmed } from '../provisioning/TeamProvisioningOpenCodeRuntimeStopOutcome';
import { TeamLaunchStateStore } from '../TeamLaunchStateStore';

import {
  clearPendingOpenCodePromptDeliveriesForTeam,
  countLiveRecordedRuntimeHostsForTeam,
  killRetainedOpenCodeRuntimeProcessesForTeam,
  readOpenCodeRuntimeLaneIdsForTeam,
  readOwnedOpenCodeRuntimeRunIdsForTeam,
  releaseLoopbackRuntimesReservedByTeam,
  releaseSharedRuntimeResourcesAfterStop,
  STOP_ESCALATION_TIMEOUT_MS,
  stopTeamWithEscalation,
} from './teamForceStopFlow';
import { reapCursorAgentLeadTreesForStoppedTeam } from './teamLeadProcessTreeReap';

export interface EscalatedTeamStopRuntimePort {
  stopTeam(teamName: string): Promise<void>;
  getAliveTeams(): string[];
}

export interface EscalatedTeamStopLoggerPort {
  warn(message: string): void;
  info?(message: string): void;
}

export async function stopTeamWithVerifiedEscalation(
  teamName: string,
  runtime: EscalatedTeamStopRuntimePort,
  logger: EscalatedTeamStopLoggerPort
): Promise<void> {
  const result = await stopTeamWithEscalation(teamName, {
    stopTeam: (name) => runtime.stopTeam(name),
    observeOwnedRuntimeRunIds: (name) => readOwnedOpenCodeRuntimeRunIdsForTeam({ teamName: name }),
    observeOwnedRuntimeLaneIds: (name) =>
      readOpenCodeRuntimeLaneIdsForTeam(getTeamsBasePath(), name),
    killRetainedRuntimeProcesses: (name, context) =>
      killRetainedOpenCodeRuntimeProcessesForTeam({
        teamName: name,
        requestedAtMs: context.requestedAtMs,
        otherAliveTeams: runtime.getAliveTeams().filter((alive) => alive !== name),
      }),
    clearPendingPromptDeliveries: (name, context) =>
      clearPendingOpenCodePromptDeliveriesForTeam({
        teamName: name,
        ownedRunIds: context.ownedRunIds,
        ownedLaneIds: context.ownedLaneIds,
        requestedAtMs: context.requestedAtMs,
      }),
    logWarning: (message) => logger.warn(message),
    stopTimeoutMs: STOP_ESCALATION_TIMEOUT_MS,
    countLiveRuntimeHosts: (name) => countLiveRecordedRuntimeHostsForTeam({ teamName: name }),
    markTeamStopped: (name, authority) => new TeamLaunchStateStore().markStopped(name, authority),
    reapOwnedLeadProcessTrees: (name, context) =>
      reapCursorAgentLeadTreesForStoppedTeam({
        teamName: name,
        requestedAtMs: context.requestedAtMs,
        otherAliveTeams: runtime.getAliveTeams().filter((alive) => alive !== name),
      }),
    releaseSharedRuntimeResources: (name) =>
      releaseSharedRuntimeResourcesAfterStop({
        teamName: name,
        otherAliveTeams: runtime.getAliveTeams().filter((alive) => alive !== name),
        releaseSharedLocalRuntime: () =>
          releaseLoopbackRuntimesReservedByTeam(getTeamsBasePath(), name),
      }),
  });
  if (result.stopOutcome === 'runtime_already_down') {
    logger.info?.(
      `[${teamName}] Runtime hosts were already down; finished the stop without the orchestrator acknowledgement (killed ${result.killedRuntimePids.length} runtime pid(s), cancelled ${result.clearedPendingDeliveries} pending deliveries)`
    );
  } else if (result.stopOutcome !== 'stopped') {
    logger.warn(
      `[${teamName}] Regular stop ${result.stopOutcome}; escalated to force stop (killed ${result.killedRuntimePids.length} runtime pid(s), cancelled ${result.clearedPendingDeliveries} pending deliveries)`
    );
  }
  assertEscalatedStopConfirmed(result);
}
