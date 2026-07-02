import {
  isOpenCodePromptResponseStateResponded,
  type OpenCodePromptDeliveryLedgerRecord,
} from './OpenCodePromptDeliveryLedger';
import {
  decideOpenCodePromptDeliveryRepair,
  type OpenCodePromptDeliveryHardFailureKind,
} from './OpenCodePromptDeliveryRepairPolicy';
import {
  isOpenCodeVisibleReplyReadCommitAllowed,
  isOpenCodeVisibleReplySemanticallySufficient,
  type OpenCodeVisibleReplyProof,
} from './OpenCodePromptDeliveryWatchdog';
import { classifyOpenCodeRuntimeDeliveryReasonCode } from './OpenCodeRuntimeDeliveryAdvisoryPolicy';

import type { OpenCodeDeliveryResponseObservation } from '../bridge/OpenCodeBridgeCommandContract';
import type { AgentActionMode, TaskRef } from '@shared/types/team';

export function normalizeOpenCodeObservedToolName(toolName: string): string {
  return toolName
    .trim()
    .toLowerCase()
    .replace(/^mcp__agent[-_]teams__/, '')
    .replace(/^agent[-_]teams_/, '')
    .replace(/^mcp__agent_teams__/, '')
    .replace(/^agent_teams_/, '');
}

export function hasOpenCodeObservedMessageSendToolCall(
  ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null
): boolean {
  return (ledgerRecord?.observedToolCallNames ?? []).some(
    (toolName) => normalizeOpenCodeObservedToolName(toolName) === 'message_send'
  );
}

export function hasOpenCodeMemberWorkSyncReportToolProof(
  ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null
): boolean {
  const toolNames = ledgerRecord?.observedToolCallNames ?? [];
  return toolNames.some((toolName) => {
    const normalized = normalizeOpenCodeObservedToolName(toolName);
    return normalized === 'member_work_sync_report';
  });
}

export function hasOpenCodeReviewPickupWorkflowProof(
  ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null
): boolean {
  if (ledgerRecord?.workSyncIntent !== 'review_pickup') {
    return false;
  }
  const toolNames = ledgerRecord?.observedToolCallNames ?? [];
  return toolNames.some((toolName) => {
    const normalized = normalizeOpenCodeObservedToolName(toolName);
    return (
      normalized === 'review_start' ||
      normalized === 'review_approve' ||
      normalized === 'review_request_changes'
    );
  });
}

export function hasOpenCodeMemberWorkSyncReadCommitProof(
  ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null
): boolean {
  return (
    hasOpenCodeMemberWorkSyncReportToolProof(ledgerRecord) ||
    hasOpenCodeReviewPickupWorkflowProof(ledgerRecord)
  );
}

export function hasOpenCodeNonVisibleProgressProof(
  ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null
): boolean {
  if (ledgerRecord?.messageKind === 'member_work_sync_nudge') {
    return hasOpenCodeMemberWorkSyncReadCommitProof(ledgerRecord);
  }
  const toolNames = ledgerRecord?.observedToolCallNames ?? [];
  return toolNames.some((toolName) => {
    const normalized = normalizeOpenCodeObservedToolName(toolName);
    return (
      normalized === 'task_start' ||
      normalized === 'task_add_comment' ||
      normalized === 'task_complete' ||
      normalized === 'task_set_status' ||
      normalized === 'task_set_clarification' ||
      normalized === 'task_create' ||
      normalized === 'task_link' ||
      normalized === 'runtime_task_event' ||
      normalized === 'write' ||
      normalized === 'edit' ||
      normalized === 'patch'
    );
  });
}

export function isOpenCodeDirectUserPromptDelivery(
  ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null
): boolean {
  return ledgerRecord?.replyRecipient?.trim().toLowerCase() === 'user';
}

export function isOpenCodePlainTextResponseReadCommitAllowed(input: {
  actionMode?: AgentActionMode;
  taskRefs?: TaskRef[];
  visibleReply?: OpenCodeVisibleReplyProof | null;
  ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  taskRefsIncludeAll: (
    actual: readonly TaskRef[] | undefined,
    expected: readonly TaskRef[] | undefined
  ) => boolean;
}): boolean {
  if (isOpenCodeDirectUserPromptDelivery(input.ledgerRecord)) {
    return (
      Boolean(
        input.ledgerRecord?.visibleReplyInbox?.trim() &&
        input.ledgerRecord?.visibleReplyMessageId?.trim()
      ) && input.taskRefsIncludeAll(input.visibleReply?.message.taskRefs, input.taskRefs)
    );
  }
  const preview = input.ledgerRecord?.observedAssistantPreview?.trim();
  if (!preview) {
    return true;
  }
  return isOpenCodeVisibleReplySemanticallySufficient({
    actionMode: input.actionMode,
    taskRefs: input.taskRefs,
    text: preview,
  }).sufficient;
}

