import type {
  OpenCodeBridgeResult,
  OpenCodeLaunchTeamCommandBody,
  OpenCodeLaunchTeamCommandData,
} from './OpenCodeBridgeCommandContract';

export function isOpenCodeBridgeEmptyOutputFailure(result: OpenCodeBridgeResult<unknown>): boolean {
  return (
    !result.ok &&
    result.error.kind === 'contract_violation' &&
    (result.error.message === 'Bridge stdout was empty' ||
      result.error.message === 'Bridge stdout was empty after retry')
  );
}

export function isAmbiguousOpenCodeLaunchFailure(result: OpenCodeBridgeResult<unknown>): boolean {
  return (
    !result.ok &&
    (result.error.kind === 'timeout' ||
      result.error.kind === 'transport_watchdog_timeout' ||
      isOpenCodeBridgeEmptyOutputFailure(result) ||
      result.diagnostics.some((event) => event.type === 'opencode_bridge_unknown_outcome') ||
      result.error.message === 'OpenCode launch result behavior fingerprint mismatch')
  );
}

export function reconciliationRequiredLaunchData(
  input: OpenCodeLaunchTeamCommandBody,
  result: OpenCodeBridgeResult<unknown>
): OpenCodeLaunchTeamCommandData {
  if (result.ok) {
    throw new Error('reconciliationRequiredLaunchData expects a failed bridge result');
  }
  return {
    runId: input.runId,
    teamLaunchState: 'launching',
    members: {},
    warnings: [],
    diagnostics: [
      {
        code: 'opencode_launch_reconciliation_required',
        severity: 'warning',
        message: `OpenCode launch outcome is ambiguous: ${result.error.message}`,
      },
      ...result.diagnostics.map((event) => ({
        code: event.type,
        severity: event.severity,
        message: event.message,
      })),
    ],
    expectedBehaviorFingerprint: input.expectedBehaviorFingerprint,
  };
}

export function blockedLaunchData(
  runId: string,
  result: OpenCodeBridgeResult<unknown>
): OpenCodeLaunchTeamCommandData {
  if (result.ok) {
    throw new Error('blockedLaunchData expects a failed bridge result');
  }
  return {
    runId,
    teamLaunchState: 'failed',
    members: {},
    warnings: [],
    diagnostics: [
      {
        code: result.error.kind,
        severity: 'error',
        message: `OpenCode bridge failed: ${result.error.message}`,
      },
      ...result.diagnostics.map((event) => ({
        code: event.type,
        severity: event.severity,
        message: event.message,
      })),
    ],
  };
}
