import { createPersistedLaunchSnapshot } from '../TeamLaunchStateEvaluator';

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
  const secondaryRuns = ports.getSecondaryRuntimeRuns(teamName);
  if (secondaryRuns.length === 0) {
    return;
  }
  ports.stoppingSecondaryRuntimeTeams.add(teamName);
  try {
    const adapter = ports.getOpenCodeRuntimeAdapter();
    const previousLaunchState = await ports.readLaunchState(teamName);
    if (!adapter) {
      await Promise.all(
        secondaryRuns.map((secondaryRun) =>
          ports
            .clearOpenCodeRuntimeLaneStorage({
              teamsBasePath: ports.teamsBasePath,
              teamName,
              laneId: secondaryRun.laneId,
            })
            .catch(() => undefined)
        )
      );
      ports.clearSecondaryRuntimeRuns(teamName);
      return;
    }
    try {
      for (const secondaryRun of secondaryRuns) {
        await ports
          .clearOpenCodeRuntimeLaneStorage({
            teamsBasePath: ports.teamsBasePath,
            teamName,
            laneId: secondaryRun.laneId,
          })
          .catch(() => undefined);
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
          await ports
            .clearOpenCodeRuntimeLaneStorage({
              teamsBasePath: ports.teamsBasePath,
              teamName,
              laneId: secondaryRun.laneId,
            })
            .catch(() => undefined);
          ports.deleteSecondaryRuntimeRun(teamName, secondaryRun.laneId);
        }
      }
    } finally {
      ports.clearSecondaryRuntimeRuns(teamName);
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
  const previousLaunchState = await ports.readLaunchState(teamName);
  if (!adapter) {
    await ports
      .clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: ports.teamsBasePath,
        teamName,
        laneId: 'primary',
      })
      .catch(() => undefined);
    ports.runtimeAdapterRunByTeam.delete(teamName);
    ports.deleteAliveRunId(teamName);
    ports.provisioningRunByTeam.delete(teamName);
    ports.invalidateRuntimeSnapshotCaches(teamName);
    return;
  }
  const startedAt = ports.nowIso();
  const previousProgress = ports.runtimeAdapterProgressByRunId.get(runId);
  const runtimeRun = ports.runtimeAdapterRunByTeam.get(teamName);
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
  ports.runtimeAdapterRunByTeam.delete(teamName);
  ports.deleteAliveRunId(teamName);
  if (ports.provisioningRunByTeam.get(teamName) === runId) {
    ports.provisioningRunByTeam.delete(teamName);
  }
  ports.invalidateRuntimeSnapshotCaches(teamName);
  try {
    await ports
      .clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: ports.teamsBasePath,
        teamName,
        laneId: 'primary',
      })
      .catch(() => undefined);
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
    await ports
      .clearOpenCodeRuntimeLaneStorage({
        teamsBasePath: ports.teamsBasePath,
        teamName,
        laneId: 'primary',
      })
      .catch(() => undefined);
    ports.runtimeAdapterRunByTeam.delete(teamName);
    ports.deleteAliveRunId(teamName);
    ports.provisioningRunByTeam.delete(teamName);
    ports.emitTeamChange({
      type: 'process',
      teamName,
      runId,
      detail: 'stopped',
    });
  }
}
