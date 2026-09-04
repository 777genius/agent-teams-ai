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
import * as fs from 'fs';

import { createOpenCodePromptDeliveryLedgerStore } from '../opencode/delivery/OpenCodePromptDeliveryLedger';
import {
  getOpenCodeLaneScopedRuntimeFilePath,
  OpenCodeRuntimeManifestEvidenceReader,
  readOpenCodeRuntimeLaneIndex,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import type { TeamForceStopResult } from '@shared/types';

const DEFAULT_STOP_TIMEOUT_MS = 15_000;
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
  await cancelOwnedDeliveries();
  const timeoutMs = ports.stopTimeoutMs ?? DEFAULT_STOP_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopOutcome: TeamForceStopResult['stopOutcome'];
  try {
    const stopAttempt = ports.stopTeam(teamName).then(
      () => 'stopped' as const,
      (error: unknown) => {
        const message = error instanceof Error ? error.message : String(error);
        ports.logWarning(`[${teamName}] Regular stop failed before force stop cleanup: ${message}`);
        diagnostics.push(`Regular stop failed: ${message}`);
        return 'stop_failed' as const;
      }
    );
    stopOutcome = await Promise.race([
      stopAttempt,
      new Promise<'timed_out'>((resolve) => {
        timer = setTimeout(() => resolve('timed_out'), timeoutMs);
        timer.unref?.();
      }),
    ]);
    if (stopOutcome === 'timed_out') {
      ports.logWarning(
        `[${teamName}] Regular stop did not finish within ${timeoutMs}ms; continuing with force stop cleanup.`
      );
      diagnostics.push(`Regular stop timed out after ${timeoutMs}ms`);
    }
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
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

  // Catch rows published by this run while its scoped stop was in flight.
  if (ownedLaneIds?.length) await cancelOwnedDeliveries();

  return {
    stopOutcome,
    cleanupOutcome: stopOutcome === 'stopped' && !cleanupIncomplete ? 'completed' : 'incomplete',
    killedRuntimePids,
    clearedPendingDeliveries,
    diagnostics,
  };
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
