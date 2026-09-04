/**
 * Force stop: a best-effort regular stop, then a hard kill of every runtime
 * process the team still owns, then cancellation of the prompt deliveries that
 * are still pending so nothing keeps re-attempting after the team is dead.
 *
 * It lives under `services/team` rather than next to an entry point because
 * both entry points use it: the IPC handler behind the in-app control and the
 * HTTP route a headless caller uses.
 */

import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';

import { cleanupManagedOpenCodeServeProcesses } from '../opencode/bridge/OpenCodeManagedHostProcessCleanup';
import { createOpenCodePromptDeliveryLedgerStore } from '../opencode/delivery/OpenCodePromptDeliveryLedger';
import {
  getOpenCodeLaneScopedRuntimeFilePath,
  readOpenCodeRuntimeLaneIndex,
} from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import { tryStopPersistedOpenCodeRuntimePidForStoppedLane } from '../provisioning/TeamProvisioningOpenCodeRuntimeLaneCleanup';
import { TeamLaunchStateStore } from '../TeamLaunchStateStore';

import type { OpenCodeManagedHostCleanupResult } from '../opencode/bridge/OpenCodeManagedHostProcessCleanup';
import type { PersistedTeamLaunchSnapshot, TeamForceStopResult } from '@shared/types';

const DEFAULT_STOP_TIMEOUT_MS = 15_000;
const FORCE_STOP_DELIVERY_CANCEL_REASON =
  'force_stop_requested: pending delivery cancelled by user force stop';

export interface TeamForceStopFlowPorts {
  stopTeam(teamName: string): Promise<void>;
  /**
   * `requestedAtMs` is the moment this stop flow began, not the moment the kill
   * step runs: the regular stop before it can take its whole budget, and a
   * relaunch of the same team started inside that window owns the host it
   * created. The kill step must keep it.
   */
  killRetainedRuntimeProcesses(
    teamName: string,
    context: { requestedAtMs: number }
  ): Promise<{ killedPids: number[]; diagnostics: string[] }>;
  clearPendingPromptDeliveries(
    teamName: string
  ): Promise<{ cleared: number; diagnostics: string[] }>;
  logWarning(message: string): void;
  stopTimeoutMs?: number;
}

/**
 * The regular stop can reject ("did not confirm stop; retaining runtime
 * ownership") or hang on the per-team lock, so it runs under a timeout and
 * never blocks the hard-kill phase. Inbox messages are intentionally left
 * untouched: discarding queued messages is a separate, explicit user action.
 */
export async function runTeamForceStopFlow(
  teamName: string,
  ports: TeamForceStopFlowPorts
): Promise<TeamForceStopResult> {
  const diagnostics: string[] = [];
  const stopStartedAtMs = Date.now();
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
  try {
    const killResult = await ports.killRetainedRuntimeProcesses(teamName, {
      requestedAtMs: stopStartedAtMs,
    });
    killedRuntimePids = killResult.killedPids;
    diagnostics.push(...killResult.diagnostics);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ports.logWarning(`[${teamName}] Force stop process kill failed: ${message}`);
    diagnostics.push(`Process kill failed: ${message}`);
  }

  let clearedPendingDeliveries = 0;
  try {
    const clearResult = await ports.clearPendingPromptDeliveries(teamName);
    clearedPendingDeliveries = clearResult.cleared;
    diagnostics.push(...clearResult.diagnostics);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    ports.logWarning(`[${teamName}] Force stop delivery cleanup failed: ${message}`);
    diagnostics.push(`Pending delivery cleanup failed: ${message}`);
  }

  return { stopOutcome, killedRuntimePids, clearedPendingDeliveries, diagnostics };
}

/**
 * The managed-host sweep is the only step that reaches processes this app did
 * not record a PID for, so it is a port rather than a hard-wired call: a
 * deployment that would rather never touch an unattributed host hands in a
 * port that reports itself disabled, and the force stop then confines itself
 * to the PIDs the launch snapshot names.
 */
export interface OpenCodeManagedHostSweepPort {
  isEnabled(): boolean;
  sweepManagedHosts(input: { startedBeforeMs: number }): Promise<OpenCodeManagedHostCleanupResult>;
}

export const DEFAULT_OPEN_CODE_MANAGED_HOST_SWEEP_PORT: OpenCodeManagedHostSweepPort = {
  isEnabled: () => true,
  sweepManagedHosts: (input) =>
    cleanupManagedOpenCodeServeProcesses({
      mode: 'force',
      startedBeforeMs: input.startedBeforeMs,
    }),
};

