import {
  classifyRuntimeDiagnostic,
  selectRuntimeDiagnosticClassification,
} from '../../runtime/RuntimeDiagnosticClassifier';

import type { OpenCodePromptDeliveryLedgerRecord } from './OpenCodePromptDeliveryLedger';

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

  if (selected && !selected.generic && selected.normalizedMessage) {
    return boundOpenCodeRuntimeDeliveryReason(selected.normalizedMessage);
  }

  const fallback = getOpenCodeRuntimeDeliveryStateFallback(record);
  if (fallback) {
    return fallback;
  }

  return selected ? 'OpenCode runtime delivery did not complete.' : null;
}

function isInformationalOpenCodeRuntimeDeliveryDiagnostic(
  message: string | null | undefined
): boolean {
  const normalized = message?.trim().toLowerCase();
  return (
    normalized === 'opencode app mcp is connected for message delivery.' ||
    normalized ===
      'opencode prompt_async accepted; response observation will continue through durable app-side ledger reconciliation.' ||
    normalized === 'opencode session status busy' ||
    normalized === 'opencode_delivery_response_pending' ||
    normalized === 'opencode_session_refresh_scheduled_after_resolved_behavior_changed' ||
    Boolean(
      normalized?.startsWith('resolved_behavior_changed:') ||
      normalized?.includes('opencode_app_mcp_transport_changed:')
    )
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
  if (state === 'empty_assistant_turn' || normalizedReason === 'empty_assistant_turn') {
    return 'OpenCode returned an empty assistant turn.';
  }
  if (
    normalizedReason === 'visible_reply_missing_task_refs' ||
    diagnostics.includes('visible_reply_missing_task_refs') ||
    diagnostics.includes('visible_reply_missing_task_refs_after_merge')
  ) {
    return 'OpenCode created a reply without the required taskRefs metadata.';
  }
  if (diagnostics.includes('visible_reply_task_refs_merge_failed')) {
    return 'OpenCode created a reply without the required taskRefs metadata, and the app could not attach it automatically.';
  }
  if (
    normalizedReason === 'visible_reply_still_required' ||
    normalizedReason === 'visible_reply_ack_only_still_requires_answer' ||
    normalizedReason === 'plain_text_ack_only_still_requires_answer'
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
    state === 'session_stale' ||
    normalizedReason?.startsWith('resolved_behavior_changed:') ||
    normalizedReason?.startsWith('opencode_app_mcp_transport_changed:')
  ) {
    return 'OpenCode session changed; refreshing the session before retry.';
  }
  if (
    normalizedReason === 'visible_reply_destination_not_found_yet' ||
    normalizedReason === 'visible_reply_missing_relayofmessageid'
  ) {
    return 'OpenCode created a reply without the required relayOfMessageId correlation.';
  }
  if (normalizedReason === 'non_visible_tool_without_task_progress') {
    return 'OpenCode used tools, but did not create a visible reply or task progress proof.';
  }
  return null;
}

function boundOpenCodeRuntimeDeliveryReason(reason: string): string {
  return reason.length > 500 ? `${reason.slice(0, 497).trimEnd()}...` : reason;
}
