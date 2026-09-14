import { isProcessAlive } from '@main/utils/processHealth';

import type { PersistedTeamLaunchSnapshot } from '@shared/types';

/** Only confirmed Stop or validated runtime reconciliation authorizes lane cleanup.
 * PID absence and capability mismatch are not proof of the original Stop result. */

export interface OpenCodeRuntimeStopResultLike {
  stopped?: unknown;
  diagnostics?: unknown;
  warnings?: unknown;
  members?: Record<string, { stopped?: boolean; diagnostics?: unknown }>;
}

export type OpenCodeRuntimeStopOutcome =
  | { kind: 'stopped' }
  | { kind: 'failed'; detail: string; alivePids: number[] };

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export function describeOpenCodeRuntimeStopResult(
  result: OpenCodeRuntimeStopResultLike | null
): string {
  const memberFailures = Object.entries(result?.members ?? {}).flatMap(([name, member]) =>
    member?.stopped === false
      ? [`${name}: ${stringList(member.diagnostics).join('; ') || 'stop unconfirmed'}`]
      : []
  );
  return [...stringList(result?.diagnostics), ...stringList(result?.warnings), ...memberFailures]
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
  return { kind: 'failed', detail, alivePids };
}

/** Reject unconfirmed Stop even when no recorded host is alive. */
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
  return outcome;
}
