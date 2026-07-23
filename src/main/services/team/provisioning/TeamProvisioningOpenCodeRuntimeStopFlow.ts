import { ownsOpenCodeRuntimeAdapterPrimaryLane } from './TeamProvisioningRuntimeAdapterCancellation';

import type {
  TeamLaunchRuntimeAdapter,
  TeamRuntimeMemberLaunchEvidence,
  TeamRuntimeStopInput,
} from '../runtime';
import type {
  MixedSecondaryRuntimeLaneState,
  SecondaryRuntimeRunEntry,
} from './TeamProvisioningSecondaryRuntimeRuns';
import type {
  PersistedTeamLaunchSnapshot,
  TeamChangeEvent,
  TeamCreateRequest,
  TeamProviderId,
  TeamProvisioningProgress,
} from '@shared/types';

interface StopLogger {
  warn(message: string): void;
}

interface RuntimeAdapterRunEntry {
  runId: string;
  providerId: TeamProviderId;
  cwd?: string;
  members?: Record<string, TeamRuntimeMemberLaunchEvidence>;
}

export interface OpenCodeRuntimeStopFlowPorts {
  teamsBasePath: string;
  getSecondaryRuntimeRuns(teamName: string): SecondaryRuntimeRunEntry[];
  stoppingSecondaryRuntimeTeams: Set<string>;
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  writeLaunchStateSnapshot(
    teamName: string,
    snapshot: PersistedTeamLaunchSnapshot
  ): Promise<PersistedTeamLaunchSnapshot>;
  readPersistedTeamProjectPath(teamName: string): string | null;
  clearOpenCodeRuntimeLaneStorage(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
    expectedRunId?: string;
  }): Promise<boolean>;
  deleteSecondaryRuntimeRun(teamName: string, laneId: string): void;
  clearSecondaryRuntimeRuns(teamName: string): void;
  runtimeAdapterRunByTeam: Map<string, RuntimeAdapterRunEntry>;
  runtimeAdapterProgressByRunId: Map<string, TeamProvisioningProgress>;
  setRuntimeAdapterProgress(progress: TeamProvisioningProgress): TeamProvisioningProgress;
  clearOpenCodeRuntimeToolApprovals(
    teamName: string,
    options: { runId?: string; laneId?: string; emitDismiss?: boolean }
  ): void;
  getAliveRunId(teamName: string): string | null;
  deleteAliveRunId(teamName: string): void;
  provisioningRunByTeam: Map<string, string>;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  emitTeamChange(event: TeamChangeEvent): void;
  logger: StopLogger;
  nowIso(): string;
}

export interface SingleMixedSecondaryRuntimeLaneStopRun {
  runId?: string;
  teamName: string;
  progress?: TeamProvisioningProgress;
  onProgress?(progress: TeamProvisioningProgress): void;
  request: Pick<TeamCreateRequest, 'cwd'>;
}

export interface SingleMixedSecondaryRuntimeLaneStopPorts {
  teamsBasePath: string;
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  upsertOpenCodeRuntimeLaneIndexEntry(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
    state: 'stopped';
    diagnostics: string[];
  }): Promise<unknown>;
  clearOpenCodeRuntimeLaneStorage(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
    expectedRunId?: string;
  }): Promise<boolean>;
  deleteSecondaryRuntimeRun(teamName: string, laneId: string): void;
  logger: StopLogger;
}

