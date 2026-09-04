import type { OpenCodeLaunchTeamCommandBody } from './OpenCodeBridgeCommandContract';

/**
 * Timeout policy of the OpenCode readiness bridge: the per-command default
 * budgets, the caller-facing overrides, and the two budgets that are a rule
 * rather than a constant (launch scales with the participant count for the
 * serial native-subscription CLIs; readiness is provider-independent).
 */

/** Applied whenever the caller configures no explicit budget for a command. */
export const OPEN_CODE_BRIDGE_TIMEOUTS_MS = {
  readiness: 300_000,
  launch: 120_000,
  reconcile: 30_000,
  // Longer than the renderer-facing UI timeout: late OpenCode turns should still
  // finish bridge-side observation and emit member-work-sync signals.
  send: 45_000,
  observe: 20_000,
  stop: 30_000,
  cleanup: 10_000,
  permission: 30_000,
  backfill: 45_000,
  commandStatus: 5_000,
} as const;

const NATIVE_SUBSCRIPTION_CLI_LAUNCH_TIMEOUT_PER_MEMBER_MS = 90_000;
const MAX_NATIVE_SUBSCRIPTION_CLI_LAUNCH_TIMEOUT_MS = 10 * 60_000;

/** Per-command timeout overrides accepted by the readiness bridge. */
export interface OpenCodeReadinessBridgeTimeoutOptions {
  timeoutMs?: number;
  launchTimeoutMs?: number;
  reconcileTimeoutMs?: number;
  sendTimeoutMs?: number;
  observeTimeoutMs?: number;
  stopTimeoutMs?: number;
  cleanupTimeoutMs?: number;
}

export function resolveOpenCodeLaunchTimeoutMs(
  input: Pick<OpenCodeLaunchTeamCommandBody, 'selectedModel' | 'members'>,
  configuredTimeoutMs?: number
): number {
  if (configuredTimeoutMs !== undefined) {
    return configuredTimeoutMs;
  }
  const usesSerialNativeSubscriptionCli =
    input.selectedModel.startsWith('cursor-acp/') || input.selectedModel.startsWith('kiro/');
  if (!usesSerialNativeSubscriptionCli) {
    return OPEN_CODE_BRIDGE_TIMEOUTS_MS.launch;
  }
  const participantCount = Math.max(1, input.members.length + 1);
  return Math.min(
    MAX_NATIVE_SUBSCRIPTION_CLI_LAUNCH_TIMEOUT_MS,
    Math.max(
      OPEN_CODE_BRIDGE_TIMEOUTS_MS.launch,
      participantCount * NATIVE_SUBSCRIPTION_CLI_LAUNCH_TIMEOUT_PER_MEMBER_MS
    )
  );
}

export function resolveOpenCodeReadinessTimeoutMs(
  _selectedModel: string | null,
  configuredTimeoutMs?: number
): number {
  if (configuredTimeoutMs !== undefined) {
    return configuredTimeoutMs;
  }
  return OPEN_CODE_BRIDGE_TIMEOUTS_MS.readiness;
}
