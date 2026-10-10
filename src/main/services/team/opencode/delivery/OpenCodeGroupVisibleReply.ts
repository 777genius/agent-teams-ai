import { createHash } from 'crypto';

import type {
  OpenCodePromptDeliveryLedgerRecord,
  OpenCodePromptDeliveryLedgerStore,
} from './OpenCodePromptDeliveryLedger';
import type { OpenCodeVisibleReplyProof } from './OpenCodePromptDeliveryWatchdog';
import type { GroupChatSendResult } from '@features/team-group-chats/contracts';
import type { InboxMessage, TaskRef } from '@shared/types/team';

export interface OpenCodeGroupReplyInput {
  teamName: string;
  groupChatId: string;
  from: string;
  messageId: string;
  text: string;
  summary?: string;
  taskRefs?: TaskRef[];
  relayOfMessageId: string;
}
export type OpenCodeGroupReplySender = (
  input: OpenCodeGroupReplyInput
) => Promise<GroupChatSendResult>;

/** Only a canonical reply in the originating group proves that group's outcome. */
export function matchesOpenCodeGroupReply(message: InboxMessage, groupChatId?: string): boolean {
  return groupChatId
    ? message.groupChatId === groupChatId &&
        message.messageId === message.groupMessageId &&
        message.groupChatProtocolVersion === 1 &&
        message.source === 'runtime_delivery'
    : !message.groupChatId;
}

export async function materializeOpenCodeGroupReply(input: {
  teamName: string;
  memberName: string;
  ledger: OpenCodePromptDeliveryLedgerStore;
  ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  send?: OpenCodeGroupReplySender;
  checkpoint(): Promise<void>;
  messageId: string;
  nowIso(): string;
}): Promise<{
  ledgerRecord: OpenCodePromptDeliveryLedgerRecord;
  visibleReply: OpenCodeVisibleReplyProof | null;
}> {
  const record = input.ledgerRecord;
  const text = record.observedAssistantPreview?.trim();
  if (record.groupChatId && record.responseState === 'tool_error') {
    await input.checkpoint();
    const ledgerRecord = await input.ledger.markFailedTerminal({
      id: record.id,
      reason: 'group_reply_tool_rejected',
      diagnostics: record.diagnostics,
      failedAt: input.nowIso(),
    });
    return { ledgerRecord, visibleReply: null };
  }
  // A tool failure is an explicit rejected group operation, not a request to repair
  // or privately echo it. Only the one physical inbox delivery's plain-text turn
  // provides an unambiguous fallback destination.
  if (
    !input.send ||
    !record.groupChatId ||
    !text ||
    record.responseState !== 'responded_plain_text'
  ) {
    return { ledgerRecord: record, visibleReply: null };
  }
  await input.checkpoint();
  try {
    const saved = await input.send({
      teamName: input.teamName,
      groupChatId: record.groupChatId,
      from: input.memberName,
      messageId: input.messageId,
      text,
      taskRefs: record.taskRefs,
      relayOfMessageId: record.inboxMessageId,
    });
    await input.checkpoint();
    if (
      !saved.saved ||
      saved.groupChatId !== record.groupChatId ||
      saved.messageId !== input.messageId
    ) {
      return { ledgerRecord: record, visibleReply: null };
    }
    const message: InboxMessage & { messageId: string } = {
      from: input.memberName,
      to: 'user',
      text,
      timestamp: input.nowIso(),
      read: false,
      messageId: saved.messageId,
      groupMessageId: saved.messageId,
      groupChatId: record.groupChatId,
      groupChatProtocolVersion: 1,
      relayOfMessageId: record.inboxMessageId,
      source: 'runtime_delivery',
      taskRefs: record.taskRefs,
    };
    const ledgerRecord = await input.ledger.applyDestinationProof({
      id: record.id,
      visibleReplyInbox: 'user',
      visibleReplyMessageId: message.messageId,
      visibleReplyCorrelation: 'plain_assistant_text',
      semanticallySufficient: true,
      diagnostics: ['opencode_plain_text_reply_materialized_to_group'],
      observedAt: input.nowIso(),
    });
    return {
      ledgerRecord,
      visibleReply: { inboxName: 'user', message: { ...message, messageId: message.messageId } },
    };
  } catch (error) {
    await input.checkpoint();
    const reason = error instanceof Error ? error.message : String(error);
    const ledgerRecord = await input.ledger.markFailedTerminal({
      id: record.id,
      reason: 'group_reply_blocked',
      diagnostics: [reason],
      failedAt: input.nowIso(),
    });
    return { ledgerRecord, visibleReply: null };
  }
}

/** RFC UUIDv5: immutable group/delivery identity, independent of reply text or retries. */
export function buildGroupPlainTextVisibleReplyMessageId(
  record: OpenCodePromptDeliveryLedgerRecord
): string {
  // eslint-disable-next-line sonarjs/hashing -- UUIDv5 requires SHA-1 for stable non-security IDs.
  const bytes = createHash('sha1')
    .update(Buffer.from('6ba7b8109dad11d180b400c04fd430c8', 'hex'))
    .update(
      JSON.stringify([
        'opencode-group-plain-reply',
        record.groupChatId,
        record.id,
        record.inboxMessageId,
      ])
    )
    .digest()
    .subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function buildPlainTextVisibleReplyMessageId(
  record: OpenCodePromptDeliveryLedgerRecord
): string {
  const safeId = record.id.replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 96);
  return `opencode-plain-reply-${safeId}`;
}
export function buildPlainTextVisibleReplySummary(text: string): string {
  const normalized = text.replace(/\s+/g, ' ').trim();
  return normalized.length > 120 ? `${normalized.slice(0, 117).trimEnd()}...` : normalized;
}