export async function stopSingleMixedSecondaryRuntimeLane(
  run: SingleMixedSecondaryRuntimeLaneStopRun,
  lane: MixedSecondaryRuntimeLaneState,
  reason: TeamRuntimeStopInput['reason'],
  ports: SingleMixedSecondaryRuntimeLaneStopPorts
): Promise<void> {
  const targetRunId = lane.runId;
  const targetCwd = lane.member.cwd?.trim() || run.request.cwd;
  if (!targetRunId) {
    return;
  }
  const adapter = ports.getOpenCodeRuntimeAdapter();
  const previousLaunchState = await ports.readLaunchState(run.teamName);
  const hadPreviousProgress = Object.prototype.hasOwnProperty.call(run, 'progress');
  const previousProgress = run.progress;
  let pendingStopProgress: TeamProvisioningProgress | null = null;
  let keepStopFence = false;

  try {
    if (!adapter) {
      throw new Error('OpenCode runtime adapter is unavailable');
    }
    const timestamp = new Date().toISOString();
    pendingStopProgress = {
      ...(previousProgress ?? {
        runId: targetRunId,
        teamName: run.teamName,
        startedAt: timestamp,
        updatedAt: timestamp,
      }),
      state: 'disconnected',
      message: 'Stopping OpenCode runtime lane before cleanup or relaunch',
      messageSeverity: undefined,
      updatedAt: timestamp,
      error: undefined,
    };
    run.progress = pendingStopProgress;
    run.onProgress?.(pendingStopProgress);

    const result = await adapter.stop({
      runId: targetRunId,
      laneId: lane.laneId,
      teamName: run.teamName,
      cwd: targetCwd,
      providerId: 'opencode',
      reason,
      previousLaunchState,
      force: true,
    });
    assertOpenCodeRuntimeStopSucceeded(result, `OpenCode lane ${lane.laneId} did not confirm stop`);
    keepStopFence = true;
    const cleared = await ports.clearOpenCodeRuntimeLaneStorage({
      teamsBasePath: ports.teamsBasePath,
      teamName: run.teamName,
      laneId: lane.laneId,
      expectedRunId: targetRunId,
    });
    if (!cleared) {
      if (lane.runId !== targetRunId) {
        keepStopFence = false;
        return;
      }
      throw new Error(
        `OpenCode lane ${lane.laneId} ownership changed before stopped storage cleanup`
      );
    }

    if (lane.runId !== targetRunId) {
      keepStopFence = false;
      return;
    }
    ports.deleteSecondaryRuntimeRun(run.teamName, lane.laneId);
    lane.runId = null;
    lane.state = 'finished';
    lane.result = null;
    lane.warnings = [];
    lane.diagnostics = [];
    keepStopFence = false;
  } catch (error) {
    if (keepStopFence && pendingStopProgress && run.progress === pendingStopProgress) {
      const failedProgress: TeamProvisioningProgress = {
        ...pendingStopProgress,
        state: 'failed',
        message: 'OpenCode runtime lane stopped but exact cleanup failed',
        messageSeverity: 'error',
        updatedAt: new Date().toISOString(),
        error: error instanceof Error ? error.message : String(error),
      };
      run.progress = failedProgress;
      run.onProgress?.(failedProgress);
    }
    ports.logger.warn(
      `[${run.teamName}] Failed to stop mixed OpenCode lane ${lane.laneId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    throw error;
  } finally {
    if (!keepStopFence && pendingStopProgress && run.progress === pendingStopProgress) {
      if (previousProgress) {
        run.progress = previousProgress;
        run.onProgress?.(previousProgress);
      } else if (hadPreviousProgress) {
        run.progress = undefined;
      } else {
        delete run.progress;
      }
    }
  }
}

export async function stopMixedSecondaryRuntimeLanes(
  teamName: string,
  ports: OpenCodeRuntimeStopFlowPorts
): Promise<void> {
  // The store returns live lane objects. Snapshot every stop target before the
  // first await so a same-lane relaunch cannot retarget this cleanup in place.
  const secondaryRuns = ports
    .getSecondaryRuntimeRuns(teamName)
    .map((secondaryRun) => ({ ...secondaryRun }));
  if (secondaryRuns.length === 0) {
    return;
  }
  ports.stoppingSecondaryRuntimeTeams.add(teamName);
  try {
    const adapter = ports.getOpenCodeRuntimeAdapter();
    const previousLaunchState = await ports.readLaunchState(teamName);
    if (!adapter) {
      throw new Error('OpenCode runtime adapter is unavailable');
    }
    const stopFailures: Error[] = [];
    for (const secondaryRun of secondaryRuns) {
      try {
        const result = await adapter.stop({
          runId: secondaryRun.runId,
          laneId: secondaryRun.laneId,
          teamName,
          cwd: secondaryRun.cwd ?? ports.readPersistedTeamProjectPath(teamName) ?? undefined,
          providerId: 'opencode',
          reason: 'user_requested',
          previousLaunchState,
          force: true,
        });
        assertOpenCodeRuntimeStopSucceeded(
          result,
          `OpenCode secondary lane ${secondaryRun.laneId} did not confirm stop`
        );
      } catch (error) {
        const stopError = asError(error);
        stopFailures.push(stopError);
        ports.logger.warn(
          `[${teamName}] Failed to stop mixed OpenCode secondary lane ${secondaryRun.laneId}: ${
            stopError.message
          }`
        );
        continue;
      }

      // adapter.stop is an ownership handoff point. A relaunch may replace
      // the same lane object while it is awaited, so both storage and map
      // cleanup must be fenced by the immutable target runId.
      try {
        if (isCurrentSecondaryRuntimeRun(teamName, secondaryRun, ports)) {
          const cleared = await clearSecondaryRuntimeLaneStorage(
            teamName,
            secondaryRun.laneId,
            secondaryRun.runId,
            ports
          );
          if (!cleared) {
            if (!isCurrentSecondaryRuntimeRun(teamName, secondaryRun, ports)) {
              continue;
            }
            throw new Error(
              `OpenCode secondary lane ${secondaryRun.laneId} ownership changed before stopped storage cleanup`
            );
          }
          if (isCurrentSecondaryRuntimeRun(teamName, secondaryRun, ports)) {
            ports.deleteSecondaryRuntimeRun(teamName, secondaryRun.laneId);
          }
        }
      } catch (error) {
        const cleanupError = asError(error);
        stopFailures.push(cleanupError);
        ports.logger.warn(
          `[${teamName}] Failed to clean stopped OpenCode secondary lane ${secondaryRun.laneId}: ${cleanupError.message}`
        );
      }
    }
    if (stopFailures.length > 0) {
      throw stopFailures[0];
    }
  } finally {
    ports.stoppingSecondaryRuntimeTeams.delete(teamName);
  }
}

export async function stopOpenCodeRuntimeAdapterTeam(
  teamName: string,
  runId: string,
  ports: OpenCodeRuntimeStopFlowPorts
): Promise<void> {
  const adapter = ports.getOpenCodeRuntimeAdapter();
  const currentRuntimeRun = ports.runtimeAdapterRunByTeam.get(teamName);
  const runtimeRun = currentRuntimeRun?.runId === runId ? currentRuntimeRun : undefined;
  if (!adapter) {
    throw new Error('OpenCode runtime adapter is unavailable');
  }
  if (!ownsPrimaryRuntimeLane(teamName, runId, ports)) {
    throw new Error(`OpenCode primary lane is not owned by run ${runId}`);
  }
  const startedAt = ports.nowIso();
  const previousProgress = ports.runtimeAdapterProgressByRunId.get(runId);
  ports.setRuntimeAdapterProgress({
    runId,
    teamName,
    state: 'disconnected',
    message: 'Stopping OpenCode team through runtime adapter',
    startedAt: previousProgress?.startedAt ?? startedAt,
    updatedAt: startedAt,
  });
  ports.invalidateRuntimeSnapshotCaches(teamName);
  try {
    const previousLaunchState = await ports.readLaunchState(teamName);
    const result = await adapter.stop({
      runId,
      laneId: 'primary',
      teamName,
      cwd: runtimeRun?.cwd ?? ports.readPersistedTeamProjectPath(teamName) ?? undefined,
      providerId: 'opencode',
      reason: 'user_requested',
      previousLaunchState,
      force: true,
    });
    assertOpenCodeRuntimeStopSucceeded(result, 'OpenCode team did not confirm stop');

    if (!ownsPrimaryRuntimeLane(teamName, runId, ports)) {
      return;
    }
    ports.clearOpenCodeRuntimeToolApprovals(teamName, {
      runId,
      laneId: 'primary',
      emitDismiss: true,
    });
    const cleared = await clearPrimaryRuntimeLaneStorage(teamName, runId, ports);
    if (!cleared) {
      if (!ownsPrimaryRuntimeLane(teamName, runId, ports)) {
        return;
      }
      throw new Error('OpenCode primary lane ownership changed before stopped storage cleanup');
    }
    if (!ownsPrimaryRuntimeLane(teamName, runId, ports)) {
      return;
    }
    if (ports.runtimeAdapterRunByTeam.get(teamName)?.runId === runId) {
      ports.runtimeAdapterRunByTeam.delete(teamName);
    }
    if (ports.getAliveRunId(teamName) === runId) {
      ports.deleteAliveRunId(teamName);
    }
    if (ports.provisioningRunByTeam.get(teamName) === runId) {
      ports.provisioningRunByTeam.delete(teamName);
    }
    ports.setRuntimeAdapterProgress({
      runId,
      teamName,
      state: 'disconnected',
      message: 'OpenCode team stopped',
      startedAt: previousProgress?.startedAt ?? startedAt,
      updatedAt: ports.nowIso(),
      cliLogsTail: result.diagnostics.join('\n') || undefined,
      warnings: result.warnings.length > 0 ? result.warnings : undefined,
    });
    ports.invalidateRuntimeSnapshotCaches(teamName);
    ports.emitTeamChange({
      type: 'process',
      teamName,
      runId,
      detail: 'stopped',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ports.setRuntimeAdapterProgress({
      runId,
      teamName,
      state: 'failed',
      message: 'OpenCode team stop failed',
      messageSeverity: 'error',
      startedAt: previousProgress?.startedAt ?? startedAt,
      updatedAt: ports.nowIso(),
      error: message,
      cliLogsTail: message,
    });
    throw error;
  }
}

function assertOpenCodeRuntimeStopSucceeded(
  result: unknown,
  message: string
): asserts result is { stopped: true; diagnostics: string[]; warnings: string[] } {
  if (result && typeof result === 'object' && (result as { stopped?: unknown }).stopped === true) {
    return;
  }
  const stopResult = result as { diagnostics?: unknown; warnings?: unknown } | null;
  const diagnostics = Array.isArray(stopResult?.diagnostics)
    ? stopResult.diagnostics.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const warnings = Array.isArray(stopResult?.warnings)
    ? stopResult.warnings.filter((entry): entry is string => typeof entry === 'string')
    : [];
  const detail = [...diagnostics, ...warnings]
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join('; ');
  throw new Error(detail ? `${message}: ${detail}` : message);
}

function asError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isCurrentSecondaryRuntimeRun(
  teamName: string,
  targetRun: Pick<SecondaryRuntimeRunEntry, 'laneId' | 'runId'>,
  ports: Pick<OpenCodeRuntimeStopFlowPorts, 'getSecondaryRuntimeRuns'>
): boolean {
  return ports
    .getSecondaryRuntimeRuns(teamName)
    .some(
      (currentRun) => currentRun.laneId === targetRun.laneId && currentRun.runId === targetRun.runId
    );
}

async function clearSecondaryRuntimeLaneStorage(
  teamName: string,
  laneId: string,
  runId: string,
  ports: Pick<OpenCodeRuntimeStopFlowPorts, 'clearOpenCodeRuntimeLaneStorage' | 'teamsBasePath'>
): Promise<boolean> {
  return ports.clearOpenCodeRuntimeLaneStorage({
    teamsBasePath: ports.teamsBasePath,
    teamName,
    laneId,
    expectedRunId: runId,
  });
}

function ownsPrimaryRuntimeLane(
  teamName: string,
  runId: string,
  ports: Pick<
    OpenCodeRuntimeStopFlowPorts,
    'getAliveRunId' | 'provisioningRunByTeam' | 'runtimeAdapterRunByTeam'
  >
): boolean {
  return ownsOpenCodeRuntimeAdapterPrimaryLane({
    currentProvisioningRunId: ports.provisioningRunByTeam.get(teamName),
    currentAliveRunId: ports.getAliveRunId(teamName) ?? undefined,
    currentRuntimeRun: ports.runtimeAdapterRunByTeam.get(teamName),
    runId,
  });
}

async function clearPrimaryRuntimeLaneStorage(
  teamName: string,
  runId: string,
  ports: Pick<OpenCodeRuntimeStopFlowPorts, 'clearOpenCodeRuntimeLaneStorage' | 'teamsBasePath'>
): Promise<boolean> {
  return ports.clearOpenCodeRuntimeLaneStorage({
    teamsBasePath: ports.teamsBasePath,
    teamName,
    laneId: 'primary',
    expectedRunId: runId,
  });
}
