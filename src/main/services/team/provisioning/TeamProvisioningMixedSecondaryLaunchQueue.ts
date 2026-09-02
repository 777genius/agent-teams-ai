import * as path from 'path';

import { sleep } from './TeamProvisioningAsyncUtils';
import {
  appendDiagnosticOnce,
  markOpenCodeLaneBlockedBySharedRuntimeFailure,
} from './TeamProvisioningOpenCodeRuntimeEvidencePolicy';
import {
  OPENCODE_TRANSIENT_SHARED_RUNTIME_RETRY_BACKOFF_MS,
  OPENCODE_TRANSIENT_SHARED_RUNTIME_RETRY_DIAGNOSTIC,
  type OpenCodeSharedRuntimeFailuresByProject,
  shouldRetryTransientOpenCodeSharedRuntimeFailure,
  takeBlockingOpenCodeSharedRuntimeFailure,
  trackOpenCodeSharedRuntimeFailureFromResult,
} from './TeamProvisioningOpenCodeSharedRuntimeFailurePolicy';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchResult,
} from '../runtime/TeamRuntimeAdapter';
import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import type { PersistedTeamLaunchPhase, PersistedTeamLaunchSnapshot } from '@shared/types';

export interface MixedSecondaryLaunchQueueRun {
  teamName: string;
  request: { cwd: string };
  cancelRequested: boolean;
  processKilled: boolean;
  mixedSecondaryLanes?: MixedSecondaryRuntimeLaneState[];
  mixedSecondaryLaneLaunchQueue?: Promise<void>;
  mixedSecondarySharedRuntimeFailuresByProject?: OpenCodeSharedRuntimeFailuresByProject;
}

export interface MixedSecondaryLaunchQueuePorts<TRun extends MixedSecondaryLaunchQueueRun> {
  nowMs(): number;
  randomUuid(): string;
  teamsBasePath(): string;
  clearOpenCodeRuntimeLaneStorage(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
    expectedRunId: string;
  }): Promise<unknown>;
  upsertOpenCodeRuntimeLaneIndexEntry(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
    state: 'degraded';
    diagnostics: string[];
  }): Promise<unknown>;
  deleteSecondaryRuntimeRun(teamName: string, laneId: string): void;
  deleteSecondaryRuntimeRunIfOwned(teamName: string, laneId: string, runId: string): boolean;
  launchSingleMixedSecondaryLane(run: TRun, lane: MixedSecondaryRuntimeLaneState): Promise<void>;
  publishMixedSecondaryLaneStatusChange(
    run: TRun,
    lane: MixedSecondaryRuntimeLaneState
  ): Promise<void>;
  persistLaunchStateSnapshot(
    run: TRun,
    launchPhase: PersistedTeamLaunchPhase
  ): Promise<PersistedTeamLaunchSnapshot | null>;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
  getMixedSecondaryLaunchPhase(run: TRun): PersistedTeamLaunchPhase;
  createUnexpectedMixedSecondaryLaneFailureResult(input: {
    runId: string;
    teamName: string;
    memberName: string;
    message: string;
  }): TeamRuntimeLaunchResult;
  logger: {
    warn(message: string): void;
  };
}

async function clearQueuedMixedSecondaryLaneStorage<TRun extends MixedSecondaryLaunchQueueRun>(
  run: TRun,
  lane: MixedSecondaryRuntimeLaneState,
  laneRunId: string,
  ports: MixedSecondaryLaunchQueuePorts<TRun>
): Promise<void> {
  await ports
    .clearOpenCodeRuntimeLaneStorage({
      teamsBasePath: ports.teamsBasePath(),
      teamName: run.teamName,
      laneId: lane.laneId,
      expectedRunId: laneRunId,
    })
    .catch(() => undefined);
  ports.deleteSecondaryRuntimeRunIfOwned(run.teamName, lane.laneId, laneRunId);
}

export function launchQueuedMixedSecondaryLaneInBackground<
  TRun extends MixedSecondaryLaunchQueueRun,
