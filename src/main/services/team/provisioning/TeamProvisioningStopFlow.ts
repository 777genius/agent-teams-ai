import { execFile, type ChildProcess } from 'node:child_process';
import path from 'node:path';

import type { TeamProvisioningProgress } from '@shared/types';

import {
  type AnthropicApiKeyHelperRunOwner,
  cleanupRunOwnedAnthropicApiKeyHelper,
} from './TeamProvisioningAnthropicApiKeyHelperLease';
import {
  cancelRunLeadRelayCapture,
  type LeadRelayCaptureOwner,
} from './TeamProvisioningLeadRelayCancellation';

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

const WINDOWS_ORIGINAL_MEMBER_EXIT_TIMEOUT_MS = 15_000;

/**
 * Drain the original teammate's tool descendants before signalling its root.
 * Its retained libuv ChildProcess handle prevents a recycled PID being adopted.
 */
function stopOriginalWindowsMemberTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.reject(new Error('Original Windows member process handle has no valid PID'));
  }
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    const taskkillPath = path.join(
      process.env.SystemRoot ?? 'C:\\Windows',
      'System32',
      'taskkill.exe'
    );
    execFile(
      taskkillPath,
      ['/T', '/F', '/PID', String(pid)],
      { windowsHide: true, timeout: WINDOWS_ORIGINAL_MEMBER_EXIT_TIMEOUT_MS },
      (error) => {
        if (error) {
          reject(
            new Error('Original Windows teammate process-tree termination not confirmed', {
              cause: error,
            })
          );
        } else {
          resolve();
        }
      }
    );
  });
}

/** Kill by the original ChildProcess handle; a recycled PID never grants authority. */
function killOriginalWindowsDirectMember(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (typeof pid !== 'number' || !Number.isSafeInteger(pid) || pid <= 0) {
    return Promise.reject(new Error('Original Windows member process handle has no valid PID'));
  }
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();

  return new Promise<void>((resolve, reject) => {
    let settled = false;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child.off('exit', onExit);
      child.off('error', onError);
      if (error) reject(error);
      else resolve();
    };
    const onExit = () => finish();
    const onError = () => finish(new Error('Original Windows teammate process failed on exit'));
    const timer = setTimeout(() =>
      finish(new Error('Original Windows teammate exit not confirmed')),
      WINDOWS_ORIGINAL_MEMBER_EXIT_TIMEOUT_MS
    );
    child.once('exit', onExit);
    child.once('error', onError);
    try {
      // Node/libuv targets this original process handle on Windows, never a
      // later process which might have acquired the same integer PID.
      // taskkill /T may have already terminated this process while libuv has
      // not emitted 'exit' yet. A refused handle signal must still await that
      // event or the bounded timeout; it is not evidence of a live process.
      child.kill('SIGKILL');
    } catch {
      finish(new Error('Original Windows teammate handle signal failed'));
    }
  });
}

/**
 * Await tree stop before original-handle fallback. Even when the tree attempt
 * fails, retire every owned handle and propagate the failure: an orphaned tool
 * may still be running, so Stop cannot report success.
 */
async function stopWindowsMemberTreeThenHandle(
  child: ChildProcess,
  stopTree: (child: ChildProcess) => Promise<void>
): Promise<void> {
  let treeError: unknown;
  try {
    await stopTree(child);
  } catch (error) {
    treeError = error;
  }
  let handleError: unknown;
  try {
    await killOriginalWindowsDirectMember(child);
  } catch (error) {
    handleError = error;
  }
  if (treeError && handleError) {
    throw new AggregateError([treeError, handleError], 'Windows teammate stop unconfirmed');
  }
  if (treeError) throw treeError;
  if (handleError) throw handleError;
}

/** Independent stop attempts: one uncooperative member must not spare another. */
export async function stopOriginalWindowsDirectMembers(
  processes: ReadonlySet<ChildProcess> | undefined,
  platform: NodeJS.Platform = process.platform,
  stopTree: (child: ChildProcess) => Promise<void> = stopOriginalWindowsMemberTree
): Promise<void> {
  if (platform !== 'win32' || !processes?.size) return;
  await awaitAllOwnedProcessStops(
    [...processes].map((child) => stopWindowsMemberTreeThenHandle(child, stopTree))
  );
}

export interface TeamProvisioningStopRun
  extends AnthropicApiKeyHelperRunOwner, LeadRelayCaptureOwner {
  runId: string;
  teamName: string;
  processKilled: boolean;
  cancelRequested: boolean;
  child: unknown;
  directMemberProcesses?: ReadonlySet<ChildProcess>;
  onProgress(progress: TeamProvisioningProgress): void;
}

