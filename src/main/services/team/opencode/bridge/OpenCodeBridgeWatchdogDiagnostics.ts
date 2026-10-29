import { OPEN_CODE_BRIDGE_TRANSPORT_WATCHDOG_GRACE_MS } from './OpenCodeBridgeCommandContract';

export type OpenCodeBridgeTerminationReason =
  | 'process_census_failed'
  | 'birth_capture_missing'
  | 'pid_reused'
  | 'group_changed'
  | 'root_unobservable'
  | 'group_identity_missing'
  | 'exit_wait_expired'
  | 'unknown';

/** Only known owned-helper messages become finite metadata; arbitrary text is discarded. */
export function classifyOpenCodeBridgeTermination(
  error: string | undefined
): OpenCodeBridgeTerminationReason | undefined {
  if (!error) return undefined;
  if (/^Failed to inspect Unix process tree \d+$/.test(error)) return 'process_census_failed';
  const exited =
    /^Failed to verify termination of Unix process tree \d+; still observable: (.+)$/.exec(error);
  if (exited && /^\d+(?:, \d+)*$/.test(exited[1])) return 'exit_wait_expired';
  const owned = /^Failed to verify (exited )?Unix process tree \d+: (.+)$/.exec(error);
  const reasons: Record<string, OpenCodeBridgeTerminationReason> = {
    'exited root birth identity was not captured': 'birth_capture_missing',
    'root pid was reused after ownership capture': 'pid_reused',
    'owned root changed process groups': 'group_changed',
    'exited non-group root is no longer observable': 'root_unobservable',
    'exited no owned process-group identity': 'group_identity_missing',
  };
  const reason = owned ? reasons[`${owned[1] ?? ''}${owned[2]}`] : undefined;
  return typeof reason === 'string' ? reason : 'unknown';
}

export function openCodeBridgeWatchdogMessage(result: {
  outcomeUnknownReason?: 'transport_timeout' | 'output_limit' | 'termination_failed';
}): string {
  return result.outcomeUnknownReason === 'output_limit'
    ? 'OpenCode bridge output exceeded its safety limit; process outcome is unknown'
    : result.outcomeUnknownReason === 'termination_failed'
      ? 'OpenCode bridge process could not be terminated; process outcome is unknown'
      : 'OpenCode bridge transport watchdog timed out';
}

/** Existing watchdog budgets plus the finite cause; never raw stderr. */
export function openCodeBridgeWatchdogDetails(
  result: {
    outcomeUnknownReason?: 'transport_timeout' | 'output_limit' | 'termination_failed';
    terminationReason?: OpenCodeBridgeTerminationReason;
  },
  runtimeTimeoutMs: number,
  transportWatchdogGraceMs = OPEN_CODE_BRIDGE_TRANSPORT_WATCHDOG_GRACE_MS
) {
  return {
    runtimeTimeoutMs,
    transportWatchdogGraceMs,
    transportWatchdogTimeoutMs: runtimeTimeoutMs + transportWatchdogGraceMs,
    outcomeUnknownReason: result.outcomeUnknownReason ?? 'transport_timeout',
    terminationReason: result.terminationReason,
  };
}
