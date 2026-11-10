import { hasGroupChatEnvelopeMarker } from './envelope.js';
import type { JsonValue } from '../contracts.js';
import { assertValidGroupInboxRows } from './envelope.js';
import { createRequire } from 'node:module';
import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import { teamCommandPath } from '../team/commandEntries.js';
import { validateGroupCommandReceipt } from './groupCommandRecords.js';
import type { CapturedGroupIntent, GroupCommandReceipt } from './groupCommandRecords.js';
import type { TeamStore } from '../team/ports.js';
import type { TeamBinding, TeamCommand } from '../team/contracts.js';
const require = createRequire(import.meta.url);
const { agentBlocks } = require('agent-teams-controller') as {
  agentBlocks: { wrapAgentBlock(text: string): string };
};
export function groupTargetCommand(
  intent: CapturedGroupIntent
): Extract<TeamCommand, { operation: 'message.send' }> {
  const row = intent.message;
  return {
    commandId: intent.recipient.commandId,
    operation: 'message.send',
    payload: {
      to: intent.recipient.name,
      messageId: row.messageId,
      text: row.text,
      ...(row.summary === undefined ? {} : { summary: row.summary }),
      ...(row.taskRefs === undefined ? {} : { taskRefs: row.taskRefs }),
    },
  };
}
export function groupInboundText(intent: CapturedGroupIntent): string {
  return [
    agentBlocks.wrapAgentBlock(
      [
        `Group context: ${JSON.stringify(intent.message)}`,
        'Reply using group_chat_send with this groupChatId and relayOfMessageId equal to the physical messageId. Use a new stable commandId and messageId UUID for each distinct reply.',
        'Acknowledge this exact inbound with group_chat_react; a human reaction is not an agent acknowledgement.',
        'Assistant text alone does not appear in the group conversation.',
      ].join('\n')
    ),
    intent.message.text,
  ].join('\n\n');
}
/** Same Team receipt and canonical original remain authoritative through queued delivery recovery. */
export function assertGroupOriginal(
  store: TeamStore,
  binding: TeamBinding,
  intent: CapturedGroupIntent
): void {
  const raw = store.read<GroupCommandReceipt>(teamCommandPath(intent.sourceCommandId));
  if (!raw) throw new TeamOwnerError('hold');
  const receipt = validateGroupCommandReceipt(raw);
  assertValidGroupInboxRows([intent.message]);
  if (
    digest(receipt.binding) !== digest(binding) ||
    receipt.fingerprint !== intent.sourceFingerprint ||
    receipt.principalId !== intent.principalId ||
    receipt.actor !== intent.actor ||
    receipt.authorityRevision !== intent.authorityRevision ||
    digest(intent.binding) !== digest(binding) ||
    intent.message.from !== intent.actor ||
    intent.message.to !== intent.recipient.name ||
    intent.message.messageId !== intent.recipient.physicalMessageId ||
    receipt.request.operation !== 'send' ||
    intent.message.groupChatId !== receipt.request.groupChatId ||
    intent.message.groupMessageId !== receipt.request.messageId ||
    intent.message.text !== receipt.request.text ||
    intent.message.summary !== receipt.request.summary ||
    digest(intent.message.taskRefs ?? []) !== digest(receipt.request.taskRefs ?? []) ||
    intent.message.relayOfMessageId !== receipt.request.relayOfMessageId ||
    receipt.deliveries.filter(
      (row) =>
        digest(row.recipient) === digest(intent.recipient) &&
        row.messageDigest === digest(intent.message)
    ).length !== 1
  )
    throw new TeamOwnerError('hold');
}

/** Match the existing desktop inbox projection: logical group rows appear once, physical delivery rows stay private to their consumer. */
export function canonicalGroupMessages(messages: JsonValue[]): JsonValue[] {
  assertValidGroupInboxRows(messages);
  return messages.filter(
    (row) =>
      !hasGroupChatEnvelopeMarker(row) ||
      (!!row &&
        typeof row === 'object' &&
        !Array.isArray(row) &&
        row.messageId === row.groupMessageId)
  );
}
