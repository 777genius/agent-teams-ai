import { getErrorMessage } from '@shared/utils/errorHandling';
import { createLogger } from '@shared/utils/logger';

import { OpenCodeAggregatePrimaryProgressPublisher } from './OpenCodeAggregatePrimaryProgressPublisher';
import {
  assertAggregatePrimaryStopConfirmed,
  getCancelledAggregateLaunchError,
} from './OpenCodeAggregatePrimaryRestartPolicy';
import {
  getPendingOpenCodePrimaryCleanupIdentity,
  type PendingOpenCodePrimaryCleanup,
} from './TeamProvisioningLaunchStateStoreBoundary';
import { OpenCodeAggregateRuntimeStopError } from './TeamProvisioningOpenCodeAggregateLaunchPersistence';

import type { TeamLaunchRuntimeAdapter } from '../runtime';
import type { ProvisioningRun } from './TeamProvisioningRunModel';
import type { PersistedTeamLaunchSnapshot, TeamCreateRequest, TeamProviderId } from '@shared/types';

const logger = createLogger('Service:TeamProvisioning');

export interface OpenCodeAggregatePrimaryRuntimeOwner {
  runId: string;
  providerId: TeamProviderId;
  cwd?: string;
  allowExperimentalLocalModels?: boolean;
}

export interface TeamProvisioningOpenCodeAggregatePrimaryCleanupPorts {
  progress: OpenCodeAggregatePrimaryProgressPublisher;
  getOpenCodeRuntimeLaunchCwd(baseCwd: string, members: TeamCreateRequest['members']): string;
  getRuntimeOwner(teamName: string): OpenCodeAggregatePrimaryRuntimeOwner | undefined;
  setRuntimeOwner(teamName: string, owner: OpenCodeAggregatePrimaryRuntimeOwner): void;
  deleteRuntimeOwner(teamName: string): void;
  appendPendingCleanup(cleanup: PendingOpenCodePrimaryCleanup): Promise<void>;
  readPendingCleanups(teamName: string): Promise<PendingOpenCodePrimaryCleanup[]>;
  consumePendingCleanup(cleanup: PendingOpenCodePrimaryCleanup): Promise<void>;
  clearPrimaryLaneIfOwned(teamName: string, runId: string): Promise<void>;
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
}

export interface StopUnretainableOpenCodePrimaryLaneInput {
  adapter: TeamLaunchRuntimeAdapter;
  run: ProvisioningRun;
  previousEffectiveMembers: TeamCreateRequest['members'];
  previousLaunchState: PersistedTeamLaunchSnapshot | null;
}

export async function stopUnretainableOpenCodePrimaryLane(
  input: StopUnretainableOpenCodePrimaryLaneInput,
  ports: TeamProvisioningOpenCodeAggregatePrimaryCleanupPorts
): Promise<void> {
  const cwd = ports.getOpenCodeRuntimeLaunchCwd(
    input.run.request.cwd,
    input.previousEffectiveMembers
  );
  const currentOwner = ports.getRuntimeOwner(input.run.teamName);
  const exactStopOwner = currentOwner ?? {
    runId: input.run.runId,
    providerId: 'opencode' as const,
    cwd,
    ...(input.run.request.allowExperimentalLocalModels === true
      ? { allowExperimentalLocalModels: true }
      : {}),
  };
  if (!currentOwner) {
    ports.setRuntimeOwner(input.run.teamName, exactStopOwner);
  }
  ports.progress.publishPending(input.run, 'Stopping unretainable OpenCode primary lane');
  try {
    const stopResult = await input.adapter.stop({
      runId: input.run.runId,
      laneId: 'primary',
      teamName: input.run.teamName,
      cwd,
      providerId: 'opencode',
      reason: 'cleanup',
      previousLaunchState: input.previousLaunchState,
      force: true,
    });
    assertAggregatePrimaryStopConfirmed(stopResult);
    if (ports.getRuntimeOwner(input.run.teamName) !== exactStopOwner) {
      throw getCancelledAggregateLaunchError(input.run.teamName);
    }
  } catch (error) {
    const cleanup: PendingOpenCodePrimaryCleanup = {
      teamId: input.run.teamName,
      runId: input.run.runId,
      providerId: 'opencode',
      cwd,
      previousLaunchState: input.previousLaunchState,
    };
    let outboxError: unknown;
    try {
      await ports.appendPendingCleanup(cleanup);
    } catch (caughtOutboxError) {
      outboxError = caughtOutboxError;
    }
    if (ports.getRuntimeOwner(input.run.teamName) === exactStopOwner) {
      ports.progress.publishFailed(
        input.run,
        'Unretainable OpenCode primary lane cleanup failed',
        error
      );
    }
    logger.warn(
      `[${input.run.teamName}] Failed to stop unretainable OpenCode primary lane: ${getErrorMessage(error)}`
    );
    throw new OpenCodeAggregateRuntimeStopError(
      outboxError === undefined ? [error] : [error, outboxError]
    );
  }
}

