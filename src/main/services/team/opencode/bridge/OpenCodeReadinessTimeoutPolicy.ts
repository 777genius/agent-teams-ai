import type { OpenCodeLaunchTeamCommandBody } from './OpenCodeBridgeCommandContract';

/**
 * Timeout policy of the OpenCode readiness bridge: the per-command default
 * budgets, the caller-facing overrides, and the two budgets that are a rule
 * rather than a constant (launch scales with the participant count for the
 * serial native-subscription CLIs; readiness is provider-independent).
 */

/**
 * SDK run-control Stop cap: Windows DACL and physical process retirement alone
 * can exceed 30s, so a Stop clipped below this aborts a healthy physical stop
 * before its confirmation arrives.
 */
export const OPEN_CODE_SDK_STOP_CAP_MS = 45_000;
/**
 * What a stop attempt spends before the SDK Stop starts. The manifest reads,
 * handshake, lease and the runtime's own start-up draw from the same deadline
 * as the dispatch: a stop confirmed at 47.6s with at most 30s of dispatch had
 * already spent more than 17s there.
 */
export const OPEN_CODE_STOP_PRE_DISPATCH_RESERVE_MS = 25_000;
/**
 * The lost-reply reconciliation window that follows the SDK Stop operation: a
 * valid stopped receipt can still arrive inside it, and a caller that stops
 * waiting at the operation cap discards it and reports a stopped team failed.
 */
export const OPEN_CODE_STOP_LOST_REPLY_RECONCILIATION_MS = 10_000;

/** Applied whenever the caller configures no explicit budget for a command. */
export const OPEN_CODE_BRIDGE_TIMEOUTS_MS = {
  readiness: 300_000,
  launch: 120_000,
  reconcile: 30_000,
  // Longer than the renderer-facing UI timeout: late OpenCode turns should still
  // finish bridge-side observation and emit member-work-sync signals.
  send: 45_000,
  observe: 20_000,
  // One deadline covers the whole attempt: the dispatch keeps the full SDK Stop
  // window only when the budget also pays for the phases before it, and the
  // caller must outlive the operation plus the lost-reply reconciliation window
  // that can still deliver a valid stopped receipt.
  stop:
    OPEN_CODE_SDK_STOP_CAP_MS +
    OPEN_CODE_STOP_PRE_DISPATCH_RESERVE_MS +
    OPEN_CODE_STOP_LOST_REPLY_RECONCILIATION_MS,
  cleanup: 10_000,
  permission: 30_000,
  backfill: 45_000,
  commandStatus: 5_000,
} as const;

// Provisional Cursor allowance: reported 250s handoff plus 20s per participant
// overhead and a shared 30s setup/commit/cleanup reserve. Bootstrap noReply is
// not necessarily a model turn. Root desktop E2E must validate phase timings.
const CURSOR_HANDOFF_ALLOWANCE_MS = 270_000;
const CURSOR_PHASE_RESERVE_MS = 30_000;
const NATIVE_SUBSCRIPTION_CLI_LAUNCH_TIMEOUT_PER_MEMBER_MS = 90_000;
const MAX_NATIVE_SUBSCRIPTION_CLI_LAUNCH_TIMEOUT_MS = 10 * 60_000;
// 7B Ollama dest:mcp proof spent 318s after host start; the 300s readiness
// budget still deadline'd. Keep local launch above that observed wall.
const LOCAL_OPENCODE_LAUNCH_TIMEOUT_MS = 420_000;

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

function isLocalOpenCodeLaunchModel(selectedModel: string): boolean {
  const provider = selectedModel.split('/')[0]?.toLowerCase() ?? '';
  return (
    provider === 'ollama' ||
    provider === 'llama.cpp' ||
    provider === 'llamacpp' ||
    provider === 'lmstudio' ||
    provider === 'lm-studio' ||
    provider === 'local' ||
    provider === 'vllm'
  );
}

export function resolveOpenCodeLaunchTimeoutMs(
  input: Pick<OpenCodeLaunchTeamCommandBody, 'selectedModel' | 'members' | 'executionProof'>,
  configuredTimeoutMs?: number,
  _platform: NodeJS.Platform = process.platform
): number {
  if (configuredTimeoutMs !== undefined) {
    return configuredTimeoutMs;
  }
  if (
    isLocalOpenCodeLaunchModel(input.selectedModel) &&
    !input.selectedModel.toLowerCase().includes('cloud')
  ) {
    return LOCAL_OPENCODE_LAUNCH_TIMEOUT_MS;
  }
  // V2 native startup (graph validation + native child boot) needs the same
  // budget on every platform; V1 keeps the historical 120s default.
  const defaultLaunchMs = Math.max(
    OPEN_CODE_BRIDGE_TIMEOUTS_MS.launch,
    input.executionProof?.opencodeVersion?.startsWith('2.') ? 300_000 : 0
  );
  const usesSerialNativeSubscriptionCli =
    input.selectedModel.startsWith('cursor-acp/') || input.selectedModel.startsWith('kiro/');
  if (!usesSerialNativeSubscriptionCli) {
    return defaultLaunchMs;
  }
  const participantCount = Math.max(1, input.members.length + 1);
  return Math.min(
    MAX_NATIVE_SUBSCRIPTION_CLI_LAUNCH_TIMEOUT_MS,
    Math.max(
      defaultLaunchMs,
      input.selectedModel.startsWith('cursor-acp/')
        ? participantCount * CURSOR_HANDOFF_ALLOWANCE_MS + CURSOR_PHASE_RESERVE_MS
        : participantCount * NATIVE_SUBSCRIPTION_CLI_LAUNCH_TIMEOUT_PER_MEMBER_MS
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
