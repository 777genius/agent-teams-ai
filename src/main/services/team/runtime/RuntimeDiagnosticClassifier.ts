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
  tokens: readonly string[];
  priority: number;
  actionRequired?: boolean;
  generic?: boolean;
  normalizeMessage?: (message: string) => string;
}

const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Z0-9_-]{12,}\b/gi,
  /\b[A-Z0-9_-]*api[_-]?key[A-Z0-9_-]*[=:]\s*['"]?[^'"\s]+/gi,
  /\bauthorization:\s*bearer\s+[^'"\s]+/gi,
] as const;

const DISK_FULL_MESSAGE =
  'Local disk is full (ENOSPC). Free disk space and retry OpenCode delivery.';

const RUNTIME_DIAGNOSTIC_RULES: readonly RuntimeDiagnosticRule[] = [
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
      'insufficient credits',
      'key limit exceeded',
      'total limit',
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
      'please run /login',
    ],
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
    tokens: ['opencode bridge command timed out'],
    priority: 20,
    generic: true,
  },
  {
    reasonCode: 'network_error',
    tokens: ['timeout', 'timed out', 'network', 'connection', 'econn', 'enotfound', 'fetch failed'],
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
  const rule = RUNTIME_DIAGNOSTIC_RULES.find((candidate) =>
    candidate.tokens.some((token) => normalized.includes(token))
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
