import type { OpenCodePromptDeliveryLedgerRecord } from './OpenCodePromptDeliveryLedger';

export const HUMAN_GROUP_REPLY_REQUIRED = 'group_reply_required_after_non_response';

/** Only an observed child of the exact accepted human delivery permits correction. */
export function isOpenCodeHumanGroupNonResponse(
  record: Partial<OpenCodePromptDeliveryLedgerRecord>
): boolean {
  const promptId = record.lastRuntimePromptMessageId ?? record.runtimePromptMessageId;
  return Boolean(
    record.groupChatId &&
    record.replyRecipient?.trim().toLowerCase() === 'user' &&
    record.acceptedAt &&
    !record.acceptanceUnknown &&
    !record.groupRepairHandoffPending &&
    promptId &&
    record.deliveredUserMessageId === promptId &&
    record.observedAssistantMessageId?.trim() &&
    record.responseState === 'responded_plain_text' &&
    record.observedAssistantPreview?.trim() === '[[AGENT_TEAMS_NO_REPLY]]' &&
    !record.visibleReplyMessageId &&
    !record.inboxReadCommittedAt &&
    !record.cancelledAt &&
    !record.lastReason?.startsWith('force_stop_requested:') &&
    record.status !== 'failed_terminal'
  );
}

export function humanGroupReplyControlText(groupChatId: string, inboxMessageId: string): string {
  return [
    '<opencode_human_group_reply>',
    `This inbound is from the human user in groupChatId=${JSON.stringify(groupChatId)}, physical inbound relayOfMessageId=${JSON.stringify(inboxMessageId)}.`,
    'Human group messages require a real reply or acknowledgement; never finish with [[AGENT_TEAMS_NO_REPLY]].',
    'For a requested or substantive answer use group_chat_send in this exact group with this relayOfMessageId. For an informational greeting or acknowledgement use group_chat_react with the same group and relayOfMessageId.',
    'Check whether that exact inbound already has your reply or reaction before sending. Send only the missing reply or reaction, then stop. Do not use message_send, repeat work, or repeat a successful group operation.',
    '</opencode_human_group_reply>',
  ].join('\n');
}

/** Reopen only the old misclassification, once and within the original send budget. */
export function recoverOpenCodeHumanGroupNonResponse(
  record: OpenCodePromptDeliveryLedgerRecord,
  now: string
): OpenCodePromptDeliveryLedgerRecord | null {
  if (
    record.status !== 'failed_terminal' ||
    record.lastReason !== 'group_non_response_runtime_unsupported' ||
    record.cancelledAt ||
    record.attempts >= record.maxAttempts ||
    !isOpenCodeHumanGroupNonResponse({ ...record, status: 'responded' })
  )
    return null;
  return {
    ...record,
    status: 'retry_scheduled',
    failedAt: null,
    nextAttemptAt: now,
    lastReason: HUMAN_GROUP_REPLY_REQUIRED,
    updatedAt: now,
  };
}

/** The corrective turn must never inherit the prior child's marker or tool receipts. */
export function clearedOpenCodeHumanGroupObservation(): Partial<OpenCodePromptDeliveryLedgerRecord> {
  return {
    responseState: 'pending',
    deliveredUserMessageId: null,
    observedAssistantMessageId: null,
    observedAssistantPreview: null,
    observedToolCallNames: [],
    observedVisibleMessageId: null,
    visibleReplyMessageId: null,
    visibleReplyInbox: null,
    visibleReplyCorrelation: null,
    respondedAt: null,
    lastObservedAt: null,
    postPromptCursor: null,
  };
}
