import { isProcessAlive } from '@main/utils/processHealth';

import type { PersistedTeamLaunchSnapshot } from '@shared/types';

/**
 * Idempotent OpenCode lane stop.
 *
 * The orchestrator's `opencode.stopTeam` reports `stopped: false` whenever a
 * session abort does not confirm - which is exactly what happens when the
 * runtime is already gone: the host crashed, was killed by a force stop, or
 * exited after a previous stop. Treating that as a failed stop left the run
 * tracked as alive, so every later Stop hit the same rejection - the HTTP
 * `/stop` route answered 500 in a loop and the team never left the alive list.
 *
 * A stop whose lane has no live host process any more is a completed stop:
 * there is nothing left to stop. Only a lane whose recorded host is still
 * running turns an unconfirmed stop into a failure.
 *
 * A capability snapshot mismatch is the same trap one step earlier. The stop
 * is rejected before the bridge handshake even runs - the persisted lane
 * manifest no longer matches, which happens when the OpenCode user config
 * changes while lanes are running - so the failure carries no host evidence
 * at all. When the lane also has no recorded host pid there is nothing
 * verifiable left to protect, and failing forever kept the team wedged in
 * memory until the app was restarted. Only that no-evidence mismatch settles
 * as already stopped; a recorded live host still fails the stop.
 */

const OPEN_CODE_STOP_CAPABILITY_SNAPSHOT_MISMATCH_MARKERS = [
  'bridge server capability snapshot mismatch',
  'opencode bridge capability snapshot mismatch',
  // Rejected before the handshake, by the persisted-manifest precondition.
  'requires the exact persisted lane run and capability snapshot',
  'capability snapshot does not match the persisted lane manifest',
];

function isOpenCodeCapabilitySnapshotMismatchStopDetail(detail: string): boolean {
  const normalized = detail.toLowerCase();
  return OPEN_CODE_STOP_CAPABILITY_SNAPSHOT_MISMATCH_MARKERS.some((marker) =>
    normalized.includes(marker)
  );
}

export interface OpenCodeRuntimeStopResultLike {
  stopped?: unknown;
  diagnostics?: unknown;
  warnings?: unknown;
}

export type OpenCodeRuntimeStopOutcome =
  | { kind: 'stopped' }
  | { kind: 'already_stopped'; detail: string; checkedPids: number[] }
  | { kind: 'failed'; detail: string; alivePids: number[] };

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function describeOpenCodeRuntimeStopResult(
  result: OpenCodeRuntimeStopResultLike | null
): string {
  return [...stringList(result?.diagnostics), ...stringList(result?.warnings)]
    .map((entry) => entry.trim())
    .filter(Boolean)
    .join('; ');
}

/** Recorded host pids of the members that belong to `laneId` in the launch snapshot. */
export function collectOpenCodeLaneRuntimePids(
  snapshot: PersistedTeamLaunchSnapshot | null | undefined,
  laneId: string
): number[] {
  const pids = new Set<number>();
  for (const member of Object.values(snapshot?.members ?? {})) {
    if (!member) continue;
    const memberLaneId = member.laneId ?? (member.laneKind === 'secondary' ? undefined : 'primary');
    if (memberLaneId !== laneId) continue;
    const pid = member.runtimePid;
    if (typeof pid === 'number' && Number.isFinite(pid) && pid > 0) {
      pids.add(pid);
    }
  }
  return [...pids];
}

export function resolveOpenCodeRuntimeStopOutcome(input: {
  result: OpenCodeRuntimeStopResultLike | null | undefined;
  laneId: string;
  previousLaunchState: PersistedTeamLaunchSnapshot | null | undefined;
  isRuntimeProcessAlive?: (pid: number) => boolean;
}): OpenCodeRuntimeStopOutcome {
  const result = input.result ?? null;
  if (result && typeof result === 'object' && result.stopped === true) {
    return { kind: 'stopped' };
  }
  const detail = describeOpenCodeRuntimeStopResult(result);
  const isAlive = input.isRuntimeProcessAlive ?? isProcessAlive;
  const pids = collectOpenCodeLaneRuntimePids(input.previousLaunchState, input.laneId);
  const alivePids = pids.filter((pid) => {
    try {
      return isAlive(pid);
    } catch {
      return false;
    }
  });
  if (pids.length > 0 && alivePids.length === 0) {
    return { kind: 'already_stopped', detail, checkedPids: pids };
  }
  if (pids.length === 0 && isOpenCodeCapabilitySnapshotMismatchStopDetail(detail)) {
    return { kind: 'already_stopped', detail, checkedPids: [] };
  }
  return { kind: 'failed', detail, alivePids };
}

/**
 * Throws for a genuinely failed stop; returns normally - after logging - when
 * the stop is confirmed or the runtime had already stopped.
 */
export function assertOpenCodeRuntimeStopEffective(input: {
  result: OpenCodeRuntimeStopResultLike | null | undefined;
  laneId: string;
  previousLaunchState: PersistedTeamLaunchSnapshot | null | undefined;
  message: string;
  logWarning: (message: string) => void;
  isRuntimeProcessAlive?: (pid: number) => boolean;
}): OpenCodeRuntimeStopOutcome {
  const outcome = resolveOpenCodeRuntimeStopOutcome(input);
  if (outcome.kind === 'failed') {
    const suffix = outcome.detail ? `: ${outcome.detail}` : '';
    const alive =
      outcome.alivePids.length > 0
        ? ` (host process still alive: pid ${outcome.alivePids.join(', ')})`
        : ' (no recorded host pid to verify)';
    throw new Error(`${input.message}${suffix}${alive}`);
  }
  if (outcome.kind === 'already_stopped') {
    const evidence =
      outcome.checkedPids.length > 0
        ? `no recorded host process is alive (checked pid ${outcome.checkedPids.join(', ')})`
        : 'the capability snapshot mismatch left no recorded host pid to verify';
    input.logWarning(
      `${input.message}, but ${evidence}; treating the runtime as already stopped${
        outcome.detail ? `: ${outcome.detail}` : ''
      }`
    );
  }
  return outcome;
}