export async function isOpenCodeMemberWorkSyncReadCommitAllowed(input: {
  teamName?: string;
  memberName?: string;
  ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  hasAcceptedMemberWorkSyncReport: (input: {
    teamName: string;
    memberName: string;
  }) => Promise<boolean>;
}): Promise<boolean> {
  if (hasOpenCodeReviewPickupWorkflowProof(input.ledgerRecord)) {
    return true;
  }
  if (!hasOpenCodeMemberWorkSyncReportToolProof(input.ledgerRecord)) {
    return false;
  }
  const teamName = input.teamName?.trim();
  const memberName = input.memberName?.trim();
  if (!teamName || !memberName) {
    return false;
  }
  return input.hasAcceptedMemberWorkSyncReport({ teamName, memberName });
}

export async function isOpenCodeDeliveryResponseReadCommitAllowed(input: {
  teamName?: string;
  memberName?: string;
  responseState?: OpenCodeDeliveryResponseObservation['state'];
  actionMode?: AgentActionMode;
  taskRefs?: TaskRef[];
  visibleReply?: OpenCodeVisibleReplyProof | null;
  ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  hasAcceptedMemberWorkSyncReport: (input: {
    teamName: string;
    memberName: string;
  }) => Promise<boolean>;
  taskRefsIncludeAll: (
    actual: readonly TaskRef[] | undefined,
    expected: readonly TaskRef[] | undefined
  ) => boolean;
}): Promise<boolean> {
  const state = input.responseState;
  if (!state || !isOpenCodePromptResponseStateResponded(state)) {
    return false;
  }
  if (input.ledgerRecord?.messageKind === 'member_work_sync_nudge') {
    return isOpenCodeMemberWorkSyncReadCommitAllowed({
      teamName: input.teamName,
      memberName: input.memberName,
      ledgerRecord: input.ledgerRecord,
      hasAcceptedMemberWorkSyncReport: input.hasAcceptedMemberWorkSyncReport,
    });
  }
  if (state === 'responded_plain_text') {
    return isOpenCodePlainTextResponseReadCommitAllowed(input);
  }
  if (state === 'responded_visible_message') {
    return (
      isOpenCodeVisibleReplyReadCommitAllowed({
        actionMode: input.actionMode,
        taskRefs: input.taskRefs,
        visibleReply: input.visibleReply,
        transcriptOnlyVisibleReply: !input.visibleReply,
      }) && input.taskRefsIncludeAll(input.visibleReply?.message.taskRefs, input.taskRefs)
    );
  }
  const hasTaskRefs = (input.taskRefs ?? []).length > 0;
  if (!hasTaskRefs && input.actionMode !== 'do' && input.actionMode !== 'delegate') {
    return false;
  }
  return hasOpenCodeNonVisibleProgressProof(input.ledgerRecord);
}

export async function isLegacyOpenCodeMemberWorkSyncReadCommitAllowed(input: {
  teamName: string;
  memberName: string;
  workSyncIntent?: 'agenda_sync' | 'review_pickup';
  responseObservation?: OpenCodeDeliveryResponseObservation;
  hasAcceptedMemberWorkSyncReport: (input: {
    teamName: string;
    memberName: string;
  }) => Promise<boolean>;
}): Promise<boolean> {
  const state = input.responseObservation?.state;
  if (!state || !isOpenCodePromptResponseStateResponded(state)) {
    return false;
  }
  const toolNames = input.responseObservation?.toolCallNames ?? [];
  const hasReviewPickupProof =
    input.workSyncIntent === 'review_pickup' &&
    toolNames.some((toolName) => {
      const normalized = normalizeOpenCodeObservedToolName(toolName);
      return (
        normalized === 'review_start' ||
        normalized === 'review_approve' ||
        normalized === 'review_request_changes'
      );
    });
  if (hasReviewPickupProof) {
    return true;
  }
  const hasReportTool = toolNames.some(
    (toolName) => normalizeOpenCodeObservedToolName(toolName) === 'member_work_sync_report'
  );
  if (!hasReportTool) {
    return false;
  }
  return input.hasAcceptedMemberWorkSyncReport({
    teamName: input.teamName,
    memberName: input.memberName,
  });
}

