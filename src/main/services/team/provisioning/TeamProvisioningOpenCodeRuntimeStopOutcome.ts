import { isProcessAlive } from '@main/utils/processHealth';

import { redactBridgeDiagnosticText } from '../opencode/bridge/OpenCodeBridgeCommandClient';
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
  'team_process_exit_unconfirmed',
  'primary_lane_ownership_mismatch',
  'provisioning_cancel_stop_unconfirmed',
  'prompt_delivery_ledger_error',
  'runtime_adapter_unavailable',
  'lane_ownership_changed_after_stop',
  'secondary_lane_stop_unconfirmed',
  'runtime_stop_unconfirmed',
  'regular_stop_rejected_unknown',
] as const;

/**
 * Finite closed code for a regular-stop rejection. The rejection's own text only
 * reaches diagnostics, which the IPC boundary drops, so the stop failure has to
 * name its cause in a code the caller can carry away.
 */
export function openCodeRegularStopRejectionCode(error: unknown): string {
  const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  if (message.includes('did not stop after SIGKILL')) return 'team_process_exit_unconfirmed';
  if (message.includes('primary lane is not owned by')) {
    return 'primary_lane_ownership_mismatch';
  }
  if (message.includes('did not confirm stop during cancellation')) {
    return 'provisioning_cancel_stop_unconfirmed';
  }
  if (message.includes('File lock timeout:') || message.includes('VersionedJsonStoreError')) {
    return 'prompt_delivery_ledger_error';
  }
  if (message.includes('runtime adapter is unavailable')) return 'runtime_adapter_unavailable';
  if (message.includes('ownership changed before stopped storage cleanup')) {
    return 'lane_ownership_changed_after_stop';
  }
  if (message.includes('did not confirm stop') && message.includes('secondary lane')) {
    return 'secondary_lane_stop_unconfirmed';
  }
  if (message.includes('did not confirm stop')) return 'runtime_stop_unconfirmed';
  return stopRejectionHintCode(error);
}

/** Bounded closed-token fallback: an unrecognized rejection still names its own shape. */
function stopRejectionHintCode(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const tokens = message
    .toLowerCase()
    .split(/[^a-z_]+/)
    .filter((token) => token.length >= 3 && token.length <= 16)
    .slice(0, 10);
  if (tokens.length === 0) return 'regular_stop_rejected_unknown';
  return `reject_${tokens.join('_')}`.slice(0, 90);
}

/** Finite diagnostics only: never forward native/provider message text.
 * A `reject_*` code is the bounded closed-token projection the fallback
 * classifier builds from a rejection shape, allowed through by the same rule. */
export function openCodeStopFailureCodes(diagnostics: unknown): string[] {
  const codes = stringList(diagnostics).flatMap((row) => {
    const code = /^(?:info:|warning:|error:|stop_failure_code:)([a-z_]+)(?::|$)/.exec(row)?.[1];
    if (!code) return [];
    if (STOP_FAILURE_CODES.some((known) => known === code)) return [code];
    return /^reject_[a-z_]{2,80}$/.test(code) ? [code] : [];
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

/**
 * Single-line, length-bounded, secret-redacted form of external stop detail for warning
 * logs. Stop results and adapter exceptions come from an out-of-process runtime, so their
 * text is treated as untrusted: control and line separators are collapsed, credential
 * shaped values are redacted, and the result is capped.
 */
export function sanitizeOpenCodeRuntimeStopDetail(detail: string, maxChars = 400): string {
  const collapsed = redactBridgeDiagnosticText(detail)
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f\u0080-\u009f\u2028\u2029]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!collapsed) return 'no stop diagnostics returned';
  return collapsed.length > maxChars ? `${collapsed.slice(0, maxChars - 1)}…` : collapsed;
}

/**
 * Single-line, length-bounded form of an unconfirmed Stop result for warning logs, so a
 * retained lane explains itself instead of only reporting that it was not confirmed.
 */
export function summarizeOpenCodeRuntimeStopFailure(
  result: OpenCodeRuntimeStopResultLike | null,
  maxChars = 400
): string {
  return sanitizeOpenCodeRuntimeStopDetail(describeOpenCodeRuntimeStopResult(result), maxChars);
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
  // `runtime_already_down` is the deliberate finished-stop outcome of a team
  // with no owned OpenCode lane ids: the recorded hosts exited before the
  // orchestrator acknowledged and the flow completed its force cleanup, which
  // both entry points describe as having finished the stop. The rejection
  // below is scoped to the OpenCode lane case - a stop that did not confirm -
  // and this idempotent one did.
  if (result.stopOutcome === 'runtime_already_down') return;
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