export async function retryPendingOpenCodePrimaryCleanup(
  teamName: string,
  ports: TeamProvisioningOpenCodeAggregatePrimaryCleanupPorts
): Promise<void> {
  const pendingCleanups = (await ports.readPendingCleanups(teamName))
    .map((cleanup) => [getPendingOpenCodePrimaryCleanupIdentity(cleanup), cleanup] as const)
    .sort(([leftIdentity], [rightIdentity]) => {
      if (leftIdentity === rightIdentity) {
        return 0;
      }
      return leftIdentity < rightIdentity ? -1 : 1;
    });
  if (pendingCleanups.length === 0) {
    return;
  }

  const adapter = ports.getOpenCodeRuntimeAdapter();
  if (!adapter) {
    throw new OpenCodeAggregateRuntimeStopError([
      new Error('OpenCode runtime adapter is unavailable for pending primary cleanup'),
    ]);
  }

  for (const [, cleanup] of pendingCleanups) {
    try {
      const result = await adapter.stop({
        runId: cleanup.runId,
        laneId: 'primary',
        teamName: cleanup.teamId,
        cwd: cleanup.cwd,
        providerId: cleanup.providerId,
        reason: 'cleanup',
        previousLaunchState: cleanup.previousLaunchState,
        force: true,
      });
      if (!result.stopped) {
        throw new Error(
          [...result.diagnostics, ...result.warnings].filter(Boolean).join('\n') ||
            'OpenCode pending primary cleanup was not confirmed'
        );
      }
    } catch (error) {
      logger.warn(
        `[${cleanup.teamId}] Failed to retry pending OpenCode primary cleanup for run ${cleanup.runId}: ${getErrorMessage(error)}`
      );
      throw new OpenCodeAggregateRuntimeStopError([error]);
    }

    await ports.consumePendingCleanup(cleanup);
    const currentOwner = ports.getRuntimeOwner(cleanup.teamId);
    if (
      currentOwner?.runId === cleanup.runId &&
      currentOwner.providerId === cleanup.providerId &&
      currentOwner.cwd === cleanup.cwd
    ) {
      await ports.clearPrimaryLaneIfOwned(cleanup.teamId, cleanup.runId);
    }
  }
}

export interface StopFailedOpenCodeAggregatePrimaryRelaunchCandidateInput {
  adapter: TeamLaunchRuntimeAdapter;
  run: ProvisioningRun;
  previousLaunchState: PersistedTeamLaunchSnapshot | null;
  previousOwner: OpenCodeAggregatePrimaryRuntimeOwner | undefined;
}

export async function stopFailedOpenCodeAggregatePrimaryRelaunchCandidate(
  input: StopFailedOpenCodeAggregatePrimaryRelaunchCandidateInput,
  ports: TeamProvisioningOpenCodeAggregatePrimaryCleanupPorts
): Promise<void> {
  const currentOwner = ports.getRuntimeOwner(input.run.teamName);
  if (
    currentOwner &&
    (currentOwner === input.previousOwner ||
      currentOwner.providerId !== 'opencode' ||
      currentOwner.runId !== input.run.runId)
  ) {
    throw getCancelledAggregateLaunchError(input.run.teamName);
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
    ports.setRuntimeOwner(input.run.teamName, expectedOwner);
  }
  ports.progress.publishPending(input.run, 'Stopping failed OpenCode primary relaunch candidate');
  try {
    const stopResult = await input.adapter.stop({
      runId: input.run.runId,
      laneId: 'primary',
      teamName: input.run.teamName,
      cwd,
      providerId: 'opencode',
      reason: 'cleanup',
      previousLaunchState: input.previousLaunchState,
      force: true,
    });
    assertAggregatePrimaryStopConfirmed(stopResult);
    if (ports.getRuntimeOwner(input.run.teamName) !== expectedOwner) {
      throw getCancelledAggregateLaunchError(input.run.teamName);
    }
    ports.deleteRuntimeOwner(input.run.teamName);
  } catch (error) {
    if (ports.getRuntimeOwner(input.run.teamName) === expectedOwner) {
      ports.progress.publishFailed(
        input.run,
        'Failed OpenCode primary relaunch candidate cleanup failed',
        error
      );
    }
    throw error;
  }
}