export function getOpenCodeDeliveryPendingReason(input: {
  responseState?: OpenCodeDeliveryResponseObservation['state'];
  actionMode?: AgentActionMode | null;
  taskRefs?: TaskRef[];
  visibleReply?: OpenCodeVisibleReplyProof | null;
  ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  taskRefsIncludeAll: (
    actual: readonly TaskRef[] | undefined,
    expected: readonly TaskRef[] | undefined
  ) => boolean;
}): string {
  const record = input.ledgerRecord;
  const state = input.responseState ?? record?.responseState;
  if (record?.messageKind === 'member_work_sync_nudge') {
    if (state === 'responded_plain_text' || state === 'responded_visible_message') {
      return 'member_work_sync_report_required';
    }
    if (state === 'responded_non_visible_tool' || state === 'responded_tool_call') {
      if (record.workSyncIntent !== 'review_pickup') {
        return 'member_work_sync_report_required';
      }
      if (!hasOpenCodeMemberWorkSyncReadCommitProof(record)) {
        return 'member_work_sync_report_required';
      }
    }
    if (!hasOpenCodeMemberWorkSyncReadCommitProof(record)) {
      return 'member_work_sync_report_required';
    }
  }
  if (state === 'responded_visible_message' && !input.visibleReply) {
    return 'visible_reply_destination_not_found_yet';
  }
  if (
    state === 'responded_visible_message' &&
    !input.taskRefsIncludeAll(input.visibleReply?.message.taskRefs, input.taskRefs)
  ) {
    return 'visible_reply_missing_task_refs';
  }
  if (state === 'responded_plain_text') {
    const preview = record?.observedAssistantPreview?.trim();
    if (
      isOpenCodeDirectUserPromptDelivery(record) &&
      input.visibleReply &&
      !input.taskRefsIncludeAll(input.visibleReply.message.taskRefs, input.taskRefs)
    ) {
      return 'visible_reply_missing_task_refs';
    }
    if (record?.lastReason === 'visible_reply_ack_only_still_requires_answer') {
      return 'visible_reply_ack_only_still_requires_answer';
    }
    if (
      preview &&
      !isOpenCodeVisibleReplySemanticallySufficient({
        actionMode: input.actionMode,
        taskRefs: input.taskRefs,
        text: preview,
      }).sufficient
    ) {
      return 'plain_text_ack_only_still_requires_answer';
    }
    if (
      isOpenCodeDirectUserPromptDelivery(record) &&
      !record?.visibleReplyMessageId &&
      !record?.inboxReadCommittedAt
    ) {
      return 'plain_text_visible_reply_not_materialized_yet';
    }
  }
  if (record?.lastReason === 'visible_reply_ack_only_still_requires_answer') {
    return 'visible_reply_ack_only_still_requires_answer';
  }
  if (state === 'responded_non_visible_tool' || state === 'responded_tool_call') {
    const hasTaskRefs = (input.taskRefs ?? []).length > 0;
    if (!hasTaskRefs && input.actionMode !== 'do' && input.actionMode !== 'delegate') {
      return 'visible_reply_still_required';
    }
    if (!hasOpenCodeNonVisibleProgressProof(record)) {
      return 'non_visible_tool_without_task_progress';
    }
  }
  if (state === 'empty_assistant_turn') {
    return 'empty_assistant_turn';
  }
  if (state === 'prompt_delivered_no_assistant_message') {
    return 'prompt_delivered_no_assistant_message';
  }
  if (state === 'tool_error') {
    return 'tool_error_without_required_delivery_proof';
  }
  return record?.lastReason ?? 'opencode_delivery_response_pending';
}

export function normalizeOpenCodeDeliveryResponseObservation(
  observation?: OpenCodeDeliveryResponseObservation
): OpenCodeDeliveryResponseObservation | undefined {
  if (
    observation?.state !== 'empty_assistant_turn' ||
    !observation.deliveredUserMessageId ||
    observation.assistantMessageId ||
    observation.latestAssistantPreview?.trim() ||
    observation.toolCallNames.length > 0 ||
    observation.visibleMessageToolCallId ||
    observation.visibleReplyMessageId
  ) {
    return observation;
  }

  return {
    ...observation,
    state: 'prompt_delivered_no_assistant_message',
    reason: 'prompt_delivered_no_assistant_message',
  };
}

