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
  preflightMetadataMutation(teamName: string): Promise<void>;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  pauseActiveIntervalsForTeam(teamName: string): void;
  stopPersistentTeamMembers(teamName: string): boolean;
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
  stopOpenCodeRuntimeAdapterTeam(teamName: string, runId: string): Promise<boolean>;
  hasSecondaryRuntimeRuns(teamName: string): boolean;
  stopMixedSecondaryRuntimeLanes(teamName: string): Promise<void>;
  provisioningRunByTeam: Map<string, string>;
  deleteAliveRunId(teamName: string): void;
  killTeamProcess(child: TRun['child']): void;
  killTeamProcessAndWait(child: TRun['child']): Promise<void>;
  updateProgress(
    run: TRun,
    state: Exclude<TeamProvisioningProgress['state'], 'idle'>,
    message: string
  ): TeamProvisioningProgress;
  persistStoppedLaunchState(teamName: string, stoppedRunId?: string): Promise<void>;
  cleanupRun(run: TRun): void;
  cleanupRunOwnedAnthropicApiKeyHelper?(run: TRun): Promise<void>;
  logger: StopLogger;
}

export interface TeamProvisioningStopAllPorts {
  preflightMetadataMutation(teamName: string): Promise<void>;
  withTeamLocks<T>(teamNames: readonly string[], fn: () => Promise<T>): Promise<T>;
  incrementStopAllTeamsGeneration(): void;
  getShutdownTrackedTeamNames(): string[];
  pauseActiveIntervalsForTeam(teamName: string): void;
  killTrackedCliProcesses(signal: 'SIGKILL'): void;
  killTransientProbeProcessesForShutdown(): void;
  stopTrackedTeamsForShutdown(label: string): Promise<string[]>;
  cancelPendingRuntimeAdapterLaunchesForShutdown(): Promise<void>;
  waitForInFlightTeamOperationsForShutdown(): Promise<void>;
  listPersistedTeamNames(): string[];
  stopPersistentTeamMembers(teamName: string): boolean;
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

async function stopTeamRuntimeFlow<TRun extends TeamProvisioningStopRun>(
  teamName: string,
  ports: TeamProvisioningStopTeamPorts<TRun>,
  authorize: boolean,
  onAuthorized?: () => void
): Promise<void> {
  if (authorize) {
    await ports.preflightMetadataMutation(teamName);
    onAuthorized?.();
  }
  ports.invalidateRuntimeSnapshotCaches(teamName);
  ports.pauseActiveIntervalsForTeam(teamName);
  const persistentMembersStopped = ports.stopPersistentTeamMembers(teamName);
  ports.openCodeRuntimeDeliveryAdvisory.cancelTeam(teamName);
  const stopRuntimeLanesForRun = async (targetRunId: string): Promise<void> => {
    const runtimeRun = ports.runtimeAdapterRunByTeam.get(teamName);
    const stopPrimaryRuntimeLane =
      runtimeRun?.runId === targetRunId && runtimeRun.providerId === 'opencode'
        ? ports.stopOpenCodeRuntimeAdapterTeam(teamName, runtimeRun.runId).then((stopped) => {
            if (!stopped) throw new Error('OpenCode primary runtime cleanup is unconfirmed');
          })
        : null;
    const stopSecondaryRuntimeLanes = ports.hasSecondaryRuntimeRuns(teamName)
      ? ports.stopMixedSecondaryRuntimeLanes(teamName)
      : null;
    await Promise.all(
      [stopPrimaryRuntimeLane, stopSecondaryRuntimeLanes].filter(
        (stop): stop is Promise<void> => stop !== null
      )
    );
  };

  let runId = ports.getTrackedRunId(teamName);
  if (!runId) {
    await ports.withTeamLock(teamName, async () => {
      if (!persistentMembersStopped) {
        throw new Error('Persistent teammate cleanup is unconfirmed');
      }

      const runtimeRun = ports.runtimeAdapterRunByTeam.get(teamName);
      let recoveryRunId = runtimeRun?.runId;
      if (runtimeRun?.providerId === 'opencode') {
        const adapterStopped = await ports.stopOpenCodeRuntimeAdapterTeam(
          teamName,
          runtimeRun.runId
        );
        const runtimeRunAfterStop = ports.runtimeAdapterRunByTeam.get(teamName);
        if (!adapterStopped || runtimeRunAfterStop) {
          throw new Error('Owned runtime cleanup is unconfirmed');
        }
      }

      if (ports.hasSecondaryRuntimeRuns(teamName)) {
        await ports.stopMixedSecondaryRuntimeLanes(teamName);
        if (runtimeRun?.providerId === 'opencode' && ports.runtimeAdapterRunByTeam.has(teamName)) {
          throw new Error('Owned runtime cleanup is unconfirmed');
        }
      }

      recoveryRunId ??= Array.from(ports.runtimeAdapterProgressByRunId.values())
        .filter((progress) => progress.teamName === teamName)
        .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0]?.runId;
      await ports.persistStoppedLaunchState(teamName, recoveryRunId);
    });
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
      if (!persistentMembersStopped) {
        throw new Error('Persistent teammate cleanup is unconfirmed');
      }
      await ports.persistStoppedLaunchState(teamName, runId);
      return;
    }
    const runtimeRun = ports.runtimeAdapterRunByTeam.get(teamName);
    if (runtimeRun?.runId === runId && runtimeRun.providerId === 'opencode') {
      const adapterStopped = await ports.withTeamLock(teamName, async () => {
        const currentRuntimeRun = ports.runtimeAdapterRunByTeam.get(teamName);
        if (currentRuntimeRun?.runId === runId && currentRuntimeRun.providerId === 'opencode') {
          return ports.stopOpenCodeRuntimeAdapterTeam(teamName, runId);
        }
        return false;
      });
      if (!persistentMembersStopped || !adapterStopped) {
        throw new Error('Owned runtime cleanup is unconfirmed');
      }
      await ports.persistStoppedLaunchState(teamName, runId);
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
    if (!persistentMembersStopped) {
      throw new Error('Persistent teammate cleanup is unconfirmed');
    }
    await ports.persistStoppedLaunchState(teamName, runId);
    return;
  }
  if (run.processKilled || run.cancelRequested) {
    await awaitAllOwnedProcessStops([
      ...(persistentMembersStopped
        ? []
        : [Promise.reject(new Error('Persistent teammate cleanup is unconfirmed'))]),
      ports.killTeamProcessAndWait(run.child),
      stopRuntimeLanesForRun(run.runId),
    ]);
    await ports.persistStoppedLaunchState(teamName, run.runId);
    await (ports.cleanupRunOwnedAnthropicApiKeyHelper?.(run) ??
      cleanupRunOwnedAnthropicApiKeyHelper(run));
    ports.cleanupRun(run);
    return;
  }
  const priorProcessKilled = run.processKilled;
  const priorCancelRequested = run.cancelRequested;
  run.processKilled = true;
  run.cancelRequested = true;
  const stopCurrentTeamProcess = ports.killTeamProcessAndWait(run.child);
  const stopCurrentRuntimeLanes = stopRuntimeLanesForRun(run.runId);
  try {
    await awaitAllOwnedProcessStops([
      ...(persistentMembersStopped
        ? []
        : [Promise.reject(new Error('Persistent teammate cleanup is unconfirmed'))]),
      stopCurrentTeamProcess,
      stopCurrentRuntimeLanes,
    ]);
  } catch (error) {
    // These flags are projected as authoritative offline truth. Until every
    // owned lane confirms cleanup, restore the exact pre-stop image so a
    // retained run remains conservatively alive and blocks overlapping launch.
    run.processKilled = priorProcessKilled;
    run.cancelRequested = priorCancelRequested;
    throw error;
  }
  const progress = ports.updateProgress(run, 'disconnected', 'Team stopped by user');
  run.onProgress(progress);
  ports.logger.info(`[${teamName}] Process stopped (SIGKILL)`);
  await ports.persistStoppedLaunchState(teamName, run.runId);
  await (ports.cleanupRunOwnedAnthropicApiKeyHelper?.(run) ??
    cleanupRunOwnedAnthropicApiKeyHelper(run));
  // Secondary lane cleanup revalidates immutable run ownership after async
  // adapter calls. Keep the owning run tracked until those checks complete.
  ports.cleanupRun(run);
}

