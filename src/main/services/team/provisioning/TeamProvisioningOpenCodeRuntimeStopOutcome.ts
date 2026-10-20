import { isProcessAlive } from '@main/utils/processHealth';

import {
  formatOpenCodeStopCausalSuffix,
  ownedOpenCodeStateChangingFailure,
} from '../opencode/bridge/OpenCodeStateChangingBridgeCommandService';

import type {
  OpenCodeStopCausalFailure,
  PersistedTeamLaunchSnapshot,
  TeamForceStopResult,
} from '@shared/types';

/** Only confirmed Stop or validated runtime reconciliation authorizes lane cleanup.
 * PID absence and capability mismatch are not proof of the original Stop result. */

export interface OpenCodeRuntimeStopResultLike {
  causalFailure?: OpenCodeStopCausalFailure;
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

const STOP_FAILURE_CODES = [
  'opencode_stop_identity_changed',
  'opencode_stop_status_unconfirmed',
  'opencode_stop_abort_rejected',
  'opencode_stop_deadline',
  'opencode_stop_compensation_failed',
  'unsupported_schema',
  'unsupported_command',
  'invalid_input',
  'runtime_not_ready',
  'provider_error',
  'timeout',
  'transport_watchdog_timeout',
  'contract_violation',
  'internal_error',
] as const;

/** Finite diagnostics only: never forward native/provider message text. */
export function openCodeStopFailureCodes(diagnostics: unknown): string[] {
  const codes = stringList(diagnostics).flatMap((row) => {
    const code = /^(?:info:|warning:|error:|stop_failure_code:)([a-z_]+)(?::|$)/.exec(row)?.[1];
    return STOP_FAILURE_CODES.filter((known) => known === code);
  });
  return [...new Set(codes)];
}

export class OpenCodeRuntimeStopUnconfirmedError extends Error {
  readonly diagnosticCodes: readonly string[];
  readonly causalFailure?: OpenCodeStopCausalFailure;
  constructor(message: string, diagnostics: unknown, causalFailure?: OpenCodeStopCausalFailure) {
    super(message);
    this.causalFailure = ownedOpenCodeStateChangingFailure(causalFailure);
    this.diagnosticCodes = Object.freeze(openCodeStopFailureCodes(diagnostics));
  }
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
    throw new OpenCodeRuntimeStopUnconfirmedError(
      `${input.message}${suffix}${alive}`,
      input.result?.diagnostics,
      input.result?.causalFailure
    );
  }
  return outcome;
}

/**
 * Both Stop entry points reject the same unconfirmed outcomes: a regular stop
 * that timed out, failed, or left cleanup incomplete must never read as a
 * successful stop, whether the caller is the in-app control or a headless
 * HTTP client.
 */
export function assertEscalatedStopConfirmed(result: TeamForceStopResult): void {
  if (result.cleanupOutcome === 'incomplete' || result.stopOutcome !== 'stopped') {
    const outcome =
      ['stopped', 'stop_failed', 'timed_out', 'runtime_already_down'].find(
        (value) => value === result.stopOutcome
      ) ?? 'unknown';
    const codes = openCodeStopFailureCodes(result.diagnostics);
    throw new OpenCodeRuntimeStopUnconfirmedError(
      `team_stop_unconfirmed:${outcome}${codes.length ? ':' + codes.join(',') : ''}${formatOpenCodeStopCausalSuffix(result.causalFailure)}`,
      result.diagnostics,
      result.causalFailure
    );
  }
}
