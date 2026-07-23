import type { TeamLaunchRuntimeAdapter } from '../runtime';
import type {
  PersistedTeamLaunchSnapshot,
  TeamChangeEvent,
  TeamLaunchResponse,
  TeamProviderId,
  TeamProvisioningProgress,
} from '@shared/types';

export interface RuntimeAdapterRunEntry {
  runId: string;
  providerId: TeamProviderId;
  cwd?: string;
}

export interface RuntimeAdapterCancellationPorts {
  cancelledRuntimeAdapterRunIds: Set<string>;
  runtimeAdapterRunByTeam: Map<string, RuntimeAdapterRunEntry>;
  runtimeAdapterProgressByRunId?: Map<string, TeamProvisioningProgress>;
  provisioningRunByTeam: Map<string, string>;
  aliveRunByTeam: ReadonlyMap<string, string>;
  teamsBasePath: string;
  nowIso(): string;
  clearOpenCodeRuntimeToolApprovals(
    teamName: string,
    options: { runId?: string; laneId?: string; emitDismiss?: boolean }
  ): void;
  deleteAliveRunId(teamName: string): void;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  setRuntimeAdapterProgress(
    progress: TeamProvisioningProgress,
    onProgress?: (progress: TeamProvisioningProgress) => void
  ): TeamProvisioningProgress;
  emitTeamChange(event: TeamChangeEvent): void;
  readLaunchState(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  getOpenCodeRuntimeAdapter(): TeamLaunchRuntimeAdapter | null;
  readPersistedTeamProjectPath(teamName: string): string | null;
  clearOpenCodeRuntimeLaneStorage(input: {
    teamsBasePath: string;
    teamName: string;
    laneId: string;
    expectedRunId?: string;
  }): Promise<boolean>;
  logWarning(message: string): void;
}

export interface PrimaryLaneOwnershipInput {
  currentProvisioningRunId: string | undefined;
  currentAliveRunId: string | undefined;
  currentRuntimeRun: RuntimeAdapterRunEntry | undefined;
  runId: string;
}

export function isCancellableRuntimeAdapterProgress(
  progress: Pick<TeamProvisioningProgress, 'state'>
): boolean {
  return [
    'validating',
    'spawning',
    'configuring',
    'assembling',
    'finalizing',
    'verifying',
  ].includes(progress.state);
}

export function ownsOpenCodeRuntimeAdapterPrimaryLane(input: PrimaryLaneOwnershipInput): boolean {
  const currentOwnerRunIds = [
    input.currentProvisioningRunId,
    input.currentAliveRunId,
    input.currentRuntimeRun?.runId,
  ];
  return (
    currentOwnerRunIds.some((currentOwnerRunId) => currentOwnerRunId === input.runId) &&
    currentOwnerRunIds.every(
      (currentOwnerRunId) => !currentOwnerRunId || currentOwnerRunId === input.runId
    )
  );
}

export function buildCancelledOpenCodeRuntimeAdapterLaunchProgress(input: {
  runId: string;
  teamName: string;
  timestamp: string;
  sourceWarning?: string;
}): TeamProvisioningProgress {
  return {
    runId: input.runId,
    teamName: input.teamName,
    state: 'cancelled',
    message: 'Provisioning cancelled by user',
    startedAt: input.timestamp,
    updatedAt: input.timestamp,
    warnings: input.sourceWarning ? [input.sourceWarning] : undefined,
  };
}

export async function cancelRuntimeAdapterProvisioning(input: {
  runId: string;
  runtimeProgress: TeamProvisioningProgress;
  ports: RuntimeAdapterCancellationPorts;
}): Promise<void> {
  const { ports, runId, runtimeProgress } = input;
  if (!isCancellableRuntimeAdapterProgress(runtimeProgress)) {
    throw new Error('Provisioning cannot be cancelled in current state');
  }

  const teamName = runtimeProgress.teamName;
  const currentRuntimeRun = ports.runtimeAdapterRunByTeam.get(teamName);
  const runtimeRun = currentRuntimeRun?.runId === runId ? currentRuntimeRun : undefined;
  ports.cancelledRuntimeAdapterRunIds.add(runId);
  ports.setRuntimeAdapterProgress({
    ...runtimeProgress,
    state: 'cancelled',
    message: 'Provisioning cancellation requested; stopping OpenCode runtime',
    updatedAt: ports.nowIso(),
  });
  ports.invalidateRuntimeSnapshotCaches(teamName);

  const previousLaunchState = await ports.readLaunchState(teamName);
  const adapter = ports.getOpenCodeRuntimeAdapter();
  let stopConfirmed = false;
  if (adapter) {
    try {
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
      if (!result.stopped) {
        const detail = [...result.diagnostics, ...result.warnings]
          .map((entry) => entry.trim())
          .filter(Boolean)
          .join('; ');
        throw new Error(
          detail
            ? `OpenCode runtime adapter launch did not confirm stop: ${detail}`
            : 'OpenCode runtime adapter launch did not confirm stop'
        );
      }
      stopConfirmed = true;
    } catch (error) {
      ports.logWarning(
        `[${teamName}] Failed to stop OpenCode runtime adapter launch during cancel: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  } else {
    ports.logWarning(
      `[${teamName}] Failed to stop OpenCode runtime adapter launch during cancel: OpenCode runtime adapter is unavailable`
    );
  }

  if (stopConfirmed) {
    ports.clearOpenCodeRuntimeToolApprovals(teamName, {
      runId,
      laneId: 'primary',
      emitDismiss: true,
    });
    await clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned({ teamName, runId, ports });
    ports.setRuntimeAdapterProgress({
      ...runtimeProgress,
      state: 'cancelled',
      message: 'Provisioning cancelled by user',
      updatedAt: ports.nowIso(),
    });
    ports.emitTeamChange({
      type: 'process',
      teamName,
      runId,
      detail: 'cancelled',
    });
    return;
  }

  ports.setRuntimeAdapterProgress({
    ...runtimeProgress,
    state: 'failed',
    message: 'Provisioning cancellation could not stop the OpenCode runtime',
    messageSeverity: 'error',
    updatedAt: ports.nowIso(),
  });
  throw new Error('OpenCode runtime adapter launch did not confirm stop during cancellation');
}

export async function clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(input: {
  teamName: string;
  runId: string;
  ports: RuntimeAdapterCancellationPorts;
}): Promise<boolean> {
  const { ports, runId, teamName } = input;
  const currentProvisioningRunId = ports.provisioningRunByTeam.get(teamName);
  const currentAliveRunId = ports.aliveRunByTeam.get(teamName);
  const currentRuntimeRun = ports.runtimeAdapterRunByTeam.get(teamName);
  if (
    !ownsOpenCodeRuntimeAdapterPrimaryLane({
      currentProvisioningRunId,
      currentAliveRunId,
      currentRuntimeRun,
      runId,
    })
  ) {
    return false;
  }

  const cleared = await ports.clearOpenCodeRuntimeLaneStorage({
    teamsBasePath: ports.teamsBasePath,
    teamName,
    laneId: 'primary',
    expectedRunId: runId,
  });
  if (!cleared) {
    return false;
  }
  if (ports.runtimeAdapterRunByTeam.get(teamName)?.runId === runId) {
    ports.runtimeAdapterRunByTeam.delete(teamName);
  }
  if (ports.aliveRunByTeam.get(teamName) === runId) {
    ports.deleteAliveRunId(teamName);
  }
  if (ports.provisioningRunByTeam.get(teamName) === runId) {
    ports.provisioningRunByTeam.delete(teamName);
  }
  ports.invalidateRuntimeSnapshotCaches(teamName);
  return true;
}

export async function stopAndClearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(input: {
  teamName: string;
  runId: string;
  ports: RuntimeAdapterCancellationPorts;
}): Promise<boolean> {
  const { ports, runId, teamName } = input;
  const previousRuntimeOwner = ports.runtimeAdapterRunByTeam.get(teamName);
  const runtimeRun = previousRuntimeOwner?.runId === runId ? previousRuntimeOwner : undefined;
  const cwd = runtimeRun?.cwd ?? ports.readPersistedTeamProjectPath(teamName) ?? undefined;
  const stopOwner: RuntimeAdapterRunEntry =
    runtimeRun ??
    ({
      runId,
      providerId: 'opencode',
      cwd,
    } satisfies RuntimeAdapterRunEntry);
  const installedStopOwner = previousRuntimeOwner === undefined;
  const previousProvisioningOwner = ports.provisioningRunByTeam.get(teamName);
  const installedProvisioningOwner = previousProvisioningOwner === undefined;
  if (installedStopOwner) {
    ports.runtimeAdapterRunByTeam.set(teamName, stopOwner);
  }
  if (installedProvisioningOwner) {
    ports.provisioningRunByTeam.set(teamName, runId);
  }
  const previousProgress = ports.runtimeAdapterProgressByRunId?.get(runId);
  const timestamp = ports.nowIso();
  const nextPendingStopProgress: TeamProvisioningProgress = {
    ...(previousProgress ?? {
      runId,
      teamName,
      startedAt: timestamp,
      updatedAt: timestamp,
    }),
    runId,
    teamName,
    state: 'disconnected',
    message: 'Stopping cancelled OpenCode runtime launch',
    messageSeverity: undefined,
    updatedAt: timestamp,
    error: undefined,
  };
  const pendingStopProgress = ports.runtimeAdapterProgressByRunId
    ? nextPendingStopProgress
    : ports.setRuntimeAdapterProgress(nextPendingStopProgress);
  ports.runtimeAdapterProgressByRunId?.set(runId, pendingStopProgress);
  ports.invalidateRuntimeSnapshotCaches(teamName);

  const rollbackPendingStopIfExact = (): void => {
    let changed = false;
    if (installedStopOwner && ports.runtimeAdapterRunByTeam.get(teamName) === stopOwner) {
      ports.runtimeAdapterRunByTeam.delete(teamName);
      changed = true;
    }
    if (installedProvisioningOwner && ports.provisioningRunByTeam.get(teamName) === runId) {
      ports.provisioningRunByTeam.delete(teamName);
      changed = true;
    }
    if (ports.runtimeAdapterProgressByRunId?.get(runId) === pendingStopProgress) {
      if (previousProgress) {
        ports.runtimeAdapterProgressByRunId.set(runId, previousProgress);
      } else {
        ports.runtimeAdapterProgressByRunId.delete(runId);
      }
      changed = true;
    }
    if (changed) {
      ports.invalidateRuntimeSnapshotCaches(teamName);
    }
  };

  let stopConfirmed = false;
  try {
    const adapter = ports.getOpenCodeRuntimeAdapter();
    if (!adapter) {
      throw new Error('OpenCode runtime adapter is unavailable');
    }
    const previousLaunchState = await ports.readLaunchState(teamName);
    const result = await adapter.stop({
      runId,
      laneId: 'primary',
      teamName,
      cwd,
      providerId: 'opencode',
      reason: 'user_requested',
      previousLaunchState,
      force: true,
    });
    if (!result.stopped) {
      const detail = [...result.diagnostics, ...result.warnings]
        .map((entry) => entry.trim())
        .filter(Boolean)
        .join('; ');
      throw new Error(
        detail
          ? `OpenCode runtime adapter launch did not confirm stop: ${detail}`
          : 'OpenCode runtime adapter launch did not confirm stop'
      );
    }
    stopConfirmed = true;

    ports.clearOpenCodeRuntimeToolApprovals(teamName, {
      runId,
      laneId: 'primary',
      emitDismiss: true,
    });
    const cleared = await clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned({
      teamName,
      runId,
      ports,
    });
    if (!cleared) {
      rollbackPendingStopIfExact();
    }
    return cleared;
  } catch (error) {
    if (!stopConfirmed) {
      rollbackPendingStopIfExact();
    }
    ports.logWarning(
      `[${teamName}] Failed to stop OpenCode runtime adapter launch before primary lane cleanup: ${
        error instanceof Error ? error.message : String(error)
      }`
    );
    return false;
  }
}

export function recordCancelledOpenCodeRuntimeAdapterLaunch(input: {
  teamName: string;
  sourceWarning: string | undefined;
  onProgress: (progress: TeamProvisioningProgress) => void;
  createRunId(): string;
  ports: RuntimeAdapterCancellationPorts;
}): TeamLaunchResponse {
  const { onProgress, ports, sourceWarning, teamName } = input;
  const runId = input.createRunId();
  const timestamp = ports.nowIso();
  const progress = buildCancelledOpenCodeRuntimeAdapterLaunchProgress({
    runId,
    teamName,
    timestamp,
    sourceWarning,
  });
  ports.setRuntimeAdapterProgress(progress, onProgress);
  ports.emitTeamChange({
    type: 'process',
    teamName,
    runId,
    detail: 'cancelled',
  });
  return { runId };
}
