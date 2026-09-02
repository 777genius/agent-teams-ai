import {
  classifyRuntimeDiagnostic,
  selectRuntimeDiagnosticClassification,
} from '../../runtime/RuntimeDiagnosticClassifier';

import {
  isOpenCodeResolvedBehaviorChangedReason,
  isOpenCodeSessionTransportChangedReason,
} from './OpenCodeSessionRefreshReasonClassifier';

import type { OpenCodePromptDeliveryLedgerRecord } from './OpenCodePromptDeliveryLedger';

/**
 * Inbox-relay coalesce diagnostics. Both carry message ids, so the
 * informational allowlist below matches them by prefix; they describe expected
 * control flow, and classifying them as warnings would file every deferred
 * rider under the durable error log.
 */
export const OPENCODE_COALESCE_DEFERRED_DIAGNOSTIC =
  'opencode_inbox_relay_coalesce_deferred_dispatched_base';

export const OPENCODE_COALESCE_NOT_DISPATCHED_DIAGNOSTIC =
  'opencode_inbox_relay_coalesced_notices_not_dispatched';

/**
 * The head-of-line diagnostic, and the marker a blocked lane earns once it has
 * been blocked long enough to stop being ordinary.
 *
 * A lane serialises its prompts, so queueing behind the record that holds it is
 * how the lane is supposed to work: for the first few minutes the line reports
 * expected control flow and belongs on the durable diagnostic channel, not on
 * the member card. Past `OPENCODE_HEAD_OF_LINE_BLOCK_CRITICAL_MS` the same lane
 * is wedged rather than busy, and the marker is what stops the line being
 * filtered away as informational - the block becomes visible without a second
 * diagnostic and without a new threshold anything has to act on.
 */
export const OPENCODE_HEAD_OF_LINE_BLOCK_DIAGNOSTIC_PREFIX = 'OpenCode delivery is queued behind ';

export const OPENCODE_HEAD_OF_LINE_BLOCK_CRITICAL_MARKER = 'head_of_line_blocked';

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
    normalized === 'opencode_session_stale_observe_scheduled_after_accepted_prompt' ||
    normalized === 'opencode session changed; refreshing the session before retry'
  );
}

function stripOpenCodeGenericApiErrorPrefix(message: string): string {
  return message.replace(/^opencode api error(?:[.:\s-]+|$)/i, '');
}

function isOpenCodeInboxRelayCoalesceDiagnostic(message: string): boolean {
  return (
    message.startsWith(OPENCODE_COALESCE_DEFERRED_DIAGNOSTIC) ||
    message.startsWith(OPENCODE_COALESCE_NOT_DISPATCHED_DIAGNOSTIC)
  );
}

function isOpenCodeBusyHeadOfLineBlockDiagnostic(message: string): boolean {
  return (
    message.startsWith(OPENCODE_HEAD_OF_LINE_BLOCK_DIAGNOSTIC_PREFIX.toLowerCase()) &&
    !message.includes(OPENCODE_HEAD_OF_LINE_BLOCK_CRITICAL_MARKER)
  );
}

function isOpenCodeRuntimeDeliveryCleanSessionRefreshDiagnostic(message: string): boolean {
  return (
    isOpenCodeRuntimeDeliverySessionRefreshScheduledDiagnostic(message) ||
    isOpenCodeResolvedBehaviorChangedReason(message) ||
    isOpenCodeSessionTransportChangedReason(message)
  );
}

/**
 * Wake outcomes that mean the wake had nothing left to do. The delivery
 * watchdog schedules one wake per inbox row, and by the time it fires the row
 * may already be gone, already read and committed, or held by a relay pass that
 * is still running. None of those is a delivery problem, and a busy lane
 * produces each of them repeatedly, so a relay result that reports one must not
 * become a warning just because the wake path now reports its diagnostics.
 * Genuine wake failures (`opencode_inbox_read_failed`,
 * `opencode_member_inbox_relay_timed_out`, a refused delivery) are deliberately
 * absent and keep warning.
 *
 * Every entry carries a message id or relay key, so the match is by prefix;
 * `opencode_inbox_message_missing` covers its `_after_inflight_relay` variant.
 */
export const OPENCODE_INBOX_RELAY_WAKE_NO_OP_DIAGNOSTICS: readonly string[] = [
  'opencode_inbox_message_missing',
  'opencode_inbox_message_already_read',
  'opencode_inbox_read_already_committed',
  'opencode_inbox_relay_queued_behind_active_relay',
  'opencode_work_sync_read_commit_waiting_for_active_relay',
];

function isOpenCodeInboxRelayWakeNoOpDiagnostic(message: string): boolean {
  return OPENCODE_INBOX_RELAY_WAKE_NO_OP_DIAGNOSTICS.some((prefix) => message.startsWith(prefix));
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
    Boolean(normalized && isOpenCodeInboxRelayWakeNoOpDiagnostic(normalized)) ||
    Boolean(normalized && isOpenCodeInboxRelayCoalesceDiagnostic(normalized)) ||
    Boolean(normalized && isOpenCodeBusyHeadOfLineBlockDiagnostic(normalized)) ||
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
