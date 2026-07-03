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

export interface TeamProvisioningPersistentStopPorts<TMember> {
  readPersistedRuntimeMembers(teamName: string): TMember[];
  killPersistedPaneMembers(teamName: string, members: TMember[]): void;
  killOrphanedTeamAgentProcesses(teamName: string): void;
}

export function getOrphanPersistedTeamNames(
  persistedTeamNames: readonly string[],
  trackedTeamNames: Iterable<string>
): string[] {
  const tracked = new Set(trackedTeamNames);
  return persistedTeamNames.filter((teamName) => !tracked.has(teamName));
}

export async function stopTeamFlow<TRun extends TeamProvisioningStopRun>(
  teamName: string,
  ports: TeamProvisioningStopTeamPorts<TRun>
): Promise<void> {
  ports.invalidateRuntimeSnapshotCaches(teamName);
  ports.pauseActiveIntervalsForTeam(teamName);
  ports.stopPersistentTeamMembers(teamName);

  let runId = ports.getTrackedRunId(teamName);
  if (!runId) {
    if (ports.hasSecondaryRuntimeRuns(teamName)) {
      await ports.stopMixedSecondaryRuntimeLanes(teamName);
    }
    await ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName);
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
      await ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName);
      return;
    }
    const runtimeRun = ports.runtimeAdapterRunByTeam.get(teamName);
    if (runtimeRun?.runId === runId && runtimeRun.providerId === 'opencode') {
      await ports.withTeamLock(teamName, async () => {
        const currentRuntimeRun = ports.runtimeAdapterRunByTeam.get(teamName);
        if (currentRuntimeRun?.runId === runId && currentRuntimeRun.providerId === 'opencode') {
          await ports.stopOpenCodeRuntimeAdapterTeam(teamName, runId);
        }
      });
      await ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName);
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
    await ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName);
    return;
  }
  if (run.processKilled || run.cancelRequested) {
    if (ports.hasSecondaryRuntimeRuns(teamName)) {
      await ports.stopMixedSecondaryRuntimeLanes(teamName);
    }
    await ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName);
    return;
  }
  run.processKilled = true;
  run.cancelRequested = true;
  ports.killTeamProcess(run.child);
  const stopSecondaryRuntimeLanes = ports.hasSecondaryRuntimeRuns(teamName)
    ? ports.stopMixedSecondaryRuntimeLanes(teamName)
    : null;
  const progress = ports.updateProgress(run, 'disconnected', 'Team stopped by user');
  run.onProgress(progress);
  ports.cleanupRun(run);
  ports.logger.info(`[${teamName}] Process stopped (SIGKILL)`);
  await stopSecondaryRuntimeLanes;
  await ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName);
}

export function stopPersistentTeamMembersFlow<TMember>(
  teamName: string,
  ports: TeamProvisioningPersistentStopPorts<TMember>
): void {
  const members = ports.readPersistedRuntimeMembers(teamName);
  if (members.length > 0) {
    ports.killPersistedPaneMembers(teamName, members);
  }
  ports.killOrphanedTeamAgentProcesses(teamName);
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