>(
  run: TRun,
  lane: MixedSecondaryRuntimeLaneState,
  ports: MixedSecondaryLaunchQueuePorts<TRun>
): void {
  if (lane.state !== 'queued' || lane.launchScheduled) {
    return;
  }

  lane.queuedAtMs = lane.queuedAtMs ?? ports.nowMs();
  lane.launchScheduled = true;
  const laneRunId = (lane.runId ??= ports.randomUuid());

  const launch = async () => {
    try {
      if (run.cancelRequested || run.processKilled) {
        // This queued lane has not acquired runtime storage or registry ownership.
        if (lane.runId === laneRunId) lane.state = 'finished';
        return;
      }
      const laneCwd = path.resolve(lane.member.cwd?.trim() || run.request.cwd);
      const sharedRuntimeFailure = takeBlockingOpenCodeSharedRuntimeFailure(
        run,
        laneCwd,
        ports.nowMs()
      );
      if (sharedRuntimeFailure) {
        markOpenCodeLaneBlockedBySharedRuntimeFailure({
          teamName: run.teamName,
          lane,
          rootCause: sharedRuntimeFailure,
          nowMs: ports.nowMs(),
          createRunId: ports.randomUuid,
        });
        await ports.publishMixedSecondaryLaneStatusChange(run, lane).catch(() => undefined);
        return;
      }
      lane.state = 'launching';
      await ports.launchSingleMixedSecondaryLane(run, lane);
      if (
        shouldRetryTransientOpenCodeSharedRuntimeFailure(lane.result) &&
        !run.cancelRequested &&
        !run.processKilled
      ) {
        // The pre-launch gate on the failed result proves the state-changing
        // bridge command never ran, so one in-place relaunch cannot duplicate a
        // host or a session.
        ports.logger.warn(
          `[${run.teamName}] OpenCode secondary lane ${lane.laneId} hit a transient shared runtime timeout; retrying once in ${OPENCODE_TRANSIENT_SHARED_RUNTIME_RETRY_BACKOFF_MS}ms`
        );
        lane.diagnostics = appendDiagnosticOnce(
          lane.diagnostics,
          OPENCODE_TRANSIENT_SHARED_RUNTIME_RETRY_DIAGNOSTIC
        );
        await sleep(OPENCODE_TRANSIENT_SHARED_RUNTIME_RETRY_BACKOFF_MS);
        // The backoff is a window in which the lane can change hands (a manual
        // lane retry or a relaunch assigns a new lane run id). Only the run that
        // observed the timeout may relaunch, mirroring the cancelled-lane fence.
        if (!run.cancelRequested && !run.processKilled && lane.runId === laneRunId) {
          lane.state = 'launching';
          lane.result = null;
          await ports.launchSingleMixedSecondaryLane(run, lane);
        }
      }
      if (lane.result) {
        trackOpenCodeSharedRuntimeFailureFromResult(run, laneCwd, lane.result, ports.nowMs());
      }
    } catch (error) {
      if (run.cancelRequested || run.processKilled) {
        await clearQueuedMixedSecondaryLaneStorage(run, lane, laneRunId, ports);
        if (lane.runId === laneRunId) lane.state = 'finished';
        return;
      }
      const message = error instanceof Error ? error.message : String(error);
      ports.logger.warn(
        `[${run.teamName}] OpenCode secondary lane ${lane.laneId} crashed during launch orchestration: ${message}`
      );
      lane.result = ports.createUnexpectedMixedSecondaryLaneFailureResult({
        runId: lane.runId ?? ports.randomUuid(),
        teamName: run.teamName,
        memberName: lane.member.name,
        message,
      });
      lane.warnings = [];
      lane.diagnostics = [...lane.diagnostics, message];
      const laneCwd = path.resolve(lane.member.cwd?.trim() || run.request.cwd);
      trackOpenCodeSharedRuntimeFailureFromResult(run, laneCwd, lane.result, ports.nowMs());
      await ports
        .upsertOpenCodeRuntimeLaneIndexEntry({
          teamsBasePath: ports.teamsBasePath(),
          teamName: run.teamName,
          laneId: lane.laneId,
          state: 'degraded',
          diagnostics: [message],
        })
        .catch(() => undefined);
      ports.deleteSecondaryRuntimeRun(run.teamName, lane.laneId);
      lane.state = 'finished';
      await ports.publishMixedSecondaryLaneStatusChange(run, lane).catch(() => undefined);
    }
  };

  const previousLaunch = run.mixedSecondaryLaneLaunchQueue ?? Promise.resolve();
  const nextLaunch = previousLaunch.catch(() => undefined).then(launch);
  run.mixedSecondaryLaneLaunchQueue = nextLaunch.catch((error) => {
    ports.logger.warn(
      `[${run.teamName}] OpenCode secondary lane launch queue failed: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  });
  void run.mixedSecondaryLaneLaunchQueue;
}

export async function launchMixedSecondaryLaneIfNeeded<TRun extends MixedSecondaryLaunchQueueRun>(
  run: TRun,
  ports: MixedSecondaryLaunchQueuePorts<TRun>,
  options: { waitForCompletion?: boolean } = {}
): Promise<PersistedTeamLaunchSnapshot | null> {
  if (run.cancelRequested || run.processKilled) {
    return ports.readLaunchState(run.teamName).catch(() => null);
  }

  const mixedSecondaryLanes = run.mixedSecondaryLanes ?? [];
  if (mixedSecondaryLanes.length === 0) {
    return ports.persistLaunchStateSnapshot(run, 'finished');
  }

  const adapter = ports.getOpenCodeRuntimeAdapter();
  if (!adapter) {
    for (const lane of mixedSecondaryLanes) {
      lane.runId = lane.runId ?? ports.randomUuid();
      lane.state = 'finished';
      lane.result = {
        runId: lane.runId,
        teamName: run.teamName,
        launchPhase: 'finished',
        teamLaunchState: 'partial_failure',
        members: {
          [lane.member.name]: {
            memberName: lane.member.name,
            providerId: 'opencode',
            launchState: 'failed_to_start',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'opencode_runtime_adapter_missing',
            diagnostics: ['OpenCode runtime adapter is not registered for mixed team launch.'],
          },
        },
        warnings: [],
        diagnostics: ['OpenCode runtime adapter is not registered for mixed team launch.'],
      };
      lane.diagnostics = lane.result.diagnostics;
      await ports.publishMixedSecondaryLaneStatusChange(run, lane);
    }
    return ports.persistLaunchStateSnapshot(run, 'finished');
  }

  for (const lane of mixedSecondaryLanes) {
    launchQueuedMixedSecondaryLaneInBackground(run, lane, ports);
  }

  if (options.waitForCompletion) {
    await run.mixedSecondaryLaneLaunchQueue;
    if (run.cancelRequested || run.processKilled) {
      return ports.readLaunchState(run.teamName).catch(() => null);
    }
  }

  return ports.persistLaunchStateSnapshot(run, ports.getMixedSecondaryLaunchPhase(run));
}
