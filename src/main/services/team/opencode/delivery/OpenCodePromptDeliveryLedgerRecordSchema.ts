/**
 * Shape validation for the OpenCode prompt-delivery ledger file.
 *
 * The ledger is a versioned JSON file on disk that outlives the process that
 * wrote it, so every record read back has to be proved to be a record before
 * any policy reads it. That proof is a closed set of type guards over the
 * record's own fields plus the enumerations it may contain, and it changes only
 * when the record shape does - which is a different rhythm from the store that
 * reads and writes those records. It lives here so the store stays about
 * transitions and this stays about shape.
 */

import type {
  OpenCodeDeliveryResponseState,
  OpenCodeDeliveryVisibleReplyCorrelation,
} from '../bridge/OpenCodeBridgeCommandContract';
import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryStatus,
} from './OpenCodePromptDeliveryLedger';
import type { AgentActionMode, InboxMessageKind, TaskRef } from '@shared/types/team';

const OPENCODE_PROMPT_DELIVERY_STATUSES = new Set<OpenCodePromptDeliveryStatus>([
  'pending',
  'accepted',
  'responded',
  'unanswered',
  'retry_scheduled',
  'retried',
  'failed_retryable',
  'failed_terminal',
]);

const OPENCODE_DELIVERY_RESPONSE_STATES = new Set<OpenCodeDeliveryResponseState>([
  'not_observed',
  'pending',
  'prompt_not_indexed',
  'responded_tool_call',
  'responded_visible_message',
  'responded_non_visible_tool',
  'responded_plain_text',
  'permission_blocked',
  'tool_error',
  'empty_assistant_turn',
  'prompt_delivered_no_assistant_message',
  'session_stale',
  'session_error',
  'reconcile_failed',
]);

const OPENCODE_PROMPT_DELIVERY_SOURCES = new Set<OpenCodePromptDeliveryLedgerRecord['source']>([
  'watcher',
  'ui-send',
  'manual',
  'watchdog',
  'member-work-sync-review-pickup',
]);

const OPENCODE_DELIVERY_VISIBLE_REPLY_CORRELATIONS =
  new Set<OpenCodeDeliveryVisibleReplyCorrelation>([
    'relayOfMessageId',
    'direct_child_message_send',
    'plain_assistant_text',
  ]);

const AGENT_ACTION_MODES = new Set<AgentActionMode>(['do', 'ask', 'delegate']);

export function validateOpenCodePromptDeliveryLedgerRecords(
  value: unknown
): OpenCodePromptDeliveryLedgerRecord[] {
  if (!Array.isArray(value)) {
    throw new Error('OpenCode prompt delivery ledger must be an array');
  }
  const seen = new Set<string>();
  return value.map((record, index) => {
    if (!isOpenCodePromptDeliveryLedgerRecord(record)) {
      throw new Error(`Invalid OpenCode prompt delivery ledger record at index ${index}`);
    }
    if (seen.has(record.id)) {
      throw new Error(`Duplicate OpenCode prompt delivery ledger id: ${record.id}`);
    }
    seen.add(record.id);
    return record;
  });
}

function isOpenCodePromptDeliveryLedgerRecord(
  value: unknown
): value is OpenCodePromptDeliveryLedgerRecord {
  const record = value && typeof value === 'object' ? (value as Record<string, unknown>) : null;
  return Boolean(
    record &&
    typeof record.id === 'string' &&
    typeof record.teamName === 'string' &&
    typeof record.memberName === 'string' &&
    typeof record.laneId === 'string' &&
    isOptionalNullableString(record.runId) &&
    isOptionalNullableString(record.runtimeSessionId) &&
    isOptionalNullableString(record.runtimePromptMessageId) &&
    isOptionalStringArray(record.runtimePromptMessageIds) &&
    isOptionalNullableString(record.lastRuntimePromptMessageId) &&
    isOptionalNullableString(record.lastDeliveryAttemptIdWithAcceptedPrompt) &&
    typeof record.inboxMessageId === 'string' &&
    typeof record.inboxTimestamp === 'string' &&
    isOpenCodePromptDeliverySource(record.source) &&
    isOptionalNullableInboxMessageKind(record.messageKind) &&
    typeof record.replyRecipient === 'string' &&
    isOptionalNullableActionMode(record.actionMode) &&
    isTaskRefArray(record.taskRefs) &&
    typeof record.payloadHash === 'string' &&
    isOpenCodePromptDeliveryStatus(record.status) &&
    isOpenCodeDeliveryResponseState(record.responseState) &&
    isNonNegativeInteger(record.attempts) &&
    isNonNegativeInteger(record.maxAttempts) &&
    isOptionalNonNegativeInteger(record.sessionRefreshAttempts) &&
    isOptionalNonNegativeInteger(record.maxSessionRefreshAttempts) &&
    isOptionalNullableString(record.lastSessionRefreshReason) &&
    typeof record.acceptanceUnknown === 'boolean' &&
    isOptionalNullableString(record.nextAttemptAt) &&
    isOptionalNullableString(record.lastAttemptAt) &&
    isOptionalNullableString(record.lastObservedAt) &&
    isOptionalNullableString(record.acceptedAt) &&
    isOptionalNullableString(record.respondedAt) &&
    isOptionalNullableString(record.failedAt) &&
    isOptionalNullableString(record.cancelledAt) &&
    isOptionalNullableString(record.inboxReadCommittedAt) &&
    isOptionalNullableString(record.inboxReadCommitError) &&
    isOptionalNullableString(record.prePromptCursor) &&
    isOptionalNullableString(record.postPromptCursor) &&
    isOptionalNullableString(record.deliveredUserMessageId) &&
    isOptionalNullableString(record.observedAssistantMessageId) &&
    isOptionalNullableString(record.observedAssistantPreview) &&
    isStringArray(record.observedToolCallNames) &&
    isOptionalNullableString(record.observedVisibleMessageId) &&
    isOptionalNullableString(record.lastTurnProgressAt) &&
    isOptionalNullableNonNegativeInteger(record.observedTurnUsedTokens) &&
    isOptionalNullableString(record.visibleReplyMessageId) &&
    isOptionalNullableString(record.visibleReplyInbox) &&
    isOptionalNullableVisibleReplyCorrelation(record.visibleReplyCorrelation) &&
    isOptionalNullableString(record.lastReason) &&
    isStringArray(record.diagnostics) &&
    typeof record.createdAt === 'string' &&
    typeof record.updatedAt === 'string'
  );
}