function collectPersistedOpenCodeLaneIds(
  snapshot: PersistedTeamLaunchSnapshot | null
): { laneId: string; runtimePid: number | null }[] {
  const lanes = new Map<string, number | null>();
  for (const member of Object.values(snapshot?.members ?? {})) {
    if (member.providerId !== 'opencode') {
      continue;
    }
    const laneId = member.laneId?.trim();
    if (!laneId) {
      continue;
    }
    const pid =
      typeof member.runtimePid === 'number' &&
      Number.isFinite(member.runtimePid) &&
      member.runtimePid > 0
        ? member.runtimePid
        : null;
    if (!lanes.has(laneId) || (lanes.get(laneId) === null && pid !== null)) {
      lanes.set(laneId, pid);
    }
  }
  return [...lanes.entries()].map(([laneId, runtimePid]) => ({ laneId, runtimePid }));
}

/**
 * Kills runtime processes the team still owns after the regular stop:
 *
 * 1. Persisted lane runtime PIDs from the launch snapshot, verified against the
 *    persisted process command before killing (same safety contract as the
 *    stopped-lane cleanup). On Windows the kill uses `taskkill /T`, so the
 *    whole host tree dies.
 * 2. A managed-host sweep for app-managed `opencode serve` hosts whose PIDs
 *    were never persisted. The sweep cannot attribute a host to a team, so it
 *    only runs when no other team is alive, and it is always fenced by the
 *    moment the stop was requested: a host started after that belongs to
 *    something else - a relaunch of this same team racing the stop, most
 *    likely - and is kept.
 */
export async function killRetainedOpenCodeRuntimeProcessesForTeam(input: {
  teamName: string;
  otherAliveTeams: readonly string[];
  /** Defaults to the moment this step begins when a caller has no earlier one. */
  requestedAtMs?: number;
  launchStateStore?: TeamLaunchStateStore;
  managedHostSweep?: OpenCodeManagedHostSweepPort;
}): Promise<{ killedPids: number[]; diagnostics: string[] }> {
  const startedBeforeMs = input.requestedAtMs ?? Date.now();
  const diagnostics: string[] = [];
  const killedPids: number[] = [];
  const launchStateStore = input.launchStateStore ?? new TeamLaunchStateStore();
  const snapshot = await launchStateStore.read(input.teamName).catch(() => null);

  for (const lane of collectPersistedOpenCodeLaneIds(snapshot)) {
    const result = tryStopPersistedOpenCodeRuntimePidForStoppedLane({
      teamName: input.teamName,
      laneId: lane.laneId,
      previousLaunchState: snapshot,
    });
    if (result === 'stopped' && lane.runtimePid !== null) {
      killedPids.push(lane.runtimePid);
      diagnostics.push(`Killed persisted runtime pid=${lane.runtimePid} for lane ${lane.laneId}`);
    } else if (result === 'unsafe') {
      diagnostics.push(
        `Skipped persisted runtime pid for lane ${lane.laneId}: process identity could not be verified`
      );
    }
  }

  if (input.otherAliveTeams.length > 0) {
    diagnostics.push(
      `Skipped managed host sweep: other teams are still alive (${input.otherAliveTeams.join(', ')})`
    );
    return { killedPids, diagnostics };
  }

  const managedHostSweep = input.managedHostSweep ?? DEFAULT_OPEN_CODE_MANAGED_HOST_SWEEP_PORT;
  if (!managedHostSweep.isEnabled()) {
    diagnostics.push(
      'Skipped managed host sweep: the managed host sweep is disabled for this app instance'
    );
    return { killedPids, diagnostics };
  }

  const sweep = await managedHostSweep.sweepManagedHosts({ startedBeforeMs });
  for (const candidate of sweep.candidates) {
    if (candidate.action === 'killed' && !killedPids.includes(candidate.pid)) {
      killedPids.push(candidate.pid);
    }
  }
  if (sweep.killed > 0) {
    diagnostics.push(`Managed host sweep killed ${sweep.killed} host process(es)`);
  }
  diagnostics.push(...sweep.diagnostics.map((entry) => `Managed host sweep: ${entry}`));
  return { killedPids, diagnostics };
}

/**
 * Cancels every OpenCode prompt delivery ledger record the automatic selection
 * can still pick up for the team, so the delivery watchdog stops retrying after
 * the force stop. Inbox rows are not modified.
 */
export async function clearPendingOpenCodePromptDeliveriesForTeam(input: {
  teamName: string;
  teamsBasePath?: string;
  now?: () => Date;
}): Promise<{ cleared: number; diagnostics: string[] }> {
  const teamsBasePath = input.teamsBasePath ?? getTeamsBasePath();
  const diagnostics: string[] = [];
  const laneIndex = await readOpenCodeRuntimeLaneIndex(teamsBasePath, input.teamName).catch(
    () => null
  );
  const laneIds = [
    ...new Set(
      Object.values(laneIndex?.lanes ?? {})
        .map((entry) => entry.laneId.trim())
        .filter(Boolean)
    ),
  ];

  let cleared = 0;
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
      });
      cleared += result.cancelled;
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
  return { cleared, diagnostics };
}
