/**
 * Force stop: a bounded scoped stop followed by cancellation of owned pending
 * deliveries. Hard cleanup is reported as incomplete when the runtime cannot
 * prove exclusive host ownership; shared OpenCode hosts are never signaled.
 *
 * It lives under `services/team` rather than next to an entry point because
 * both entry points use it: the IPC handler behind the in-app control and the
 * HTTP route a headless caller uses.
 */

import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { isProcessAlive } from '@main/utils/processHealth';
import * as fs from 'fs';

import { createOpenCodePromptDeliveryLedgerStore } from '../opencode/delivery/OpenCodePromptDeliveryLedger';
import {
  getOpenCodeLaneScopedRuntimeFilePath,
  OpenCodeRuntimeManifestEvidenceReader,
  readOpenCodeRuntimeLaneIndex,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { TeamLaunchStateStore } from '../TeamLaunchStateStore';

import type { PersistedTeamLaunchSnapshot, TeamForceStopResult } from '@shared/types';

const DEFAULT_STOP_TIMEOUT_MS = 15_000;
/** How often the flow re-reads how many recorded runtime hosts are still alive. */
export const RUNTIME_HOSTS_POLL_INTERVAL_MS = 1_000;
/**
 * Budget for the regular stop before the force-stop cleanup takes over.
 *
 * Measured per-lane orchestrator stops run 17-48s - a full capability probe
 * plus a registry lock per command - so any budget inside that range escalates
 * a stop that was about to succeed: a 45s budget cut off a lane that confirmed
 * at 47.6s. `countLiveRuntimeHosts` ends the wait the moment the hosts are
 * gone, so a healthy stop never spends this budget and it only bounds a hang.
 */
export const STOP_ESCALATION_TIMEOUT_MS = 90_000;
const FORCE_STOP_DELIVERY_CANCEL_REASON =
  'force_stop_requested: pending delivery cancelled by user force stop';

export interface TeamForceStopFlowPorts {
  stopTeam(teamName: string): Promise<void>;
  /**
   * The runtime run ids the team owns, read before the regular stop is asked
   * for. It has to be before: the delivery ledger is keyed by lane and a lane
   * is reused, so a relaunch started inside the stop window publishes its own
   * run into the same lane, and a read taken afterwards would name the
   * successor instead of the run being torn down. A port that cannot answer
   * returns nothing, and the cleanup falls back to its own fence.
   */
  observeOwnedRuntimeRunIds(teamName: string): Promise<readonly string[]>;
  observeOwnedRuntimeLaneIds?(teamName: string): Promise<readonly string[]>;

  /**
   * `requestedAtMs` is the moment this stop flow began, not the moment the kill
   * step runs: the regular stop before it can take its whole budget, and a
   * relaunch of the same team started inside that window owns the host it
   * created. The kill step must keep it.
   */
  killRetainedRuntimeProcesses(
    teamName: string,
    context: { requestedAtMs: number }
  ): Promise<{ killedPids: number[]; diagnostics: string[]; incomplete?: boolean }>;
  /** Same fence, one level down: the cleanup cancels this run's work only. */
  clearPendingPromptDeliveries(
    teamName: string,
    context: {
      requestedAtMs: number;
      ownedRunIds: readonly string[];
      ownedLaneIds?: readonly string[];
    }
  ): Promise<{ cleared: number; diagnostics: string[] }>;
  logWarning(message: string): void;
  stopTimeoutMs?: number;
  /**
   * How many of the team's recorded runtime host processes are still running.
   * The orchestrator's stop takes 17-48s per lane, so the stop budget has to be
   * generous; this lets the flow finish as soon as the hosts are actually gone
   * instead of waiting the budget out. Omitted - or zero live hosts at the
   * first sample - and the flow waits for the stop or the timeout as before.
   */
  countLiveRuntimeHosts?(teamName: string): Promise<number>;
  /**
   * Persist the stopped state: drop the launch publication and write the stop
   * marker that keeps reconciliation from re-deriving a launch snapshot for a
   * team the user stopped. Optional so a caller that only wants the process
   * cleanup - a diagnostic sweep, say - leaves the publication alone.
   */
  markTeamStopped?(teamName: string): Promise<void>;
}

/**
 * The regular stop can reject ("did not confirm stop; retaining runtime
 * ownership") or hang on the per-team lock, so it runs under a timeout and
 * never blocks pending delivery cancellation. Inbox messages are intentionally left
 * untouched: discarding queued messages is a separate, explicit user action.
 */
export async function runTeamForceStopFlow(
  teamName: string,
  ports: TeamForceStopFlowPorts
): Promise<TeamForceStopResult> {
  return runTeamStopFlow(teamName, ports, { cleanup: 'always' });
}

/**
 * The regular Stop, with an escape hatch. The orchestrator's stop gets a
 * bounded budget and, only when it rejects or runs out of it, the force-stop
 * cleanup runs: the same hard-cleanup attempt and the same run-fenced delivery
 * cancellation. A stop that confirms cancels nothing and reaches nothing else -
 * the user asked for a stop, not for a sweep, and the escalation exists because
 * the stop sometimes cannot deliver what the user asked for.
 *
 * The force stop persists its cancellation before the stop, so a stop that
 * removes the lane index cannot strand the ledger. A regular Stop cannot: it
 * does not yet know whether it will have to escalate, so its cancellation runs
 * after the stop, on the lane scope read before it, and under the same
 * "the stop did not confirm" decision that gates the cleanup step.
 */
export async function stopTeamWithEscalation(
  teamName: string,
  ports: TeamForceStopFlowPorts
): Promise<TeamForceStopResult> {
  return runTeamStopFlow(teamName, ports, { cleanup: 'on_failure' });
}

/**
 * Resolves once the team's recorded runtime hosts are gone. It starts only
 * when the first sample sees at least one live host: without that evidence an
 * empty sample means "nothing was recorded", not "everything exited", and
 * would end the stop before the orchestrator had done any work at all.
 */
function watchRuntimeHostsGone(
  teamName: string,
  ports: TeamForceStopFlowPorts
): { promise: Promise<'runtime_already_down'>; cancel(): void } {
  let interval: ReturnType<typeof setInterval> | null = null;
  let cancelled = false;
  let sampling = false;
  const cancel = (): void => {
    cancelled = true;
    if (interval) {
      clearInterval(interval);
      interval = null;
    }
  };
  if (!ports.countLiveRuntimeHosts) {
    return { promise: new Promise<'runtime_already_down'>(() => {}), cancel };
  }
  const promise = new Promise<'runtime_already_down'>((resolve) => {
    const onSample = (remaining: number): void => {
      sampling = false;
      if (!cancelled && remaining <= 0) {
        cancel();
        resolve('runtime_already_down');
      }
    };
    const sample = (): void => {
      if (sampling) return;
      sampling = true;
      void countLiveRuntimeHostsSafely(teamName, ports).then(onSample);
    };
    const startSampling = (liveHosts: number): void => {
      if (cancelled || liveHosts <= 0) {
        return;
      }
      interval = setInterval(sample, RUNTIME_HOSTS_POLL_INTERVAL_MS);
      interval.unref?.();
    };
    void countLiveRuntimeHostsSafely(teamName, ports).then(startSampling);
  });
  return { promise, cancel };
}

/**
 * A probe that cannot answer must not keep the stop waiting, so a failure
 * counts as "no live hosts" rather than propagating out of the poll.
 */
async function countLiveRuntimeHostsSafely(
  teamName: string,
  ports: TeamForceStopFlowPorts
): Promise<number> {
  try {
    return (await ports.countLiveRuntimeHosts?.(teamName)) ?? 0;
  } catch {
    return 0;
  }
}

/**
 * How many of the team's recorded lane host processes are still running. Same
 * evidence the kill step uses: only pids the launch state recorded for this
 * team count, so an unrelated process can never keep the stop waiting.
 */
export async function countLiveRecordedRuntimeHostsForTeam(input: {
  teamName: string;
  launchStateStore?: TeamLaunchStateStore;
  isRuntimeProcessAlive?: (pid: number) => boolean;
}): Promise<number> {
  const launchStateStore = input.launchStateStore ?? new TeamLaunchStateStore();
  const snapshot = await launchStateStore.read(input.teamName).catch(() => null);
  const isAlive = input.isRuntimeProcessAlive ?? isProcessAlive;
  const pids = collectRecordedOpenCodeRuntimePids(snapshot);
  let live = 0;
  for (const pid of pids) {
    try {
      if (isAlive(pid)) live += 1;
    } catch {
      // An unreadable process is not evidence of a live host.
    }
  }
  return live;
}

/**
 * The runtime host pids the launch snapshot recorded for this team's OpenCode
 * lanes. Nothing else counts as evidence: a host this app never wrote down is
 * not the team's to wait for.
 */
function collectRecordedOpenCodeRuntimePids(
  snapshot: PersistedTeamLaunchSnapshot | null
): Set<number> {
  const pids = new Set<number>();
  for (const member of Object.values(snapshot?.members ?? {})) {
    if (member.providerId !== 'opencode' || !member.laneId?.trim()) {
      continue;
    }
    const pid = member.runtimePid;
    if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return pids;
}

async function runTeamStopFlow(
  teamName: string,
  ports: TeamForceStopFlowPorts,
  options: { cleanup: 'always' | 'on_failure' }
): Promise<TeamForceStopResult> {
  const cleanupIsUnconditional = options.cleanup === 'always';
  const diagnostics: string[] = [];
  const stopStartedAtMs = Date.now();
  let ownedRunIds: readonly string[] = [];
  try {
    ownedRunIds = await ports.observeOwnedRuntimeRunIds(teamName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ports.logWarning(`[${teamName}] Force stop could not read the team's run ids: ${message}`);
    diagnostics.push(`Runtime run ids could not be read: ${message}`);
  }
  let cleanupIncomplete = false;
  let ownedLaneIds: readonly string[] | undefined;
  try {
    ownedLaneIds = await ports.observeOwnedRuntimeLaneIds?.(teamName);
  } catch (error) {
    cleanupIncomplete = true;
    diagnostics.push(`Runtime lane ids could not be read: ${String(error)}`);
  }
  let clearedPendingDeliveries = 0;
  const cancelOwnedDeliveries = async (): Promise<void> => {
    try {
      const clearResult = await ports.clearPendingPromptDeliveries(teamName, {
        requestedAtMs: stopStartedAtMs,
        ownedRunIds,
        ...(ownedLaneIds ? { ownedLaneIds } : {}),
      });
      clearedPendingDeliveries += clearResult.cleared;
      diagnostics.push(...clearResult.diagnostics);
      cleanupIncomplete ||= clearResult.diagnostics.some((message) => message.startsWith('Failed'));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ports.logWarning(`[${teamName}] Force stop delivery cleanup failed: ${message}`);
      cleanupIncomplete = true;
      diagnostics.push(`Pending delivery cleanup failed: ${message}`);
    }
  };
  // Persist cancellation before stop can remove the lane index or runtime files.
  // A regular Stop has nothing to persist yet: it cancels only when the stop
  // does not deliver, so its cancellation has to wait for the outcome and runs
  // on the lane ids read above, which a removed lane index can no longer narrow.
  if (cleanupIsUnconditional) {
    await cancelOwnedDeliveries();
  }
  const timeoutMs = ports.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopOutcome: TeamForceStopResult['stopOutcome'];
  let timedOut = false;
  let runtimeHostsGone: { promise: Promise<'runtime_already_down'>; cancel(): void } | null = null;
  try {
    const stopAttempt = ports.stopTeam(teamName).then(
      () => {
        if (timedOut) {
          ports.logWarning(
            `[${teamName}] Regular stop finished ${Date.now() - stopStartedAtMs}ms after it started, after the force stop cleanup had already run.`
          );
        }
        return 'stopped' as const;
      },
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        if (timedOut) {
          // Expected once the hard kill already removed the hosts the
          // orchestrator was still trying to stop: the failure describes a
          // process that is gone, not a stop this flow still owes the user.
          ports.logWarning(
            `[${teamName}] Regular stop failed ${Date.now() - stopStartedAtMs}ms after it started, after the force stop cleanup had already run: ${message}`
          );
        } else {
          ports.logWarning(
            `[${teamName}] Regular stop failed before force stop cleanup: ${message}`
          );
          diagnostics.push(`Regular stop failed: ${message}`);
        }
        return 'stop_failed' as const;
      }
    );
    runtimeHostsGone = watchRuntimeHostsGone(teamName, ports);
    stopOutcome = await Promise.race([
      stopAttempt,
      runtimeHostsGone.promise,
      new Promise<'timed_out'>((resolve) => {
        timer = setTimeout(() => resolve('timed_out'), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (stopOutcome === 'timed_out') {
      timedOut = true;
      ports.logWarning(
        `[${teamName}] Regular stop did not finish within ${timeoutMs}ms; continuing with force stop cleanup.`
      );
      diagnostics.push(`Regular stop timed out after ${timeoutMs}ms`);
    } else if (stopOutcome === 'runtime_already_down') {
      timedOut = true;
      diagnostics.push(
        `Runtime hosts were gone ${Date.now() - stopStartedAtMs}ms into the stop; finished without waiting for the orchestrator acknowledgement`
      );
    }
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
    // Cancelled here rather than after the race so a throw between them - or
    // any later exit from this block - cannot leave the poller running.
    runtimeHostsGone?.cancel();
  }

  let killedRuntimePids: number[] = [];
  // A confirmed scoped stop has released this team's sessions. Shared hosts
  // may still serve other teams and do not require hard cleanup for success.
  if (stopOutcome !== 'stopped') {
    try {
      const killResult = await ports.killRetainedRuntimeProcesses(teamName, {
        requestedAtMs: stopStartedAtMs,
      });
      killedRuntimePids = killResult.killedPids;
      diagnostics.push(...killResult.diagnostics);
      cleanupIncomplete ||= killResult.incomplete === true;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      ports.logWarning(`[${teamName}] Force stop process kill failed: ${message}`);
      cleanupIncomplete = true;
      diagnostics.push(`Process kill failed: ${message}`);
    }
  }

  // Catch rows published by this run while its scoped stop was in flight. For a
  // regular Stop this is instead the deferred cancellation, and it is the same
  // decision the kill step just made: a stop that confirmed cancels nothing.
  const cancelAfterStop = cleanupIsUnconditional
    ? Boolean(ownedLaneIds?.length)
    : stopOutcome !== 'stopped';
  if (cancelAfterStop) await cancelOwnedDeliveries();

  await markStopped(teamName, ports, diagnostics);
  return {
    stopOutcome,
    cleanupOutcome: stopOutcome === 'stopped' && !cleanupIncomplete ? 'completed' : 'incomplete',
    killedRuntimePids,
    clearedPendingDeliveries,
    diagnostics,
  };
}

async function markStopped(
  teamName: string,
  ports: TeamForceStopFlowPorts,
  diagnostics: string[]
): Promise<void> {
  if (!ports.markTeamStopped) {
    return;
  }
  try {
    await ports.markTeamStopped(teamName);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ports.logWarning(`[${teamName}] Could not persist stopped launch state: ${message}`);
    diagnostics.push(`Stopped-state persistence failed: ${message}`);
  }
}

/**
 * OpenCode serve hosts are shared across lanes and teams. A persisted PID (or
 * even a matching process command) is not exclusive ownership. The current
 * bridge cannot atomically force-terminate only captured hosts while honoring
 * foreign leases, so the app must report this limit instead of signaling them.
 */
export async function killRetainedOpenCodeRuntimeProcessesForTeam(_input: {
  teamName: string;
  otherAliveTeams: readonly string[];
  requestedAtMs?: number;
}): Promise<{ killedPids: number[]; diagnostics: string[]; incomplete: boolean }> {
  return {
    killedPids: [],
    incomplete: true,
    diagnostics: [
      'Hard process cleanup is not confirmed: this runtime does not support targeted forced termination that preserves other teams sharing an OpenCode host. Only the regular scoped stop was attempted; shared hosts were left untouched.',
    ],
  };
}

export async function readOpenCodeRuntimeLaneIdsForTeam(
  teamsBasePath: string,
  teamName: string
): Promise<string[]> {
  const laneIndex = await readOpenCodeRuntimeLaneIndex(teamsBasePath, teamName);
  return [
    ...new Set(
      Object.values(laneIndex?.lanes ?? {})
        .map((entry) => entry.laneId.trim())
        .filter(Boolean)
    ),
  ];
}

/**
 * The OpenCode runtime run ids the team owns, one per lane, read from the same
 * durable manifest the delivery services stamp onto the ledger records they
 * create. This is what makes the delivery cleanup scopable: without it the
 * cleanup can only say "everything in this lane", and a lane belongs to
 * whichever run is using it now, not to the run being torn down.
 */
export async function readOwnedOpenCodeRuntimeRunIdsForTeam(input: {
  teamName: string;
  teamsBasePath?: string;
}): Promise<string[]> {
  const teamsBasePath = input.teamsBasePath ?? getTeamsBasePath();
  const reader = new OpenCodeRuntimeManifestEvidenceReader({ teamsBasePath });
  const runIds = new Set<string>();
  for (const laneId of await readOpenCodeRuntimeLaneIdsForTeam(teamsBasePath, input.teamName)) {
    const evidence = await reader.read(input.teamName, laneId).catch(() => null);
    const runId = evidence?.activeRunId?.trim();
    if (runId) {
      runIds.add(runId);
    }
  }
  return [...runIds];
}

/**
 * Cancels every OpenCode prompt delivery ledger record the automatic selection
 * can still pick up for the team, so the delivery watchdog stops retrying after
 * the force stop. Inbox rows are not modified.
 *
 * The cancellation is fenced to the run the stop is tearing down. Nothing holds
 * a lock across a force stop - the per-team lock is taken and released inside
 * the regular stop, and the kill and cleanup steps run outside it - so a
 * relaunch of the same team started while the stop hangs can publish its own
 * run into the same lane and have deliveries pending there before this step
 * runs. Cancelling by lane alone would mark the successor's work
 * `failed_terminal` and its members would sit on messages nothing retries.
 * `ownedRunIds` names what the stop found, and `requestedAtMs` covers what
 * carries no run id or was written by a run this app could not name: a record
 * that appeared after the stop was asked for is somebody else's.
 */
export async function clearPendingOpenCodePromptDeliveriesForTeam(input: {
  teamName: string;
  teamsBasePath?: string;
  now?: () => Date;
  ownedRunIds?: readonly string[];
  ownedLaneIds?: readonly string[];
  requestedAtMs?: number;
}): Promise<{ cleared: number; diagnostics: string[] }> {
  const teamsBasePath = input.teamsBasePath ?? getTeamsBasePath();
  const diagnostics: string[] = [];
  const laneIds =
    input.ownedLaneIds ?? (await readOpenCodeRuntimeLaneIdsForTeam(teamsBasePath, input.teamName));

  let cleared = 0;
  let keptForLaterRun = 0;
  for (const laneId of laneIds) {
    const ledgerPath = getOpenCodeLaneScopedRuntimeFilePath({
      teamsBasePath,
      teamName: input.teamName,
      laneId,
      fileName: 'opencode-prompt-delivery-ledger.json',
    });
    if (!fs.existsSync(ledgerPath)) {
      continue;
    }
    try {
      const ledger = createOpenCodePromptDeliveryLedgerStore({ filePath: ledgerPath });
      const result = await ledger.cancelNonTerminalRecords({
        now: (input.now?.() ?? new Date()).toISOString(),
        reason: FORCE_STOP_DELIVERY_CANCEL_REASON,
        ownedRunIds: input.ownedRunIds,
        createdAtOrBeforeMs: input.requestedAtMs,
      });
      cleared += result.cancelled;
      keptForLaterRun += result.keptForLaterRun;
    } catch (error) {
      diagnostics.push(
        `Failed to cancel pending deliveries for lane ${laneId}: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
    }
  }
  if (cleared > 0) {
    diagnostics.push(`Cancelled ${cleared} pending prompt delivery record(s)`);
  }
  if (keptForLaterRun > 0) {
    diagnostics.push(
      `Kept ${keptForLaterRun} pending prompt delivery record(s) that a later run owns`
    );
  }
  return { cleared, diagnostics };
}