function isOpenCodePromptDeliveryStatus(value: unknown): value is OpenCodePromptDeliveryStatus {
  return (
    typeof value === 'string' &&
    OPENCODE_PROMPT_DELIVERY_STATUSES.has(value as OpenCodePromptDeliveryStatus)
  );
}

function isOpenCodeDeliveryResponseState(value: unknown): value is OpenCodeDeliveryResponseState {
  return (
    typeof value === 'string' &&
    OPENCODE_DELIVERY_RESPONSE_STATES.has(value as OpenCodeDeliveryResponseState)
  );
}

function isOpenCodePromptDeliverySource(
  value: unknown
): value is OpenCodePromptDeliveryLedgerRecord['source'] {
  return (
    typeof value === 'string' &&
    OPENCODE_PROMPT_DELIVERY_SOURCES.has(value as OpenCodePromptDeliveryLedgerRecord['source'])
  );
}

function isOptionalNullableVisibleReplyCorrelation(
  value: unknown
): value is OpenCodeDeliveryVisibleReplyCorrelation | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' &&
      OPENCODE_DELIVERY_VISIBLE_REPLY_CORRELATIONS.has(
        value as OpenCodeDeliveryVisibleReplyCorrelation
      ))
  );
}

function isOptionalNullableActionMode(value: unknown): value is AgentActionMode | null | undefined {
  return (
    value === undefined ||
    value === null ||
    (typeof value === 'string' && AGENT_ACTION_MODES.has(value as AgentActionMode))
  );
}

function isOptionalNullableInboxMessageKind(
  value: unknown
): value is InboxMessageKind | null | undefined {
  return (
    value === undefined ||
    value === null ||
    value === 'default' ||
    value === 'slash_command' ||
    value === 'slash_command_result' ||
    value === 'task_comment_notification' ||
    value === 'task_stall_remediation' ||
    value === 'member_work_sync_nudge' ||
    value === 'runtime_recovery_nudge' ||
    value === 'agent_error'
  );
}

function isOptionalNullableString(value: unknown): value is string | null | undefined {
  return value === undefined || value === null || typeof value === 'string';
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}

function isOptionalStringArray(value: unknown): value is string[] | undefined {
  return value === undefined || isStringArray(value);
}

function isNonNegativeInteger(value: unknown): value is number {
  return Number.isInteger(value) && (value as number) >= 0;
}

function isOptionalNonNegativeInteger(value: unknown): value is number | undefined {
  return value === undefined || isNonNegativeInteger(value);
}

/**
 * The turn-progress stamps are written normalized - a floored non-negative
 * integer or null - so anything else on disk is not a stamp this app wrote.
 * Accepting it would be worse than rejecting the file: a string token count
 * normalizes to "absent", which turns the next sample into a fresh baseline
 * instead of progress, and the record then ages toward the stale window while
 * its turn is demonstrably still spending tokens.
 */
function isOptionalNullableNonNegativeInteger(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || isNonNegativeInteger(value);
}

function isTaskRefArray(value: unknown): value is TaskRef[] {
  return (
    Array.isArray(value) &&
    value.every((item) => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        return false;
      }
      const taskRef = item as Record<string, unknown>;
      return (
        typeof taskRef.taskId === 'string' &&
        typeof taskRef.displayId === 'string' &&
        typeof taskRef.teamName === 'string'
      );
    })
  );
}
