import { createPersistedLaunchSnapshot } from '../TeamLaunchStateEvaluator';

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
  }): Promise<unknown>;
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
  teamName: string;
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
  }): Promise<unknown>;
  deleteSecondaryRuntimeRun(teamName: string, laneId: string): void;
  logger: StopLogger;
}

export async function stopSingleMixedSecondaryRuntimeLane(
  run: SingleMixedSecondaryRuntimeLaneStopRun,
  lane: MixedSecondaryRuntimeLaneState,
  reason: TeamRuntimeStopInput['reason'],
  ports: SingleMixedSecondaryRuntimeLaneStopPorts
): Promise<void> {
  const adapter = ports.getOpenCodeRuntimeAdapter();
  const previousLaunchState = await ports.readLaunchState(run.teamName);
  await ports
    .upsertOpenCodeRuntimeLaneIndexEntry({
      teamsBasePath: ports.teamsBasePath,
      teamName: run.teamName,
      laneId: lane.laneId,
      state: 'stopped',
      diagnostics: [`OpenCode lane stop requested: ${reason}`],
    })
    .catch(() => undefined);

  try {
    if (adapter && lane.runId) {
      await adapter.stop({
        runId: lane.runId,
        laneId: lane.laneId,
        teamName: run.teamName,
        cwd: lane.member.cwd?.trim() || run.request.cwd,
        providerId: 'opencode',
        reason,
        previousLaunchState,
        force: true,
      });
    }
  } catch (error) {
    ports.logger.warn(
      `[${run.teamName}] Failed to stop mixed OpenCode lane ${lane.laneId}: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
  } finally {
    await ports
      .clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: ports.teamsBasePath,
        teamName: run.teamName,
        laneId: lane.laneId,
      })
      .catch(() => undefined);
    ports.deleteSecondaryRuntimeRun(run.teamName, lane.laneId);
    lane.runId = null;
    lane.state = 'finished';
    lane.result = null;
    lane.warnings = [];
    lane.diagnostics = [];
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
      for (const secondaryRun of secondaryRuns) {
        if (!isCurrentSecondaryRuntimeRun(teamName, secondaryRun, ports)) {
          continue;
        }
        await clearSecondaryRuntimeLaneStorage(teamName, secondaryRun.laneId, ports);
        if (isCurrentSecondaryRuntimeRun(teamName, secondaryRun, ports)) {
          ports.deleteSecondaryRuntimeRun(teamName, secondaryRun.laneId);
        }
      }
      return;
    }
    for (const secondaryRun of secondaryRuns) {
      if (isCurrentSecondaryRuntimeRun(teamName, secondaryRun, ports)) {
        await clearSecondaryRuntimeLaneStorage(teamName, secondaryRun.laneId, ports);
      }
      try {
        await adapter.stop({
          runId: secondaryRun.runId,
          laneId: secondaryRun.laneId,
          teamName,
          cwd: secondaryRun.cwd ?? ports.readPersistedTeamProjectPath(teamName) ?? undefined,
          providerId: 'opencode',
          reason: 'user_requested',
          previousLaunchState,
          force: true,
        });
      } catch (error) {
        ports.logger.warn(
          `[${teamName}] Failed to stop mixed OpenCode secondary lane ${secondaryRun.laneId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      } finally {
        // adapter.stop is an ownership handoff point. A relaunch may replace
        // the same lane object while it is awaited, so both storage and map
        // cleanup must be fenced by the immutable target runId.
        if (isCurrentSecondaryRuntimeRun(teamName, secondaryRun, ports)) {
          await clearSecondaryRuntimeLaneStorage(teamName, secondaryRun.laneId, ports);
          if (isCurrentSecondaryRuntimeRun(teamName, secondaryRun, ports)) {
            ports.deleteSecondaryRuntimeRun(teamName, secondaryRun.laneId);
          }
        }
      }
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
  const previousLaunchState = await ports.readLaunchState(teamName);
  if (!adapter) {
    if (ownsPrimaryRuntimeLane(teamName, runId, ports)) {
      await clearPrimaryRuntimeLaneStorage(teamName, ports);
    }
    // Gate the no-adapter cleanup on exact ownership too: this also runs after an
    // await (clearOpenCodeRuntimeLaneStorage), so a newer run registered in the
    // meantime must not have its tracking wiped by teamName.
    if (ports.runtimeAdapterRunByTeam.get(teamName)?.runId === runId) {
      ports.runtimeAdapterRunByTeam.delete(teamName);
    }
    if (ports.getAliveRunId(teamName) === runId) {
      ports.deleteAliveRunId(teamName);
    }
    if (ports.provisioningRunByTeam.get(teamName) === runId) {
      ports.provisioningRunByTeam.delete(teamName);
    }
    ports.invalidateRuntimeSnapshotCaches(teamName);
    return;
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
  ports.clearOpenCodeRuntimeToolApprovals(teamName, {
    runId,
    laneId: 'primary',
    emitDismiss: true,
  });
  if (ports.runtimeAdapterRunByTeam.get(teamName)?.runId === runId) {
    ports.runtimeAdapterRunByTeam.delete(teamName);
  }
  if (ports.getAliveRunId(teamName) === runId) {
    ports.deleteAliveRunId(teamName);
  }
  if (ports.provisioningRunByTeam.get(teamName) === runId) {
    ports.provisioningRunByTeam.delete(teamName);
  }
  ports.invalidateRuntimeSnapshotCaches(teamName);
  try {
    if (ownsPrimaryRuntimeLane(teamName, runId, ports)) {
      await clearPrimaryRuntimeLaneStorage(teamName, ports);
    }
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
    await ports.writeLaunchStateSnapshot(
      teamName,
      createPersistedLaunchSnapshot({
        teamName,
        expectedMembers: previousLaunchState?.expectedMembers ?? [],
        leadSessionId: previousLaunchState?.leadSessionId,
        launchPhase: 'reconciled',
        members: previousLaunchState?.members ?? {},
      })
    );
    ports.setRuntimeAdapterProgress({
      runId,
      teamName,
      state: result.stopped ? 'disconnected' : 'failed',
      message: result.stopped ? 'OpenCode team stopped' : 'OpenCode team stop failed',
      messageSeverity: result.stopped ? undefined : 'error',
      startedAt: previousProgress?.startedAt ?? startedAt,
      updatedAt: ports.nowIso(),
      cliLogsTail: result.diagnostics.join('\n') || undefined,
      warnings: result.warnings.length > 0 ? result.warnings : undefined,
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
  } finally {
    // Every await above permits a lockless relaunch. Revalidate all primary
    // ownership maps before the final shared-storage clear; any newer owner is
    // authoritative and its lane artifacts must survive this old stop.
    if (ownsPrimaryRuntimeLane(teamName, runId, ports)) {
      await clearPrimaryRuntimeLaneStorage(teamName, ports);
    }
    // Only wipe tracking if THIS run still owns it. This runs AFTER the long
    // `await adapter.stop`, during which a concurrent (lockless) stop/relaunch
    // can register a NEWER run for the team; deleting by teamName unconditionally
    // would orphan that newer run's tracking (its OpenCode sessions stay alive
    // while the UI shows not-launched -> ghost-alive, and the next launch
    // double-spawns).
    if (ports.runtimeAdapterRunByTeam.get(teamName)?.runId === runId) {
      ports.runtimeAdapterRunByTeam.delete(teamName);
    }
    if (ports.getAliveRunId(teamName) === runId) {
      ports.deleteAliveRunId(teamName);
    }
    if (ports.provisioningRunByTeam.get(teamName) === runId) {
      ports.provisioningRunByTeam.delete(teamName);
    }
    ports.emitTeamChange({
      type: 'process',
      teamName,
      runId,
      detail: 'stopped',
    });
  }
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
  ports: Pick<OpenCodeRuntimeStopFlowPorts, 'clearOpenCodeRuntimeLaneStorage' | 'teamsBasePath'>
): Promise<void> {
  await ports
    .clearOpenCodeRuntimeLaneStorage({
      teamsBasePath: ports.teamsBasePath,
      teamName,
      laneId,
    })
    .catch(() => undefined);
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
  ports: Pick<OpenCodeRuntimeStopFlowPorts, 'clearOpenCodeRuntimeLaneStorage' | 'teamsBasePath'>
): Promise<void> {
  await ports
    .clearOpenCodeRuntimeLaneStorage({
      teamsBasePath: ports.teamsBasePath,
      teamName,
      laneId: 'primary',
    })
    .catch(() => undefined);
}