export async function stopTeamFlow<TRun extends TeamProvisioningStopRun>(
  teamName: string,
  ports: TeamProvisioningStopTeamPorts<TRun>,
  onAuthorized?: () => void
): Promise<void> {
  await stopTeamRuntimeFlow(teamName, ports, true, onAuthorized);
  await ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName);
}

export async function stopAuthorizedTeamFlow<TRun extends TeamProvisioningStopRun>(
  teamName: string,
  ports: TeamProvisioningStopTeamPorts<TRun>
): Promise<void> {
  await stopTeamRuntimeFlow(teamName, ports, false);
  await ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName);
}

export async function stopAllTeamsFlow(ports: TeamProvisioningStopAllPorts): Promise<void> {
  const initialTracked = ports.getShutdownTrackedTeamNames();
  const initialPersisted = ports.listPersistedTeamNames();
  const authorizedTargets = Array.from(new Set([...initialTracked, ...initialPersisted])).sort();

  // Admission is all-or-nothing. Revalidate the complete durable + tracked
  // target set while every target mutation lock is held, then publish the
  // shutdown fence as the first effect without another asynchronous gap.
  await Promise.all(authorizedTargets.map((teamName) => ports.preflightMetadataMutation(teamName)));
  await ports.withTeamLocks(authorizedTargets, async () => {
    await Promise.all(
      authorizedTargets.map((teamName) => ports.preflightMetadataMutation(teamName))
    );
    ports.incrementStopAllTeamsGeneration();
    for (const teamName of initialTracked) {
      ports.pauseActiveIntervalsForTeam(teamName);
    }
    ports.killTrackedCliProcesses('SIGKILL');
    ports.killTransientProbeProcessesForShutdown();
  });

  // Adapter launches can hold the per-team lock that stopTeam needs. Cancel
  // them before starting roster-aware stops so shutdown can invalidate the
  // launch and request its owned adapter stop immediately. Start both before
  // awaiting either one so non-adapter processes are stopped without an
  // additional microtask delay.
  const pendingAdapterCancellation = ports.cancelPendingRuntimeAdapterLaunchesForShutdown();
  const initialTeamStops = ports.stopTrackedTeamsForShutdown('Shutdown');
  await Promise.all([pendingAdapterCancellation, initialTeamStops]);

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
      await ports.withTeamLocks([teamName], async () => {
        await ports.preflightMetadataMutation(teamName);
        ports.pauseActiveIntervalsForTeam(teamName);
        ports.stopPersistentTeamMembers(teamName);
        await ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName);
      });
    }
  }
}