export interface TeamProvisioningStopTeamPorts<TRun extends TeamProvisioningStopRun> {
  cancelOpenCodePromptDeliveries(teamName: string): Promise<void>;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
  pauseActiveIntervalsForTeam(teamName: string): { failed?: boolean } | void;
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
  getShutdownRunningTeamNames(): string[];
  pauseActiveIntervalsForTeam(teamName: string): void;
  killTrackedCliProcesses(signal: 'SIGKILL'): void;
  killTransientProbeProcessesForShutdown(): void;
  stopTrackedTeamsForShutdown(label: string): Promise<string[]>;
  cancelPendingRuntimeAdapterLaunchesForShutdown(): Promise<void>;
  waitForInFlightTeamOperationsForShutdown(): Promise<void>;
  listPersistedTeamNames(): string[];
  isManagedByThisProfile(teamName: string): Promise<boolean>;
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

async function stopTeamRuntimeFlow<TRun extends TeamProvisioningStopRun>(
  teamName: string,
  ports: TeamProvisioningStopTeamPorts<TRun>
): Promise<void> {
  ports.invalidateRuntimeSnapshotCaches(teamName);
  // A task-clock write must never prevent retirement of the owned processes.
  // Runtime callbacks may still resume an interval until teardown drains below.
  try {
    ports.pauseActiveIntervalsForTeam(teamName);
  } catch {
    ports.logger.info('task_activity_interval_pause_deferred_until_stop');
  }
  ports.stopPersistentTeamMembers(teamName);
  ports.openCodeRuntimeDeliveryAdvisory.cancelTeam(teamName);
  const stopRuntimeLanesForRun = async (targetRunId: string): Promise<void> => {
    const runtimeRun = ports.runtimeAdapterRunByTeam.get(teamName);
    const stopPrimaryRuntimeLane =
      runtimeRun?.runId === targetRunId && runtimeRun.providerId === 'opencode'
        ? ports.stopOpenCodeRuntimeAdapterTeam(teamName, runtimeRun.runId)
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
      await ports.withTeamLock(teamName, async () => {
        const currentRuntimeRun = ports.runtimeAdapterRunByTeam.get(teamName);
        if (currentRuntimeRun?.runId === runId && currentRuntimeRun.providerId === 'opencode') {
          await ports.stopOpenCodeRuntimeAdapterTeam(teamName, runId);
        }
      });
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
  cancelRunLeadRelayCapture(run);
  if (run.processKilled || run.cancelRequested) {
    await awaitAllOwnedProcessStops([
      ports.killTeamProcessAndWait(run.child),
      stopOriginalWindowsDirectMembers(run.directMemberProcesses),
      stopRuntimeLanesForRun(run.runId),
    ]);
    await (ports.cleanupRunOwnedAnthropicApiKeyHelper?.(run) ??
      cleanupRunOwnedAnthropicApiKeyHelper(run));
    ports.cleanupRun(run);
    return;
  }
  run.processKilled = true;
  run.cancelRequested = true;
  const stopCurrentTeamProcess = ports.killTeamProcessAndWait(run.child);
  const stopCurrentRuntimeLanes = stopRuntimeLanesForRun(run.runId);
  const stopDirectMembers = stopOriginalWindowsDirectMembers(run.directMemberProcesses);
  await awaitAllOwnedProcessStops([stopCurrentTeamProcess, stopCurrentRuntimeLanes, stopDirectMembers]);
  const progress = ports.updateProgress(run, 'disconnected', 'Team stopped by user');
  run.onProgress(progress);
  ports.logger.info(`[${teamName}] Process stopped (SIGKILL)`);
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
  // Keep the team lock until both branches settle, including runtime-owned
  // cleanup on runtime success even when durable cancellation fails.
  let stopFailed = false;
  let stopFailure: unknown;
  try {
    await awaitAllOwnedProcessStops([
      ports.cancelOpenCodePromptDeliveries(teamName),
      stopTeamRuntimeFlow(teamName, ports).then(() =>
        ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName)
      ),
    ]);
  } catch (error) {
    stopFailed = true;
    stopFailure = error;
  }
  // Only after every owned stop/cancellation and helper cleanup has settled
  // can the final persisted clock boundary be published without a late resume.
  let pauseFailed = false;
  try {
    pauseFailed = ports.pauseActiveIntervalsForTeam(teamName)?.failed === true;
  } catch {
    pauseFailed = true;
  }
  if (pauseFailed) {
    ports.logger.info('task_activity_interval_pause_failed_after_stop');
  }
  if (stopFailed) throw stopFailure;
  if (pauseFailed) throw new Error('task_activity_interval_pause_failed_after_stop');
}

export async function stopAllTeamsFlow(ports: TeamProvisioningStopAllPorts): Promise<void> {
  ports.incrementStopAllTeamsGeneration();
  // Synchronous on purpose: the quit path may not wait for I/O. A team known
  // only through a held lock may belong to another app profile, so it is left
  // to stopTrackedTeamsForShutdown, which checks ownership before stopping it.
  const initialTracked = ports.getShutdownRunningTeamNames();
  for (const teamName of initialTracked) {
    ports.pauseActiveIntervalsForTeam(teamName);
  }
  ports.killTrackedCliProcesses('SIGKILL');
  ports.killTransientProbeProcessesForShutdown();

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
  const untrackedTeamNames = getOrphanPersistedTeamNames(persistedTeamNames, [
    ...initialTracked,
    ...ports.getShutdownTrackedTeamNames(),
  ]);
  // The teams directory is shared with other app profiles and native sessions.
  // Their teams are not leftovers of this profile: no pause, kill or rewrite.
  const orphanOnly: string[] = [];
  for (const teamName of untrackedTeamNames) {
    if (await ports.isManagedByThisProfile(teamName)) {
      orphanOnly.push(teamName);
    }
  }
  const foreignCount = untrackedTeamNames.length - orphanOnly.length;
  if (foreignCount > 0) {
    ports.logger.info(`Leaving ${foreignCount} team(s) not managed by this app profile untouched`);
  }
  if (orphanOnly.length > 0) {
    ports.logger.info(
      `Cleaning up persisted teammate runtimes on shutdown: ${orphanOnly.join(', ')}`
    );
    for (const teamName of orphanOnly) {
      // Earlier cleanups take seconds; another profile may have claimed the team since.
      if (!(await ports.isManagedByThisProfile(teamName))) {
        ports.logger.info(
          `[${teamName}] No longer managed by this app profile; leaving it untouched`
        );
        continue;
      }
      ports.pauseActiveIntervalsForTeam(teamName);
      ports.stopPersistentTeamMembers(teamName);
      await ports.cleanupAnthropicApiKeyHelperMaterialForStoppedTeam(teamName);
    }
  }
}
