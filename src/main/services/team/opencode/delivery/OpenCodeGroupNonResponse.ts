import type { OpenCodePromptDeliveryLedgerRecord } from './OpenCodePromptDeliveryLedger';

export const OPENCODE_NATIVE_PEER_GROUP_NON_RESPONSE_REASON =
  'opencode_native_peer_group_completed_without_response';

/** A runtime-certified, completed no-response turn of this exact accepted peer delivery. */
export function isOpenCodeCompletedGroupNonResponse(
  record: OpenCodePromptDeliveryLedgerRecord
): boolean {
  const sender = record.replyRecipient?.trim().toLowerCase();
  const promptId = record.lastRuntimePromptMessageId ?? record.runtimePromptMessageId;
  return Boolean(
    record.groupChatId &&
    !record.cancelledAt &&
    sender &&
    sender !== 'user' &&
    sender !== 'system' &&
    record.responseState === 'responded_plain_text' &&
    (record.lastReason === 'assistant_child_completed_with_non_response_text' ||
      (record.lastReason === OPENCODE_NATIVE_PEER_GROUP_NON_RESPONSE_REASON &&
        (!record.observedAssistantPreview?.trim() ||
          record.observedAssistantPreview.trim() === '[[AGENT_TEAMS_NO_REPLY]]'))) &&
    record.acceptedAt &&
    !record.acceptanceUnknown &&
    promptId &&
    record.deliveredUserMessageId === promptId &&
    record.observedAssistantMessageId?.trim() &&
    record.observedToolCallNames.every(
      (name) => name.replace(/^(?:mcp__agent[-_]teams__|agent[-_]teams_)/, '') === 'group_chat_list'
    ) &&
    !record.visibleReplyMessageId
  );
}
