import type { OpenCodeDeliveryResponseState } from '../bridge/OpenCodeBridgeCommandContract';

export function isOpenCodeResolvedBehaviorChangedReason(
  reason: string | null | undefined
): boolean {
  return isCleanOpenCodeSessionRefreshReason(
    reason,
    /\bresolved_behavior_changed:[-a-z0-9._~/=]+->[-a-z0-9._~/=]+/i
  );
}

export function isOpenCodeSessionTransportChangedReason(
  reason: string | null | undefined
): boolean {
  return isCleanOpenCodeSessionRefreshReason(
    reason,
    /\bopencode_app_mcp_transport_changed:[-a-z0-9._~/=]+->[-a-z0-9._~/=]+/i
  );
}

const OPENCODE_SESSION_REFRESH_FAILURE_PATTERN =
  // eslint-disable-next-line sonarjs/regex-complexity -- Keyword taxonomy is kept literal to preserve diagnostic behavior.
  /(?:^|[_\s:;./()-])(?:permission[_\s-]?denied|permission[_\s-]?blocked|access[_\s-]?denied|auth[_\s-]?unavailable|authentication[_\s-]?failed|unauthorized|forbidden|401|403|login[_\s-]?required|not\s+logged\s+in|missing\s+credentials?|invalid\s+credentials?|credentials?[_\s-]?required|credentials?[_\s-]?unavailable|no auth available|authorization|auth(?:entication)?(?:[_\s-]?(?:failed|unavailable))?|invalid api[_\s-]?key|api[_\s-]?key|does not have access|quota|rate[_\s-]?(?:limit|limited)|too many requests|429|model cooldown|cooling down|enospc|no space left|disk is full|capacity exceeded|quota exhausted|usage exceeded|free usage exceeded|key limit exceeded|total limit|insufficient credits|subscribe to go|error|failed|failure|timeout|timed\s+out|network|connection|unable\s+to\s+connect|connect\s+failed|econn[a-z_]*|enotfound|fetch[_\s-]?failed|connection[_\s-]?(?:refused|reset)|aborted|cancel(?:ed|led)|interrupted|service[_\s-]?unavailable|temporarily\s+unavailable|overloaded|visible[_\s-]?reply(?:[_\s-][a-z0-9]+)*|task[_\s-]?refs|relayofmessageid|relay[_\s-]?of[_\s-]?message[_\s-]?id|message[_\s-]?send|non[_\s-]?visible[_\s-]?tool(?:[_\s-][a-z0-9]+)*|protocol[_\s-]?proof)(?=$|[_\s:;./(),-])/i;
const OPENCODE_SESSION_REFRESH_ANY_REASON_PATTERN =
  /\b(?:resolved_behavior_changed|opencode_app_mcp_transport_changed):[-a-z0-9._~/=]+->[-a-z0-9._~/=]+/gi;
const OPENCODE_SESSION_REFRESH_SAFE_MARKER_STATE_PATTERN =
  /\b(?:not_observed|pending|prompt_not_indexed|responded_tool_call|responded_visible_message|responded_non_visible_tool|responded_plain_text|permission_blocked|tool_error|empty_assistant_turn|prompt_delivered_no_assistant_message|session_stale|session_error|reconcile_failed)\b/g;

function isCleanOpenCodeSessionRefreshReason(
  reason: string | null | undefined,
  pattern: RegExp
): boolean {
  const normalized = reason?.trim().toLowerCase() ?? '';
  if (!pattern.test(normalized)) {
    return false;
  }
  const markerText = stripOpenCodeGenericApiErrorPrefix(normalized);
  if (hasOpenCodeSessionRefreshFailureConflict(markerText)) {
    return false;
  }
  const rawRemainder = markerText.replace(OPENCODE_SESSION_REFRESH_ANY_REASON_PATTERN, '');
  const remainder = rawRemainder.replace(/[().,;:\s-]+/g, '');
  if (remainder.length === 0) {
    return true;
  }
  const staleLogProjectionContext =
    normalized.includes('session is stale') ||
    normalized.includes('stored session is stale') ||
    normalized.includes('session reconcile skipped');
  if (!staleLogProjectionContext) {
    return false;
  }
  return isBenignOpenCodeSessionRefreshRemainder(rawRemainder);
}

function isBenignOpenCodeSessionRefreshRemainder(rawRemainder: string): boolean {
  if (OPENCODE_SESSION_REFRESH_FAILURE_PATTERN.test(rawRemainder)) {
    return false;
  }
  const normalized = rawRemainder.replace(/[().,;:\s-]+/g, ' ').trim();
  return (
    normalized === 'opencode session is stale' ||
    normalized ===
      'opencode session is stale reading historical messages for log projection only' ||
    normalized === 'opencode session reconcile skipped because the stored session is stale' ||
    normalized === 'stored session is stale'
  );
}

function isOpenCodeSessionRefreshScheduledReason(message: string | null | undefined): boolean {
  const normalized = stripOpenCodeGenericApiErrorPrefix(
    message?.trim().toLowerCase() ?? ''
  ).replace(/[.:\s-]+$/, '');
  return (
    normalized === 'opencode prompt delivery session refresh scheduled' ||
    normalized === 'opencode_prompt_delivery_session_refresh_scheduled' ||
    normalized === 'opencode session refresh scheduled after resolved behavior changed' ||
    normalized === 'opencode_session_refresh_scheduled_after_resolved_behavior_changed' ||
    normalized === 'opencode_session_stale_observe_scheduled_after_accepted_prompt' ||
    normalized === 'opencode session changed; refreshing the session before retry'
  );
}

function stripOpenCodeGenericApiErrorPrefix(message: string): string {
  return message.replace(/^opencode api error(?:[.:\s-]+|$)/i, '');
}

function hasOpenCodeSessionRefreshFailureConflict(value: string): boolean {
  return OPENCODE_SESSION_REFRESH_FAILURE_PATTERN.test(
    value.replace(OPENCODE_SESSION_REFRESH_SAFE_MARKER_STATE_PATTERN, 'state')
  );
}

export function isOpenCodeSessionRefreshResponseState(input: {
  responseState?: OpenCodeDeliveryResponseState;
  reason?: string | null;
  diagnostics?: readonly string[];
}): boolean {
  const candidates = [input.reason, ...(input.diagnostics ?? [])];
  const hasActionRequiredConflict = candidates.some(isOpenCodeSessionRefreshActionRequiredConflict);
  if (input.responseState === 'session_stale') {
    return !hasActionRequiredConflict;
  }
  return (
    !hasActionRequiredConflict &&
    candidates.some(
      (candidate) =>
        isOpenCodeResolvedBehaviorChangedReason(candidate) ||
        isOpenCodeSessionTransportChangedReason(candidate) ||
        isOpenCodeSessionRefreshScheduledReason(candidate)
    )
  );
}

function isOpenCodeSessionRefreshActionRequiredConflict(
  message: string | null | undefined
): boolean {
  const normalized = message?.trim().toLowerCase() ?? '';
  if (!normalized) {
    return false;
  }
  if (normalized.replace(/[.:\s-]+$/, '') === 'opencode api error') {
    return false;
  }
  if (
    isOpenCodeResolvedBehaviorChangedReason(normalized) ||
    isOpenCodeSessionTransportChangedReason(normalized) ||
    isOpenCodeSessionRefreshScheduledReason(normalized)
  ) {
    return false;
  }
  return OPENCODE_SESSION_REFRESH_FAILURE_PATTERN.test(normalized);
}
