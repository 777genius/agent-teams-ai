import type { OpenCodeTeamLaunchReadiness } from '../opencode/readiness/OpenCodeTeamLaunchReadiness';
import type { TeamRuntimeLaunchResult, TeamRuntimePreLaunchGate } from './TeamRuntimeAdapter';

/**
 * Readiness states a user can act on and launch again. It is deliberately wider
 * than the automatic set below: `not_installed` and `not_authenticated` are
 * retryable for a person who fixes the cause, never for a retry the app takes
 * on its own, because nothing changes while the app waits.
 */
export function isRetryableReadinessState(state: OpenCodeTeamLaunchReadiness['state']): boolean {
  return (
    state === 'not_installed' ||
    state === 'not_authenticated' ||
    state === 'runtime_store_blocked' ||
    state === 'mcp_unavailable' ||
    state === 'model_unavailable' ||
    state === 'unknown_error'
  );
}

/** Gate reasons whose block can plausibly clear on its own within seconds. */
const AUTO_RETRYABLE_PRE_LAUNCH_GATE_REASONS = new Set([
  'mcp_unavailable',
  'model_unavailable',
  'runtime_store_blocked',
  'unknown_error',
]);

/**
 * Builds the marker for a launch that was refused before any state-changing
 * bridge command ran. It is only ever attached at such a call site: an absent
 * marker means "no proof", which is the safe reading for every caller.
 */
export function openCodePreLaunchGate(reason: string): TeamRuntimePreLaunchGate {
  return {
    blocked: true,
    reason,
    retryable: isRetryableReadinessState(reason as OpenCodeTeamLaunchReadiness['state']),
  };
}

/**
 * True only for a launch result that never reached the state-changing bridge
 * command and whose gate reason can clear without user action. This is the one
 * condition under which a caller may relaunch the same lane without risking a
 * duplicate host or session.
 */
export function isAutoRetryableOpenCodePreLaunchGate(
  result: Pick<TeamRuntimeLaunchResult, 'preLaunchGate'>
): boolean {
  const gate = result.preLaunchGate;
  return (
    gate?.blocked === true &&
    gate.retryable &&
    AUTO_RETRYABLE_PRE_LAUNCH_GATE_REASONS.has(gate.reason)
  );
}
