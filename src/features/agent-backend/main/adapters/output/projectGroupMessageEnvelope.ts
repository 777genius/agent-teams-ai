import {
  assertValidGroupInboxRows,
  copyGroupChatEnvelope,
} from '@agent-teams/legacy-agent-host/group-chats/contracts';

import type { GroupChatEnvelope } from '@agent-teams/legacy-agent-host/group-chats/contracts';
/** Transport allowlist; canonical storage remains unchanged and private nested extras never escape. */
export function projectGroupMessageEnvelope(raw: Record<string, unknown>): GroupChatEnvelope {
  assertValidGroupInboxRows([raw]);
  const envelope = copyGroupChatEnvelope(raw);
  if (envelope.groupRecipientNames !== undefined) {
    if (
      !Array.isArray(envelope.groupRecipientNames) ||
      envelope.groupRecipientNames.length > 200 ||
      envelope.groupRecipientNames.some(
        (name) => typeof name !== 'string' || !name || name.length > 200
      )
    )
      throw new Error('Invalid frozen group recipients');
    envelope.groupRecipientNames = [...envelope.groupRecipientNames];
  }
  if (envelope.groupRecipientRunKeys !== undefined) {
    if (
      !envelope.groupRecipientNames ||
      !envelope.groupRecipientRunKeys ||
      typeof envelope.groupRecipientRunKeys !== 'object' ||
      Array.isArray(envelope.groupRecipientRunKeys)
    )
      throw new Error('Invalid frozen group runs');
    const keys = envelope.groupRecipientRunKeys;
    envelope.groupRecipientRunKeys = Object.fromEntries(
      envelope.groupRecipientNames.map((name) => {
        const key = keys[name];
        if (typeof key !== 'string' || !key || key.length > 500)
          throw new Error('Invalid frozen group run');
        return [name, key];
      })
    );
  }
  if (envelope.groupDeliverySummary)
    envelope.groupDeliverySummary = {
      recordedAt: envelope.groupDeliverySummary.recordedAt,
      recipients: envelope.groupDeliverySummary.recipients.map((row) => ({
        memberName: row.memberName,
        physicalMessageId: row.physicalMessageId,
        status: row.status,
        ...(row.reason === undefined ? {} : { reason: row.reason }),
      })),
    };
  return envelope;
}
