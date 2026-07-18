import type { TeamProvisioningProgress } from '@shared/types';

interface StopLogger {
  info(message: string): void;
}

interface RuntimeAdapterRunEntry {
  runId: string;
  providerId: string;
}

export interface TeamProvisioningStopRun {
  runId: string;
  teamName: string;
  processKilled: boolean;
  cancelRequested: boolean;
  child: unknown;
  onProgress(progress: TeamProvisioningProgress): void;
}

export interface TeamProvisioningStopTeamPorts<TRun extends TeamProvisioningStopRun> {
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  pauseActiveIntervalsForTeam(teamName: string): void;
  stopPersistentTeamMembers(teamName: string): void;
  openCodeRuntimeDeliveryAdvisory: { cancelTeam(teamName: string): void };
  getTrackedRunId(teamName: string): string | null;
  getAliveRunId(teamName: string): string | null;
  runs: ReadonlyMap<string, TRun>;
  runtimeAdapterProgressByRunId: ReadonlyMap<string, TeamProvisioningProgress>;
  isCancellableRuntimeAdapterProgress(progress: TeamProvisioningProgress): boolean;
  cancelRuntimeAdapterProvisioning(
    runId: string,
    progress: TeamProvisioningProgress
  ): Promise<void>;
  cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName: string): Promise<void>;
  runtimeAdapterRunByTeam: ReadonlyMap<string, RuntimeAdapterRunEntry>;
  withTeamLock<T>(teamName: string, fn: () => Promise<T>): Promise<T>;
  stopOpenCodeRuntimeAdapterTeam(teamName: string, runId: string): Promise<void>;
  hasSecondaryRuntimeRuns(teamName: string): boolean;
  stopMixedSecondaryRuntimeLanes(teamName: string): Promise<void>;
  provisioningRunByTeam: Map<string, string>;
  deleteAliveRunId(teamName: string): void;
  killTeamProcess(child: TRun['child']): void;
  updateProgress(
    run: TRun,
    state: Exclude<TeamProvisioningProgress['state'], 'idle'>,
    message: string
  ): TeamProvisioningProgress;
  cleanupRun(run: TRun): void;
  logger: StopLogger;
}

export interface TeamProvisioningStopAllPorts {
  incrementStopAllTeamsGeneration(): void;
  getShutdownTrackedTeamNames(): string[];
  pauseActiveIntervalsForTeam(teamName: string): void;
  killTrackedCliProcesses(signal: 'SIGKILL'): void;
  killTransientProbeProcessesForShutdown(): void;
  stopTrackedTeamsForShutdown(label: string): Promise<string[]>;
  cancelPendingRuntimeAdapterLaunchesForShutdown(): Promise<void>;
  waitForInFlightTeamOperationsForShutdown(): Promise<void>;
  listPersistedTeamNames(): string[];
  stopPersistentTeamMembers(teamName: string): void;
  cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName: string): Promise<void>;
  logger: StopLogger;
}

export function getOrphanPersistedTeamNames(
  persistedTeamNames: readonly string[],
  trackedTeamNames: Iterable<string>
): string[] {
  const tracked = new Set(trackedTeamNames);
  return persistedTeamNames.filter((teamName) => !tracked.has(teamName));
}

async function stopRuntimeLanesOwnedByRun<TRun extends TeamProvisioningStopRun>(
  teamName: string,
  runId: string,
  ports: TeamProvisioningStopTeamPorts<TRun>
): Promise<void> {
  const runtimeRun = ports.runtimeAdapterRunByTeam.get(teamName);
  const shouldStopPrimaryRuntime =
    runtimeRun?.runId === runId && runtimeRun.providerId === 'opencode';
  const shouldStopSecondaryRuntimes = ports.hasSecondaryRuntimeRuns(teamName);

  // Keep the order deterministic and leave secondary tracking untouched when
  // the required primary stop fails. The low-level stop flows own their lane
  // cleanup after each confirmed stop.
  if (shouldStopPrimaryRuntime) {
    await ports.stopOpenCodeRuntimeAdapterTeam(teamName, runId);
  }
  if (shouldStopSecondaryRuntimes) {
    await ports.stopMixedSecondaryRuntimeLanes(teamName);
  }
}

