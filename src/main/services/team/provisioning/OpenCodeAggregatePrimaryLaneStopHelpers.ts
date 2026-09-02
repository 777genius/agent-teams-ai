import { getErrorMessage } from '@shared/utils/errorHandling';

import {
  assertAggregatePrimaryStopConfirmed,
  getCancelledAggregateLaunchError,
} from './OpenCodeAggregatePrimaryRestartPolicy';

import type { TeamLaunchRuntimeAdapter } from '../runtime';
import type { RuntimeAdapterRunByTeamEntry } from './TeamProvisioningServiceComposition';
import type { PersistedTeamLaunchSnapshot, TeamCreateRequest } from '@shared/types';

/**
 * The two exact-owner primary-lane stops the aggregate restart path needs.
 * Extracted verbatim from the facade so the facade can host the lead
 * bootstrap work without pushing past the source-size cap; the ownership
 * identity comparisons are load-bearing and therefore travel through
 * accessors, never through copies.
 */
export interface OpenCodeAggregatePrimaryLaneStopPorts {
  getRuntimeOwner(teamName: string): RuntimeAdapterRunByTeamEntry | undefined;
  setRuntimeOwner(teamName: string, owner: RuntimeAdapterRunByTeamEntry): void;
  deleteRuntimeOwner(teamName: string): void;
  getOpenCodeRuntimeLaunchCwd(baseCwd: string, members: TeamCreateRequest['members']): string;
  publishPending(message: string): void;
  publishFailed(message: string, error: unknown): void;
  logWarn(message: string): void;
}

export interface OpenCodeAggregatePrimaryLaneStopRun {
  runId: string;
  teamName: string;
  request: TeamCreateRequest;
  effectiveMembers: TeamCreateRequest['members'];
}

export async function stopUnretainableOpenCodePrimaryLane(
  input: {
    adapter: TeamLaunchRuntimeAdapter;
    run: OpenCodeAggregatePrimaryLaneStopRun;
    previousEffectiveMembers: TeamCreateRequest['members'];
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
  },
  ports: OpenCodeAggregatePrimaryLaneStopPorts
): Promise<void> {
  const teamName = input.run.teamName;
  const cwd = ports.getOpenCodeRuntimeLaunchCwd(
    input.run.request.cwd,
    input.previousEffectiveMembers
  );
  const currentOwner = ports.getRuntimeOwner(teamName);
  const exactStopOwner = currentOwner ?? {
    runId: input.run.runId,
    providerId: 'opencode' as const,
    cwd,
    ...(input.run.request.allowExperimentalLocalModels === true
      ? { allowExperimentalLocalModels: true }
      : {}),
  };
  if (!currentOwner) {
    ports.setRuntimeOwner(teamName, exactStopOwner);
  }
  ports.publishPending('Stopping unretainable OpenCode primary lane');
  try {
    const stopResult = await input.adapter.stop({
      runId: input.run.runId,
      laneId: 'primary',
      teamName,
      cwd,
      providerId: 'opencode',
      reason: 'cleanup',
      previousLaunchState: input.previousLaunchState,
      force: true,
    });
    assertAggregatePrimaryStopConfirmed(stopResult);
    if (ports.getRuntimeOwner(teamName) !== exactStopOwner) {
      throw getCancelledAggregateLaunchError(teamName);
    }
  } catch (error) {
    if (ports.getRuntimeOwner(teamName) === exactStopOwner) {
      ports.publishFailed('Unretainable OpenCode primary lane cleanup failed', error);
    }
    ports.logWarn(
      `[${teamName}] Failed to stop unretainable OpenCode primary lane: ${getErrorMessage(error)}`
    );
    throw error;
  }
}

export async function stopFailedOpenCodeAggregatePrimaryRelaunchCandidate(
  input: {
    adapter: TeamLaunchRuntimeAdapter;
    run: OpenCodeAggregatePrimaryLaneStopRun;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
    previousOwner: { runId: string; providerId: string; cwd?: string } | undefined;
  },
  ports: OpenCodeAggregatePrimaryLaneStopPorts
): Promise<void> {
  const teamName = input.run.teamName;
  const currentOwner = ports.getRuntimeOwner(teamName);
  if (
    currentOwner &&
    (currentOwner === input.previousOwner ||
      currentOwner.providerId !== 'opencode' ||
      currentOwner.runId !== input.run.runId)
  ) {
    throw getCancelledAggregateLaunchError(teamName);
  }
  const cwd =
    currentOwner?.cwd ??
    ports.getOpenCodeRuntimeLaunchCwd(input.run.request.cwd, input.run.effectiveMembers);
  const expectedOwner = currentOwner ?? {
    runId: input.run.runId,
    providerId: 'opencode' as const,
    cwd,
    ...(input.run.request.allowExperimentalLocalModels === true
      ? { allowExperimentalLocalModels: true }
      : {}),
  };
  if (!currentOwner) {
    ports.setRuntimeOwner(teamName, expectedOwner);
  }
  ports.publishPending('Stopping failed OpenCode primary relaunch candidate');
  try {
    const stopResult = await input.adapter.stop({
      runId: input.run.runId,
      laneId: 'primary',
      teamName,
      cwd,
      providerId: 'opencode',
      reason: 'cleanup',
      previousLaunchState: input.previousLaunchState,
      force: true,
    });
    assertAggregatePrimaryStopConfirmed(stopResult);
    if (ports.getRuntimeOwner(teamName) !== expectedOwner) {
      throw getCancelledAggregateLaunchError(teamName);
    }
    ports.deleteRuntimeOwner(teamName);
  } catch (error) {
    if (ports.getRuntimeOwner(teamName) === expectedOwner) {
      ports.publishFailed('Failed OpenCode primary relaunch candidate cleanup failed', error);
    }
    throw error;
  }
}
