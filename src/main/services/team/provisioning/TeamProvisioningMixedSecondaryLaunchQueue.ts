import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeLaunchResult,
} from '../runtime/TeamRuntimeAdapter';
import type { MixedSecondaryRuntimeLaneState } from './TeamProvisioningSecondaryRuntimeRuns';
import type { PersistedTeamLaunchPhase, PersistedTeamLaunchSnapshot } from '@shared/types';

export interface MixedSecondaryLaunchQueueRun {
  teamName: string;
  cancelRequested: boolean;
  processKilled: boolean;
  mixedSecondaryLanes?: MixedSecondaryRuntimeLaneState[];
  mixedSecondaryLaneLaunchQueue?: Promise<void>;
}

export interface MixedSecondaryLaunchQueuePorts<TRun extends MixedSecondaryLaunchQueueRun> {
  nowMs(): number;
  randomUuid(): string;
  teamsBasePath(): string;
  clearOpenCodeRuntimeLaneStorage(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
  }): Promise<unknown>;
  upsertOpenCodeRuntimeLaneIndexEntry(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
    state: 'degraded';
    diagnostics: string[];
  }): Promise<unknown>;
  deleteSecondaryRuntimeRun(teamName: string, laneId: string): void;
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
  ports: MixedSecondaryLaunchQueuePorts<TRun>
): Promise<void> {
  await ports
    .clearOpenCodeRuntimeLaneStorage({
      teamsBasePath: ports.teamsBasePath(),
      teamName: run.teamName,
      laneId: lane.laneId,
    })
    .catch(() => undefined);
  ports.deleteSecondaryRuntimeRun(run.teamName, lane.laneId);
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
  lane.runId = lane.runId ?? ports.randomUuid();

  const launch = async () => {
    try {
      if (run.cancelRequested || run.processKilled) {
        await clearQueuedMixedSecondaryLaneStorage(run, lane, ports);
        lane.state = 'finished';
        return;
      }
      lane.state = 'launching';
      await ports.launchSingleMixedSecondaryLane(run, lane);
    } catch (error) {
      if (run.cancelRequested || run.processKilled) {
        await clearQueuedMixedSecondaryLaneStorage(run, lane, ports);
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
      await ports.publishMixedSecondaryLaneStatusChange(run, lane).catch(() => undefined);
      lane.state = 'finished';
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

export async function launchMixedSecondaryLaneIfNeeded<
  TRun extends MixedSecondaryLaunchQueueRun,
>(
  run: TRun,
  ports: MixedSecondaryLaunchQueuePorts<TRun>
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
      lane.state = 'finished';
      lane.result = {
        runId: lane.runId ?? ports.randomUuid(),
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

  return ports.persistLaunchStateSnapshot(run, ports.getMixedSecondaryLaunchPhase(run));
}
