import type { SecondaryRuntimeStopFence } from './TeamProvisioningOpenCodeRuntimeStopFlow';
import {
  type AnthropicApiKeyHelperRunOwner,
  cleanupRunOwnedAnthropicApiKeyHelper,
} from './TeamProvisioningAnthropicApiKeyHelperLease';

import type { TeamProvisioningProgress } from '@shared/types';

interface StopLogger {
  info(message: string): void;
}

interface RuntimeAdapterRunEntry {
  runId: string;
  providerId: string;
}

async function awaitAllOwnedProcessStops(stops: Promise<void>[]): Promise<void> {
  const results = await Promise.allSettled(stops);
  const failedStop = results.find(
    (result): result is PromiseRejectedResult => result.status === 'rejected'
  );
  if (failedStop) {
    throw failedStop.reason;
  }
}

export interface TeamProvisioningStopRun extends AnthropicApiKeyHelperRunOwner {
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
  getSecondaryRuntimeStopFence(teamName: string): SecondaryRuntimeStopFence;
  stopMixedSecondaryRuntimeLanes(
    teamName: string,
    ownershipFence: SecondaryRuntimeStopFence
  ): Promise<void>;
  provisioningRunByTeam: Map<string, string>;
  deleteAliveRunId(teamName: string): void;
  killTeamProcess(child: TRun['child']): void;
  killTeamProcessAndWait(child: TRun['child']): Promise<void>;
  updateProgress(
    run: TRun,
    state: Exclude<TeamProvisioningProgress['state'], 'idle'>,
    message: string
  ): TeamProvisioningProgress;
  cleanupRun(run: TRun): void;
  cleanupRunOwnedAnthropicApiKeyHelper?(run: TRun): Promise<void>;
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
  const secondaryRuntimeStopFence = ports.hasSecondaryRuntimeRuns(teamName)
    ? ports.getSecondaryRuntimeStopFence(teamName)
    : [];

  // Keep the order deterministic and leave secondary tracking untouched when
  // the required primary stop fails. Secondary ownership is frozen before the
  // primary await; the low-level stop flow then stops and cleans only owners
  // that still match this fence.
  if (shouldStopPrimaryRuntime) {
    await ports.stopOpenCodeRuntimeAdapterTeam(teamName, runId);
  }
  if (secondaryRuntimeStopFence.length > 0) {
    await ports.stopMixedSecondaryRuntimeLanes(teamName, secondaryRuntimeStopFence);
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
      await ports.stopMixedSecondaryRuntimeLanes(
        teamName,
        ports.getSecondaryRuntimeStopFence(teamName)
      );
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
      await ports.withTeamLock(teamName, async () => {
        const currentRuntimeRun = ports.runtimeAdapterRunByTeam.get(teamName);
        if (currentRuntimeRun?.runId === runId && currentRuntimeRun.providerId === 'opencode') {
          await stopRuntimeLanesOwnedByRun(teamName, runId, ports);
        }
      });
      return;
    }
    if (ports.hasSecondaryRuntimeRuns(teamName)) {
      await ports.stopMixedSecondaryRuntimeLanes(
        teamName,
        ports.getSecondaryRuntimeStopFence(teamName)
      );
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
    await awaitAllOwnedProcessStops([
      ports.killTeamProcessAndWait(run.child),
      stopRuntimeLanesOwnedByRun(teamName, run.runId, ports),
    ]);
    await (ports.cleanupRunOwnedAnthropicApiKeyHelper?.(run) ??
      cleanupRunOwnedAnthropicApiKeyHelper(run));
    ports.cleanupRun(run);
    return;
  }
  run.processKilled = true;
  run.cancelRequested = true;
  const stopCurrentTeamProcess = ports.killTeamProcessAndWait(run.child);
  const stopCurrentRuntimeLanes = stopRuntimeLanesOwnedByRun(teamName, run.runId, ports);
  const progress = ports.updateProgress(run, 'disconnected', 'Team stopped by user');
  run.onProgress(progress);
  ports.logger.info(`[${teamName}] Process stopped (SIGKILL)`);
  await awaitAllOwnedProcessStops([stopCurrentTeamProcess, stopCurrentRuntimeLanes]);
  await (ports.cleanupRunOwnedAnthropicApiKeyHelper?.(run) ??
    cleanupRunOwnedAnthropicApiKeyHelper(run));
  // Secondary lane cleanup revalidates immutable run ownership after async
  // adapter calls. Keep the owning run tracked until those checks complete.
  ports.cleanupRun(run);
}

export async function stopTeamFlow<TRun extends TeamProvisioningStopRun>(
  teamName: string,
  ports: TeamProvisioningStopTeamPorts<TRun>
): Promise<void> {
  await stopTeamRuntimeFlow(teamName, ports);
  await ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName);
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