async function stopTeamRuntimeFlow<TRun extends TeamProvisioningStopRun>(
  teamName: string,
  ports: TeamProvisioningStopTeamPorts<TRun>
): Promise<void> {
  ports.invalidateRuntimeSnapshotCaches(teamName);
  ports.pauseActiveIntervalsForTeam(teamName);
  ports.stopPersistentTeamMembers(teamName);
  ports.openCodeRuntimeDeliveryAdvisory.cancelTeam(teamName);

  let runId = ports.getTrackedRunId(teamName);
  if (!runId) {
    if (ports.hasSecondaryRuntimeRuns(teamName)) {
      await ports.stopMixedSecondaryRuntimeLanes(teamName);
    }
    return;
  }
  let run = ports.runs.get(runId);
  const aliveRunId = ports.getAliveRunId(teamName);
  if (!run && aliveRunId && aliveRunId !== runId) {
    if (ports.provisioningRunByTeam.get(teamName) === runId) {
      ports.provisioningRunByTeam.delete(teamName);
    }
    runId = aliveRunId;
    run = ports.runs.get(runId);
  }
  if (!run) {
    const runtimeProgress = ports.runtimeAdapterProgressByRunId.get(runId);
    if (runtimeProgress && ports.isCancellableRuntimeAdapterProgress(runtimeProgress)) {
      await ports.cancelRuntimeAdapterProvisioning(runId, runtimeProgress);
      return;
    }
    const runtimeRun = ports.runtimeAdapterRunByTeam.get(teamName);
    if (runtimeRun?.runId === runId && runtimeRun.providerId === 'opencode') {
      const shouldStopSecondaryRuntimes = ports.hasSecondaryRuntimeRuns(teamName);
      await ports.withTeamLock(teamName, async () => {
        const currentRuntimeRun = ports.runtimeAdapterRunByTeam.get(teamName);
        if (currentRuntimeRun?.runId === runId && currentRuntimeRun.providerId === 'opencode') {
          await ports.stopOpenCodeRuntimeAdapterTeam(teamName, runId);
        }
      });
      if (shouldStopSecondaryRuntimes) {
        await ports.stopMixedSecondaryRuntimeLanes(teamName);
      }
      return;
    }
    if (ports.hasSecondaryRuntimeRuns(teamName)) {
      await ports.stopMixedSecondaryRuntimeLanes(teamName);
    }
    if (ports.provisioningRunByTeam.get(teamName) === runId) {
      ports.provisioningRunByTeam.delete(teamName);
    }
    if (ports.getAliveRunId(teamName) === runId) {
      ports.deleteAliveRunId(teamName);
    }
    return;
  }
  if (run.processKilled || run.cancelRequested) {
    await stopRuntimeLanesOwnedByRun(teamName, run.runId, ports);
    return;
  }
  run.processKilled = true;
  run.cancelRequested = true;
  ports.killTeamProcess(run.child);
  await stopRuntimeLanesOwnedByRun(teamName, run.runId, ports);
  const progress = ports.updateProgress(run, 'disconnected', 'Team stopped by user');
  run.onProgress(progress);
  ports.cleanupRun(run);
  ports.logger.info(`[${teamName}] Process stopped (SIGKILL)`);
}

export async function stopTeamFlow<TRun extends TeamProvisioningStopRun>(
  teamName: string,
  ports: TeamProvisioningStopTeamPorts<TRun>
): Promise<void> {
  try {
    await stopTeamRuntimeFlow(teamName, ports);
  } finally {
    await ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName);
  }
}

export async function stopAllTeamsFlow(ports: TeamProvisioningStopAllPorts): Promise<void> {
  ports.incrementStopAllTeamsGeneration();
  for (const teamName of ports.getShutdownTrackedTeamNames()) {
    ports.pauseActiveIntervalsForTeam(teamName);
  }
  ports.killTrackedCliProcesses('SIGKILL');
  ports.killTransientProbeProcessesForShutdown();

  const initialTracked = await ports.stopTrackedTeamsForShutdown('Shutdown');
  await ports.cancelPendingRuntimeAdapterLaunchesForShutdown();

  // A create/launch may have been inside a per-team lock before it exposed a run.
  // Wait briefly, then rescan for anything that became visible during shutdown.
  await ports.waitForInFlightTeamOperationsForShutdown();
  await ports.cancelPendingRuntimeAdapterLaunchesForShutdown();
  await ports.stopTrackedTeamsForShutdown('Shutdown follow-up');

  const persistedTeamNames = ports.listPersistedTeamNames();
  const orphanOnly = getOrphanPersistedTeamNames(persistedTeamNames, [
    ...initialTracked,
    ...ports.getShutdownTrackedTeamNames(),
  ]);
  if (orphanOnly.length > 0) {
    ports.logger.info(
      `Cleaning up persisted teammate runtimes on shutdown: ${orphanOnly.join(', ')}`
    );
    for (const teamName of orphanOnly) {
      ports.pauseActiveIntervalsForTeam(teamName);
      ports.stopPersistentTeamMembers(teamName);
      await ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName);
    }
  }
}
