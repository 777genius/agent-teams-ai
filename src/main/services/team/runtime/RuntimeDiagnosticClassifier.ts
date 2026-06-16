import type { MemberRuntimeAdvisory } from '@shared/types';

export interface RuntimeDiagnosticClassification {
  reasonCode: NonNullable<MemberRuntimeAdvisory['reasonCode']>;
  normalizedMessage: string | null;
  priority: number;
  actionRequired: boolean;
  generic: boolean;
}

interface RuntimeDiagnosticRule {
  reasonCode: RuntimeDiagnosticClassification['reasonCode'];
  tokens?: readonly string[];
  priority: number;
  actionRequired?: boolean;
  generic?: boolean;
  match?: (message: string) => boolean;
  normalizeMessage?: (message: string) => string;
}

const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Z0-9_-]{12,}\b/gi,
  /\b[A-Z0-9_-]*api[_-]?key[A-Z0-9_-]*[=:]\s*['"]?[^'"\s]+/gi,
  /\b[A-Z0-9_]*(?:AUTH_TOKEN|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*[=:]\s*['"]?[^'"\s]+/gi,
  /\bauthorization:\s*bearer\s+[^'"\s]+/gi,
] as const;

const DISK_FULL_MESSAGE =
  'Local disk is full (ENOSPC). Free disk space and retry OpenCode delivery.';
const OPENCODE_BRIDGE_OUTCOME_UNKNOWN_AFTER_TIMEOUT_MESSAGE =
  'OpenCode bridge outcome unknown after timeout, retrying/observing.';
const OPENCODE_SESSION_REFRESH_MESSAGE =
  'OpenCode session changed; refreshing the session before retry.';
const OPENCODE_SESSION_REFRESH_REASON_PATTERN =
  /\b(?:resolved_behavior_changed|opencode_app_mcp_transport_changed):[-a-z0-9._~/=]+->[-a-z0-9._~/=]+/i;
const OPENCODE_SESSION_REFRESH_FAILURE_PATTERN =
  // eslint-disable-next-line sonarjs/regex-complexity -- Keyword taxonomy is kept literal to preserve diagnostic behavior.
  /(?:^|[_\s:;.\/()-])(?:permission[_\s-]?denied|permission[_\s-]?blocked|access[_\s-]?denied|auth[_\s-]?unavailable|authentication[_\s-]?failed|unauthorized|forbidden|401|403|login[_\s-]?required|not\s+logged\s+in|missing\s+credentials?|invalid\s+credentials?|credentials?[_\s-]?required|credentials?[_\s-]?unavailable|no auth available|authorization|auth(?:entication)?(?:[_\s-]?(?:failed|unavailable))?|invalid api[_\s-]?key|api[_\s-]?key|does not have access|quota|rate[_\s-]?(?:limit|limited)|too many requests|429|model cooldown|cooling down|enospc|no space left|disk is full|capacity exceeded|quota exhausted|usage exceeded|free usage exceeded|key limit exceeded|total limit|insufficient credits|subscribe to go|error|failed|failure|timeout|timed\s+out|network|connection|unable\s+to\s+connect|connect\s+failed|econn[a-z_]*|enotfound|fetch[_\s-]?failed|connection[_\s-]?(?:refused|reset)|aborted|cancel(?:ed|led)|interrupted|service[_\s-]?unavailable|temporarily\s+unavailable|overloaded|visible[_\s-]?reply(?:[_\s-][a-z0-9]+)*|task[_\s-]?refs|relayofmessageid|relay[_\s-]?of[_\s-]?message[_\s-]?id|message[_\s-]?send|non[_\s-]?visible[_\s-]?tool(?:[_\s-][a-z0-9]+)*|protocol[_\s-]?proof)(?=$|[_\s:;.\/(),-])/i;
const OPENCODE_SESSION_REFRESH_ANY_REASON_PATTERN =
  /\b(?:resolved_behavior_changed|opencode_app_mcp_transport_changed):[-a-z0-9._~/=]+->[-a-z0-9._~/=]+/gi;
const OPENCODE_SESSION_REFRESH_SAFE_MARKER_STATE_PATTERN =
  /\b(?:not_observed|pending|prompt_not_indexed|responded_tool_call|responded_visible_message|responded_non_visible_tool|responded_plain_text|permission_blocked|tool_error|empty_assistant_turn|prompt_delivered_no_assistant_message|session_stale|session_error|reconcile_failed)\b/g;

function isCleanOpenCodeSessionRefreshDiagnostic(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  const refreshText = stripOpenCodeGenericApiErrorPrefix(normalized);
  const refreshMarkerText = refreshText.replace(/[.:\s-]+$/, '');
  if (
    refreshMarkerText === 'opencode session changed; refreshing the session before retry' ||
    refreshMarkerText === 'opencode session refresh scheduled after resolved behavior changed' ||
    refreshMarkerText === 'opencode_prompt_delivery_session_refresh_scheduled' ||
    refreshMarkerText === 'opencode_session_refresh_scheduled_after_resolved_behavior_changed' ||
    refreshMarkerText === 'opencode_session_stale_observe_scheduled_after_accepted_prompt'
  ) {
    return true;
  }
  if (!OPENCODE_SESSION_REFRESH_REASON_PATTERN.test(refreshText)) {
    return false;
  }
  const markerText = refreshText;
  if (hasOpenCodeSessionRefreshFailureConflict(markerText)) {
    return false;
  }
  const rawRemainder = markerText.replace(OPENCODE_SESSION_REFRESH_ANY_REASON_PATTERN, '');
  const remainder = rawRemainder.replace(/[().,;:\s-]+/g, '');
  if (remainder.length === 0) {
    return true;
  }
  return isBenignOpenCodeSessionRefreshRemainder(rawRemainder);
}

function stripOpenCodeGenericApiErrorPrefix(message: string): string {
  return message.replace(/^opencode api error(?:[.:\s-]+|$)/i, '');
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

function hasOpenCodeSessionRefreshFailureConflict(value: string): boolean {
  return OPENCODE_SESSION_REFRESH_FAILURE_PATTERN.test(
    value.replace(OPENCODE_SESSION_REFRESH_SAFE_MARKER_STATE_PATTERN, 'state')
  );
}

function hasDelimitedHttpAuthStatusCode(message: string): boolean {
  return /(?:^|[_\s:;.\/()-])(?:401|403)(?=$|[_\s:;.\/(),-])/i.test(message);
}

const RUNTIME_DIAGNOSTIC_RULES: readonly RuntimeDiagnosticRule[] = [
  {
    reasonCode: 'backend_error',
    match: isCleanOpenCodeSessionRefreshDiagnostic,
    priority: 20,
    generic: true,
    normalizeMessage: () => OPENCODE_SESSION_REFRESH_MESSAGE,
  },
  {
    reasonCode: 'filesystem_error',
    tokens: ['enospc', 'no space left on device', 'disk is full', 'local disk is full'],
    priority: 100,
    actionRequired: true,
    normalizeMessage: () => DISK_FULL_MESSAGE,
  },
  {
    reasonCode: 'quota_exhausted',
    tokens: [
      'exhausted your capacity',
      'capacity exceeded',
      'quota exceeded',
      'quota exhausted',
      'usage exceeded',
      'free usage exceeded',
      'insufficient credits',
      'key limit exceeded',
      'total limit',
      'subscribe to go',
    ],
    priority: 95,
    actionRequired: true,
  },
  {
    reasonCode: 'auth_error',
    tokens: [
      'auth_unavailable',
      'no auth available',
      'authentication_failed',
      'unauthorized',
      'forbidden',
      'invalid api key',
      'authentication',
      'api key',
      'does not have access',
      'permission denied',
      'permission_denied',
      'permission blocked',
      'permission_blocked',
      'access denied',
      'login required',
      'not logged in',
      'missing credential',
      'invalid credential',
      'credentials required',
      'credentials unavailable',
      'please run /login',
    ],
    match: hasDelimitedHttpAuthStatusCode,
    priority: 94,
    actionRequired: true,
  },
  {
    reasonCode: 'rate_limited',
    tokens: ['rate limit', 'too many requests', '429', 'model cooldown', 'cooling down'],
    priority: 85,
  },
  {
    reasonCode: 'codex_native_timeout',
    tokens: ['codex native exec timed out'],
    priority: 80,
  },
  {
    reasonCode: 'backend_error',
    tokens: [
      'opencode_prompt_acceptance_unknown_after_bridge_timeout',
      'opencode bridge outcome unknown after timeout',
    ],
    priority: 20,
    generic: true,
    normalizeMessage: () => OPENCODE_BRIDGE_OUTCOME_UNKNOWN_AFTER_TIMEOUT_MESSAGE,
  },
  {
    reasonCode: 'backend_error',
    tokens: ['opencode bridge command timed out'],
    priority: 20,
    generic: true,
  },
  {
    reasonCode: 'network_error',
    tokens: [
      'timeout',
      'timed out',
      'network',
      'connection',
      'unable to connect',
      'connect failed',
      'connection refused',
      'connection reset',
      'econn',
      'enotfound',
      'fetch failed',
    ],
    priority: 70,
  },
  {
    reasonCode: 'provider_overloaded',
    tokens: ['overloaded', 'temporarily unavailable', 'service unavailable', '503'],
    priority: 65,
  },
  {
    reasonCode: 'protocol_proof_missing',
    tokens: [
      'non_visible_tool_without_task_progress',
      'visible_reply_still_required',
      'visible_reply_ack_only_still_requires_answer',
      'plain_text_ack_only_still_requires_answer',
      'visible_reply_destination_not_found_yet',
      'visible_reply_missing_relayofmessageid',
      'visible_reply_missing_task_refs',
      'visible_reply_missing_task_refs_after_merge',
      'visible_reply_task_refs_merge_failed',
      'did not create a visible reply',
      'did not create a visible message_send reply',
      'did not create a visible reply or task progress proof',
      'without the required relayofmessageid correlation',
      'without the required taskrefs metadata',
      'could not be verified',
      'no visible reply has been found yet',
    ],
    priority: 60,
    generic: true,
  },
  {
    reasonCode: 'backend_error',
    tokens: [
      'empty_assistant_turn',
      'empty assistant turn',
      'prompt_delivered_no_assistant_message',
      'accepted the prompt, but no assistant turn was recorded',
      'opencode runtime delivery did not complete',
      'opencode message delivery observe bridge failed',
      'opencode bridge command timed out',
      'opencode app mcp was reattached before message delivery',
      'reattached stale opencode app mcp server',
      'recreated opencode session before message delivery',
      'opencode session reconcile skipped because the stored session is stale',
      'opencode bootstrap mcp did not complete required tools before assistant response',
      'existing app mcp config does not expose environment',
      'messageabortederror',
      'aborted',
      'bridge stdout was empty',
    ],
    priority: 20,
    generic: true,
  },
] as const;

const UNKNOWN_CLASSIFICATION: RuntimeDiagnosticClassification = {
  reasonCode: 'unknown',
  normalizedMessage: null,
  priority: 0,
  actionRequired: false,
  generic: true,
};

function stripLatestAssistantFailurePrefix(message: string): string {
  const marker = ' failed with ';
  const lowerMessage = message.toLowerCase();
  const markerIndex = lowerMessage.indexOf(marker);
  if (!lowerMessage.startsWith('latest assistant message ') || markerIndex < 0) {
    return message;
  }

  const errorNameStart = markerIndex + marker.length;
  const dashIndex = message.indexOf('-', errorNameStart);
  const colonIndex = message.indexOf(':', errorNameStart);
  const separatorIndexes = [dashIndex, colonIndex]
    .filter((index) => index >= 0)
    .sort((left, right) => left - right);
  if (separatorIndexes.length === 0) {
    return message;
  }

  const separatorIndex = separatorIndexes[0];
  const errorName = message.slice(errorNameStart, separatorIndex).trim();
  if (!/^[A-Za-z][A-Za-z0-9_.]*Error$/.test(errorName)) {
    return message;
  }

  return message.slice(separatorIndex + 1).trimStart();
}

export function normalizeRuntimeDiagnosticMessage(
  message: string | null | undefined
): string | null {
  const scrubbed = SECRET_VALUE_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, '[redacted]'),
    message ?? ''
  );
  const normalized = stripLatestAssistantFailurePrefix(
    scrubbed.replace(/\s+/g, ' ').trim()
  ).replace(/^APIError\s*[-:]\s*/i, '');
  return normalized.length > 0 ? normalized : null;
}

export function classifyRuntimeDiagnostic(
  message: string | null | undefined
): RuntimeDiagnosticClassification {
  const normalizedMessage = normalizeRuntimeDiagnosticMessage(message);
  if (!normalizedMessage) {
    return { ...UNKNOWN_CLASSIFICATION };
  }

  const normalized = normalizedMessage.toLowerCase();
  const rule = RUNTIME_DIAGNOSTIC_RULES.find(
    (candidate) =>
      Boolean(candidate.match?.(normalizedMessage)) ||
      Boolean(candidate.tokens?.some((token) => normalized.includes(token)))
  );
  if (!rule) {
    return {
      reasonCode: 'backend_error',
      normalizedMessage,
      priority: 50,
      actionRequired: false,
      generic: false,
    };
  }

  return {
    reasonCode: rule.reasonCode,
    normalizedMessage: rule.normalizeMessage?.(normalizedMessage) ?? normalizedMessage,
    priority: rule.priority,
    actionRequired: rule.actionRequired === true,
    generic: rule.generic === true,
  };
}

export function selectRuntimeDiagnosticClassification(
  messages: readonly (string | null | undefined)[]
): RuntimeDiagnosticClassification | null {
  let selected: RuntimeDiagnosticClassification | null = null;
  for (const message of messages) {
    const classified = classifyRuntimeDiagnostic(message);
    if (!classified.normalizedMessage) {
      continue;
    }
    if (!selected || classified.priority > selected.priority) {
      selected = classified;
    }
  }
  return selected;
}
