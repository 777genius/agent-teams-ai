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
  }): Promise<void>;
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

export function ownsOpenCodeRuntimeAdapterPrimaryLane(
  input: PrimaryLaneOwnershipInput
): boolean {
  return (
    input.currentProvisioningRunId === input.runId ||
    input.currentAliveRunId === input.runId ||
    input.currentRuntimeRun?.runId === input.runId ||
    (!input.currentProvisioningRunId && !input.currentAliveRunId && !input.currentRuntimeRun)
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
  const runtimeRun = ports.runtimeAdapterRunByTeam.get(teamName);
  ports.cancelledRuntimeAdapterRunIds.add(runId);
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

  const previousLaunchState = await ports.readLaunchState(teamName);
  const adapter = ports.getOpenCodeRuntimeAdapter();
  if (adapter) {
    try {
      await adapter.stop({
        runId,
        laneId: 'primary',
        teamName,
        cwd: runtimeRun?.cwd ?? ports.readPersistedTeamProjectPath(teamName) ?? undefined,
        providerId: 'opencode',
        reason: 'user_requested',
        previousLaunchState,
        force: true,
      });
    } catch (error) {
      ports.logWarning(
        `[${teamName}] Failed to stop OpenCode runtime adapter launch during cancel: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }

  await ports
    .clearOpenCodeRuntimeLaneStorage({
      teamsBasePath: ports.teamsBasePath,
      teamName,
      laneId: 'primary',
    })
    .catch(() => undefined);
}

export async function clearOpenCodeRuntimeAdapterPrimaryLaneIfOwned(input: {
  teamName: string;
  runId: string;
  ports: RuntimeAdapterCancellationPorts;
}): Promise<void> {
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
    return;
  }

  await ports
    .clearOpenCodeRuntimeLaneStorage({
      teamsBasePath: ports.teamsBasePath,
      teamName,
      laneId: 'primary',
    })
    .catch(() => undefined);
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
  ports.provisioningRunByTeam.delete(teamName);
  ports.runtimeAdapterRunByTeam.delete(teamName);
  ports.deleteAliveRunId(teamName);
  ports.invalidateRuntimeSnapshotCaches(teamName);
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