export function isOpenCodePromptAcceptedByObservation(
  observation?: OpenCodeDeliveryResponseObservation
): boolean {
  const deliveredUserMessageId = observation?.deliveredUserMessageId;
  return typeof deliveredUserMessageId === 'string' && deliveredUserMessageId.trim().length > 0;
}

export function hasOpenCodeAcceptedRuntimePrompt(
  ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null
): boolean {
  return Boolean(
    ledgerRecord?.acceptedAt ||
    ledgerRecord?.runtimePromptMessageId?.trim() ||
    ledgerRecord?.lastRuntimePromptMessageId?.trim() ||
    ledgerRecord?.deliveredUserMessageId?.trim() ||
    (ledgerRecord?.runtimePromptMessageIds ?? []).some((messageId) => messageId.trim())
  );
}

export function isOpenCodeAcceptedDeliveryMissingPromptProof(
  ledgerRecord: OpenCodePromptDeliveryLedgerRecord
): boolean {
  if (ledgerRecord.status !== 'accepted') {
    return false;
  }
  if (hasOpenCodeAcceptedRuntimePrompt(ledgerRecord)) {
    return false;
  }
  if (
    ledgerRecord.inboxReadCommittedAt ||
    ledgerRecord.visibleReplyMessageId?.trim() ||
    ledgerRecord.observedAssistantMessageId?.trim() ||
    ledgerRecord.observedAssistantPreview?.trim() ||
    hasOpenCodeNonVisibleProgressProof(ledgerRecord)
  ) {
    return false;
  }
  return (
    ledgerRecord.responseState === 'prompt_not_indexed' ||
    ledgerRecord.responseState === 'pending' ||
    ledgerRecord.responseState === 'not_observed'
  );
}

export function isOpenCodeDeliveryRetryablePendingResponse(input: {
  ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  visibleReply?: OpenCodeVisibleReplyProof | null;
  readAllowed: boolean;
}): boolean {
  if (input.readAllowed) {
    return false;
  }
  if (
    input.ledgerRecord.responseState === 'session_stale' &&
    hasOpenCodeAcceptedRuntimePrompt(input.ledgerRecord)
  ) {
    return false;
  }
  if (
    input.ledgerRecord.acceptanceUnknown &&
    !hasOpenCodeAcceptedRuntimePrompt(input.ledgerRecord)
  ) {
    return true;
  }
  if (
    input.ledgerRecord.responseState === 'empty_assistant_turn' ||
    input.ledgerRecord.responseState === 'prompt_delivered_no_assistant_message' ||
    input.ledgerRecord.responseState === 'tool_error' ||
    input.ledgerRecord.responseState === 'reconcile_failed' ||
    input.ledgerRecord.responseState === 'not_observed' ||
    input.ledgerRecord.responseState === 'session_stale'
  ) {
    return true;
  }
  if (
    input.ledgerRecord.lastReason === 'visible_reply_ack_only_still_requires_answer' ||
    input.ledgerRecord.lastReason === 'plain_text_ack_only_still_requires_answer' ||
    input.ledgerRecord.lastReason === 'visible_reply_missing_task_refs' ||
    input.ledgerRecord.lastReason === 'member_work_sync_report_required'
  ) {
    return true;
  }
  if (
    input.ledgerRecord.messageKind === 'member_work_sync_nudge' &&
    (input.ledgerRecord.responseState === 'responded_visible_message' ||
      input.ledgerRecord.responseState === 'responded_plain_text' ||
      input.ledgerRecord.responseState === 'responded_non_visible_tool' ||
      input.ledgerRecord.responseState === 'responded_tool_call')
  ) {
    return true;
  }
  if (input.ledgerRecord.responseState === 'responded_visible_message' && !input.visibleReply) {
    return true;
  }
  if (
    input.ledgerRecord.responseState === 'responded_non_visible_tool' ||
    input.ledgerRecord.responseState === 'responded_tool_call' ||
    input.ledgerRecord.responseState === 'responded_plain_text'
  ) {
    return true;
  }
  return false;
}

export function getOpenCodeDeliveryHardFailureKind(
  record?: OpenCodePromptDeliveryLedgerRecord | null
): OpenCodePromptDeliveryHardFailureKind {
  if (!record) {
    return 'none';
  }
  if (record.status === 'failed_terminal') {
    return 'unknown';
  }
  if (record.responseState === 'permission_blocked') {
    return 'permission';
  }
  if (record.responseState === 'session_error') {
    return 'session';
  }
  return 'none';
}

