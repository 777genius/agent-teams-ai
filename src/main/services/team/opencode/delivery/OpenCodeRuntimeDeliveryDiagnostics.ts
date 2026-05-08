import type { OpenCodePromptDeliveryLedgerRecord } from './OpenCodePromptDeliveryLedger';

const SECRET_VALUE_PATTERNS = [
  /\bsk-[A-Z0-9_-]{12,}\b/gi,
  /\b[A-Z0-9_-]*api[_-]?key[A-Z0-9_-]*[=:]\s*['"]?[^'"\s]+/gi,
  /\bauthorization:\s*bearer\s+[^'"\s]+/gi,
] as const;

const GENERIC_DELIVERY_DIAGNOSTIC_TOKENS = [
  'opencode app mcp was reattached before message delivery',
  'reattached stale opencode app mcp server',
  'opencode session reconcile skipped because the stored session is stale',
  'recreated opencode session before message delivery',
  'opencode message delivery observe bridge failed',
  'opencode bridge command timed out',
  'opencode bootstrap mcp did not complete required tools before assistant response',
  'existing app mcp config does not expose environment',
  'empty_assistant_turn',
  'visible_reply_still_required',
  'prompt_delivered_no_assistant_message',
  'plain_text_ack_only_still_requires_answer',
  'visible_reply_ack_only_still_requires_answer',
  'visible_reply_destination_not_found_yet',
  'visible_reply_missing_relayofmessageid',
  'visible_reply_missing_task_refs',
  'visible_reply_missing_task_refs_after_merge',
  'visible_reply_task_refs_merge_failed',
  'opencode_runtime_delivery_task_refs_inherited_from_relay',
  'non_visible_tool_without_task_progress',
] as const;

const ACTION_REQUIRED_DELIVERY_ERROR_TOKENS = [
  'auth_unavailable',
  'no auth available',
  'authentication_failed',
  'unauthorized',
  'forbidden',
  'invalid api key',
  'api key',
  'does not have access',
  'please run /login',
  'insufficient credits',
  'quota exceeded',
  'quota exhausted',
  'capacity exceeded',
  'key limit exceeded',
  'total limit',
] as const;

export function normalizeOpenCodeRuntimeDeliveryDiagnostic(
  message: string | null | undefined
): string | null {
  const scrubbed = SECRET_VALUE_PATTERNS.reduce(
    (current, pattern) => current.replace(pattern, '[redacted]'),
    message ?? ''
  );
  const normalized = scrubbed
    ?.replace(/\s+/g, ' ')
    .trim()
    .replace(/^Latest assistant message\s+\S+\s+failed with APIError\s*[-:]\s*/i, '')
    .replace(/^APIError\s*[-:]\s*/i, '');
  return normalized && normalized.length > 0 ? normalized : null;
}

export function isGenericOpenCodeRuntimeDeliveryDiagnostic(message: string): boolean {
  const normalized = message.trim().toLowerCase();
  return GENERIC_DELIVERY_DIAGNOSTIC_TOKENS.some((token) => normalized.includes(token));
}

export function selectOpenCodeRuntimeDeliveryReason(
  record: OpenCodePromptDeliveryLedgerRecord
): string | null {
  const candidates = [...record.diagnostics.slice().reverse(), record.lastReason];
  const normalized = candidates.flatMap((candidate) => {
    const message = normalizeOpenCodeRuntimeDeliveryDiagnostic(candidate);
    return message ? [message] : [];
  });
  const specific = normalized.find(
    (message) => !isGenericOpenCodeRuntimeDeliveryDiagnostic(message)
  );
  if (specific) {
    return boundOpenCodeRuntimeDeliveryReason(specific);
  }

  const fallback = getOpenCodeRuntimeDeliveryStateFallback(record);
  if (fallback) {
    return fallback;
  }

  return normalized.length > 0 ? 'OpenCode runtime delivery did not complete.' : null;
}

export function isActionRequiredOpenCodeRuntimeDeliveryReason(
  message: string | null | undefined
): boolean {
  const normalized = normalizeOpenCodeRuntimeDeliveryDiagnostic(message)?.toLowerCase();
  if (!normalized) {
    return false;
  }
  return ACTION_REQUIRED_DELIVERY_ERROR_TOKENS.some((token) => normalized.includes(token));
}

function getOpenCodeRuntimeDeliveryStateFallback(
  record: OpenCodePromptDeliveryLedgerRecord
): string | null {
  const state = record.responseState?.trim();
  const reason = record.lastReason?.trim();
  const diagnostics = record.diagnostics.map((diagnostic) => diagnostic.trim().toLowerCase());
  if (state === 'empty_assistant_turn' || reason === 'empty_assistant_turn') {
    return 'OpenCode returned an empty assistant turn.';
  }
  if (
    reason === 'visible_reply_missing_task_refs' ||
    diagnostics.includes('visible_reply_missing_task_refs') ||
    diagnostics.includes('visible_reply_missing_task_refs_after_merge')
  ) {
    return 'OpenCode created a reply without the required taskRefs metadata.';
  }
  if (diagnostics.includes('visible_reply_task_refs_merge_failed')) {
    return 'OpenCode created a reply without the required taskRefs metadata, and the app could not attach it automatically.';
  }
  if (
    reason === 'visible_reply_still_required' ||
    reason === 'visible_reply_ack_only_still_requires_answer' ||
    reason === 'plain_text_ack_only_still_requires_answer'
  ) {
    return 'OpenCode responded, but did not create a visible message_send reply.';
  }
  if (
    state === 'prompt_delivered_no_assistant_message' ||
    reason === 'prompt_delivered_no_assistant_message'
  ) {
    return 'OpenCode accepted the prompt, but no assistant turn was recorded.';
  }
  if (
    reason === 'visible_reply_destination_not_found_yet' ||
    reason === 'visible_reply_missing_relayOfMessageId'
  ) {
    return 'OpenCode created a reply without the required relayOfMessageId correlation.';
  }
  if (reason === 'non_visible_tool_without_task_progress') {
    return 'OpenCode used tools, but did not create a visible reply or task progress proof.';
  }
  return null;
}

function boundOpenCodeRuntimeDeliveryReason(reason: string): string {
  return reason.length > 500 ? `${reason.slice(0, 497).trimEnd()}...` : reason;
}
