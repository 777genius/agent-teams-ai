import {
  classifyRuntimeDiagnostic,
  selectRuntimeDiagnosticClassification,
} from '../../runtime/RuntimeDiagnosticClassifier';

import {
  isOpenCodeResolvedBehaviorChangedReason,
  isOpenCodeSessionTransportChangedReason,
  type OpenCodePromptDeliveryLedgerRecord,
} from './OpenCodePromptDeliveryLedger';

export function normalizeOpenCodeRuntimeDeliveryDiagnostic(
  message: string | null | undefined
): string | null {
  return classifyRuntimeDiagnostic(message).normalizedMessage;
}

export function isGenericOpenCodeRuntimeDeliveryDiagnostic(message: string): boolean {
  return classifyRuntimeDiagnostic(message).generic;
}

export function selectOpenCodeRuntimeDeliveryReason(
  record: OpenCodePromptDeliveryLedgerRecord
): string | null {
  const candidates = [...record.diagnostics.slice().reverse(), record.lastReason].filter(
    (diagnostic) => !isInformationalOpenCodeRuntimeDeliveryDiagnostic(diagnostic)
  );
  const selected = selectRuntimeDiagnosticClassification(candidates);
  const fallback = getOpenCodeRuntimeDeliveryStateFallback(record);

  if (selected && !selected.generic && selected.normalizedMessage) {
    if (fallback && isPlainGenericOpenCodeApiError(selected.normalizedMessage)) {
      return fallback;
    }
    return boundOpenCodeRuntimeDeliveryReason(selected.normalizedMessage);
  }

  if (fallback) {
    return fallback;
  }

  return selected ? 'OpenCode runtime delivery did not complete.' : null;
}

function isPlainGenericOpenCodeApiError(message: string): boolean {
  return (
    message
      .trim()
      .toLowerCase()
      .replace(/[.:\s-]+$/, '') === 'opencode api error'
  );
}

function isOpenCodeRuntimeDeliverySessionRefreshScheduledDiagnostic(message: string): boolean {
  const normalized = stripOpenCodeGenericApiErrorPrefix(message.trim().toLowerCase()).replace(
    /[.:\s-]+$/,
    ''
  );
  return (
    normalized === 'opencode prompt delivery session refresh scheduled' ||
    normalized === 'opencode_prompt_delivery_session_refresh_scheduled' ||
    normalized === 'opencode session refresh scheduled after resolved behavior changed' ||
    normalized === 'opencode_session_refresh_scheduled_after_resolved_behavior_changed' ||
    normalized === 'opencode session changed; refreshing the session before retry'
  );
}

function stripOpenCodeGenericApiErrorPrefix(message: string): string {
  return message.replace(/^opencode api error(?:[.:\s-]+|$)/i, '');
}

function isOpenCodeRuntimeDeliveryCleanSessionRefreshDiagnostic(message: string): boolean {
  return (
    isOpenCodeRuntimeDeliverySessionRefreshScheduledDiagnostic(message) ||
    isOpenCodeResolvedBehaviorChangedReason(message) ||
    isOpenCodeSessionTransportChangedReason(message)
  );
}

export function isInformationalOpenCodeRuntimeDeliveryDiagnostic(
  message: string | null | undefined
): boolean {
  const normalized = message?.trim().toLowerCase();
  return (
    normalized === 'opencode app mcp is connected for message delivery.' ||
    normalized ===
      'opencode prompt_async accepted; response observation will continue through durable app-side ledger reconciliation.' ||
    normalized === 'opencode session status busy' ||
    normalized === 'opencode_delivery_response_pending' ||
    Boolean(normalized && isOpenCodeRuntimeDeliveryCleanSessionRefreshDiagnostic(normalized))
  );
}

export function isActionRequiredOpenCodeRuntimeDeliveryReason(
  message: string | null | undefined
): boolean {
  return classifyRuntimeDiagnostic(message).actionRequired;
}

function getOpenCodeRuntimeDeliveryStateFallback(
  record: OpenCodePromptDeliveryLedgerRecord
): string | null {
  const state = record.responseState?.trim();
  const reason = record.lastReason?.trim();
  const normalizedReason = reason?.toLowerCase();
  const diagnostics = record.diagnostics.map((diagnostic) => diagnostic.trim().toLowerCase());
  const diagnosticText = diagnostics.join('\n');
  const hasCleanSessionRefreshDiagnostic = diagnostics.some(
    isOpenCodeRuntimeDeliveryCleanSessionRefreshDiagnostic
  );
  if (state === 'empty_assistant_turn' || normalizedReason === 'empty_assistant_turn') {
    return 'OpenCode returned an empty assistant turn.';
  }
  if (
    normalizedReason?.includes('visible_reply_missing_task_refs') ||
    diagnosticText.includes('visible_reply_missing_task_refs')
  ) {
    return 'OpenCode created a reply without the required taskRefs metadata.';
  }
  if (
    normalizedReason?.includes('visible_reply_task_refs_merge_failed') ||
    diagnosticText.includes('visible_reply_task_refs_merge_failed')
  ) {
    return 'OpenCode created a reply without the required taskRefs metadata, and the app could not attach it automatically.';
  }
  if (
    normalizedReason?.includes('visible_reply_still_required') ||
    normalizedReason?.includes('visible_reply_ack_only_still_requires_answer') ||
    normalizedReason?.includes('plain_text_ack_only_still_requires_answer') ||
    diagnosticText.includes('visible_reply_still_required') ||
    diagnosticText.includes('visible_reply_ack_only_still_requires_answer') ||
    diagnosticText.includes('plain_text_ack_only_still_requires_answer')
  ) {
    return 'OpenCode responded, but did not create a visible message_send reply.';
  }
  if (
    state === 'prompt_delivered_no_assistant_message' ||
    normalizedReason === 'prompt_delivered_no_assistant_message'
  ) {
    return 'OpenCode accepted the prompt, but no assistant turn was recorded.';
  }
  if (
    normalizedReason?.includes('visible_reply_destination_not_found_yet') ||
    normalizedReason?.includes('visible_reply_missing_relayofmessageid') ||
    diagnosticText.includes('visible_reply_destination_not_found_yet') ||
    diagnosticText.includes('visible_reply_missing_relayofmessageid')
  ) {
    return 'OpenCode created a reply without the required relayOfMessageId correlation.';
  }
  if (
    normalizedReason?.includes('non_visible_tool_without_task_progress') ||
    diagnosticText.includes('non_visible_tool_without_task_progress')
  ) {
    return 'OpenCode used tools, but did not create a visible reply or task progress proof.';
  }
  if (
    state === 'session_stale' ||
    isOpenCodeResolvedBehaviorChangedReason(normalizedReason) ||
    isOpenCodeSessionTransportChangedReason(normalizedReason) ||
    (record.status === 'retry_scheduled' && hasCleanSessionRefreshDiagnostic)
  ) {
    return 'OpenCode session changed; refreshing the session before retry.';
  }
  return null;
}

function boundOpenCodeRuntimeDeliveryReason(reason: string): string {
  return reason.length > 500 ? `${reason.slice(0, 497).trimEnd()}...` : reason;
}
