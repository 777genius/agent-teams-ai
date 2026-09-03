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
 */

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
    input.logWarning(
      `${input.message}, but no recorded host process is alive (checked pid ${outcome.checkedPids.join(', ')}); treating the runtime as already stopped${
        outcome.detail ? `: ${outcome.detail}` : ''
      }`
    );
  }
  return outcome;
}
