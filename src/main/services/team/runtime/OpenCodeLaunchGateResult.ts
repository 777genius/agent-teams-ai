import { isOpenCodeTerminalProbeTechnicalDiagnostic } from '../opencode/readiness/OpenCodeFailureDiagnostics';

import type { OpenCodeTeamLaunchReadiness } from '../opencode/readiness/OpenCodeTeamLaunchReadiness';
import type {
  TeamRuntimeLaunchInput,
  TeamRuntimeLaunchResult,
  TeamRuntimePreLaunchGate,
} from './TeamRuntimeAdapter';

export const GENERIC_OPEN_CODE_MEMBER_FAILURE_REASON =
  'OpenCode bridge reported member launch failure';

const SECRET_FLAG_PATTERN =
  /(--(?:api-key|token|password|secret|authorization|auth-token)(?:=|\s+))("[^"]*"|'[^']*'|\S+)/gi;
const BEARER_TOKEN_PATTERN = /\bBearer\s+\S+/gi;
const SECRET_KEY_PATTERN = /\bsk-[A-Za-z0-9_-]{16,}\b/g;

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
export function buildOpenCodePreLaunchGate(reason: string): TeamRuntimePreLaunchGate {
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

/**
 * The launch result a refused launch reports: every expected member is a hard
 * failure carrying the same reason, so no caller has to reconstruct one.
 *
 * `options.preLaunchGate` is opt-in on purpose. Only a call site that can prove
 * it ran before the state-changing bridge command may set it, and the absent
 * marker therefore always reads as "this launch may already own a host".
 */
export function blockedLaunchResult(
  input: TeamRuntimeLaunchInput,
  reason: string,
  diagnostics: string[],
  warnings: string[] = [],
  options: { preLaunchGate?: boolean } = {}
): TeamRuntimeLaunchResult {
  // Every readiness state prepareOpenCodeLaunch can hand on as `reason`: the
  // state is a code, and the diagnostics beside it are what a member can be
  // shown. A state missing from this list reaches the member card as the bare
  // code with its own diagnostic left unread.
  const readinessFailure =
    reason === 'unknown_error' ||
    reason === 'model_unavailable' ||
    reason === 'not_authenticated' ||
    reason === 'mcp_unavailable' ||
    reason === 'runtime_store_blocked' ||
    reason === 'not_installed';
  const hardFailureReason = readinessFailure
    ? (firstDisplayableOpenCodeFailureMessage(diagnostics, { includeGeneric: false }) ?? reason)
    : reason;
  const members = Object.fromEntries(
    input.expectedMembers.map((member) => [
      member.name,
      {
        memberName: member.name,
        providerId: 'opencode' as const,
        launchState: 'failed_to_start' as const,
        agentToolAccepted: false,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: true,
        hardFailureReason,
        diagnostics,
      },
    ])
  );

  return {
    runId: input.runId,
    teamName: input.teamName,
    launchPhase: 'finished',
    teamLaunchState: 'partial_failure',
    members,
    warnings,
    diagnostics,
    // Attached only where the block provably precedes launchOpenCodeTeam, so an
    // absent marker always reads as "this launch may already own a host".
    ...(options.preLaunchGate === true
      ? { preLaunchGate: buildOpenCodePreLaunchGate(reason) }
      : {}),
  };
}

export function isOpenCodeLaunchTimingDiagnostic(diagnostic: string): boolean {
  return (
    diagnostic.startsWith('info:opencode_launch_member_timing:') ||
    diagnostic.startsWith('info:opencode_launch_total_timing:')
  );
}

export function firstDisplayableOpenCodeFailureMessage(
  values: readonly string[],
  options: { includeGeneric: boolean }
): string | undefined {
  for (const value of values) {
    const normalized = normalizeOpenCodeFailureMessage(value);
    if (!normalized) {
      continue;
    }
    if (!options.includeGeneric && isGenericOpenCodeFailureMessage(normalized)) {
      continue;
    }
    return normalized;
  }
  return undefined;
}

export function normalizeOpenCodeFailureMessage(value: string | undefined): string | undefined {
  const trimmed = value?.replace(/\s+/g, ' ').trim();
  if (!trimmed) {
    return undefined;
  }
  return trimmed
    .replace(SECRET_FLAG_PATTERN, '$1[redacted]')
    .replace(BEARER_TOKEN_PATTERN, 'Bearer [redacted]')
    .replace(SECRET_KEY_PATTERN, '[redacted-api-key]');
}

function isGenericOpenCodeFailureMessage(message: string): boolean {
  return (
    message === GENERIC_OPEN_CODE_MEMBER_FAILURE_REASON ||
    message.startsWith(`${GENERIC_OPEN_CODE_MEMBER_FAILURE_REASON}:`) ||
    // Reassurance text prepended ahead of the real readiness diagnostic for
    // mcp_unavailable/unknown_error (see the prepareOpenCodeLaunch caller).
    // Without this, it wins as the first "displayable" (non-generic) message
    // and permanently hides the specific diagnostic behind it - which is what
    // shouldRetryTransientOpenCodeSharedRuntimeFailure pattern-matches on to
    // decide whether a timeout is worth retrying.
    message === 'OpenCode is temporarily unavailable. Retry the launch.' ||
    message.startsWith('OpenCode secondary lane timing:') ||
    message.startsWith(
      'OpenCode bridge reported ready without all required durable checkpoints:'
    ) ||
    message.startsWith(
      'OpenCode bridge reported ready before all expected members were confirmed:'
    ) ||
    message.startsWith(
      'OpenCode bootstrap MCP did not complete required tools before assistant response:'
    ) ||
    message.startsWith('OpenCode command timed out after') ||
    message.startsWith('CLI-authenticated providers missing from live host') ||
    message.startsWith('OpenCode session status') ||
    isOpenCodeTerminalProbeTechnicalDiagnostic(message) ||
    (message.startsWith('opencode_app_mcp_tool_proof_') && message.includes('cache_hit')) ||
    isOpenCodeLaunchTimingDiagnostic(message)
  );
}