export function buildOpenCodePromptDeliveryRepairControlText(input: {
  ledgerRecord?: OpenCodePromptDeliveryLedgerRecord | null;
  readAllowed: boolean;
  pendingReason: string;
  controlUrl?: string | null;
}): string | null {
  const record = input.ledgerRecord;
  if (!record) {
    return null;
  }
  return decideOpenCodePromptDeliveryRepair({
    teamName: record.teamName,
    memberName: record.memberName,
    inboxMessageId: record.inboxMessageId,
    replyRecipient: record.replyRecipient,
    messageKind: record.messageKind,
    workSyncIntent: record.workSyncIntent,
    actionMode: record.actionMode,
    taskRefs: record.taskRefs,
    status: record.status,
    responseState: record.responseState,
    attempts: record.attempts,
    maxAttempts: record.maxAttempts,
    pendingReason: input.pendingReason,
    readAllowed: input.readAllowed,
    inboxReadCommitted: Boolean(record.inboxReadCommittedAt),
    visibleReplyFound: Boolean(record.visibleReplyMessageId),
    hasKnownProgressProof: hasOpenCodeNonVisibleProgressProof(record),
    toolCallNames: record.observedToolCallNames,
    acceptanceUnknown: record.acceptanceUnknown,
    hardFailureKind: getOpenCodeDeliveryHardFailureKind(record),
    controlUrl: input.controlUrl,
  }).controlText;
}

export function buildOpenCodePromptDeliveryAttemptText(input: {
  text: string;
  controlText?: string | null;
}): string {
  const controlText = input.controlText?.trim();
  return controlText ? `${controlText}\n\n${input.text}` : input.text;
}

export function isOpenCodePromptAcceptanceUnknownFailure(diagnostics: readonly string[]): boolean {
  return diagnostics.some((diagnostic) => {
    const lower = diagnostic.toLowerCase();
    return (
      lower.includes('timeout running:') ||
      lower.includes('timed out') ||
      lower.includes('did not complete') ||
      lower.includes('etimedout')
    );
  });
}

export function isOpenCodeRuntimeManifestWatermarkDeliveryFailure(
  record: OpenCodePromptDeliveryLedgerRecord
): boolean {
  return [record.lastReason, ...record.diagnostics].some(
    (reason) =>
      typeof reason === 'string' &&
      reason.toLowerCase().includes('runtime manifest high watermark is stale')
  );
}

export function isOpenCodeNoAssistantDeliveryFailure(
  record: OpenCodePromptDeliveryLedgerRecord
): boolean {
  if (record.inboxReadCommittedAt) {
    return false;
  }

  const noAssistantState =
    record.responseState === 'empty_assistant_turn' ||
    record.responseState === 'prompt_delivered_no_assistant_message';
  const reasonText = [record.responseState, record.lastReason, ...record.diagnostics]
    .filter((reason): reason is string => typeof reason === 'string' && reason.trim().length > 0)
    .join('\n')
    .toLowerCase();
  if (
    !noAssistantState &&
    !reasonText.includes('empty_assistant_turn') &&
    !reasonText.includes('prompt_delivered_no_assistant_message') &&
    !reasonText.includes('accepted the prompt, but no assistant turn was recorded')
  ) {
    return false;
  }

  return ![record.lastReason, ...record.diagnostics].some((reason) => {
    const reasonCode = classifyOpenCodeRuntimeDeliveryReasonCode(reason ?? undefined);
    return (
      reasonCode === 'quota_exhausted' ||
      reasonCode === 'auth_error' ||
      reasonCode === 'filesystem_error'
    );
  });
}

export function isOpenCodeNoAssistantTerminalDeliveryFailure(
  record: OpenCodePromptDeliveryLedgerRecord
): boolean {
  return (
    record.status === 'failed_terminal' &&
    record.attempts <= record.maxAttempts &&
    isOpenCodeNoAssistantDeliveryFailure(record)
  );
}

export function canMaterializeOpenCodePlainTextReply(
  ledgerRecord: OpenCodePromptDeliveryLedgerRecord
): boolean {
  if (ledgerRecord.responseState === 'responded_plain_text') {
    return true;
  }
  return (
    ledgerRecord.responseState === 'tool_error' &&
    hasOpenCodeObservedMessageSendToolCall(ledgerRecord)
  );
}
