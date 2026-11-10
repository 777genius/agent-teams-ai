import { crossTeamInboundRow } from '../cross-team/crossTeamInbound.js';
import { TeamOwnerError } from './contracts.js';
import { digest } from './identity.js';
import { formatTeamMessage } from './formatTeamMessage.js';

import type { JsonValue } from '../contracts.js';
import type { CommandReceipt, DeliveryIntent, TeamMember } from './contracts.js';
import type { TeamStore, TeamPolicyPort, TeamAttachmentPort } from './ports.js';

function json(value: unknown): JsonValue {
  return JSON.parse(JSON.stringify(value)) as JsonValue;
}

export function commitTeamMessage(
  receipt: CommandReceipt,
  actor: string,
  members: TeamMember[],
  store: TeamStore,
  policy: TeamPolicyPort,
  attachments?: TeamAttachmentPort
): JsonValue {
  if (receipt.command.operation !== 'message.send') throw new TeamOwnerError('invalid');
  const payload = receipt.command.payload;
  const { to, text, taskRefs } = payload;
  const content = formatTeamMessage(
    payload,
    actor,
    receipt.effects.messageId,
    receipt.messageRecipientRole,
    receipt.crossTeam,
    receipt.group
  );
  const member = members.find((candidate) => candidate.name === to);
  if (receipt.messageRecipientRole !== undefined && member?.role !== receipt.messageRecipientRole)
    throw new TeamOwnerError('hold');
  if (to === 'user' ? actor === 'user' : !member?.delivery) throw new TeamOwnerError('invalid');
  if (
    to !== 'user' &&
    (!receipt.deliveryBinding ||
      receipt.authorityRevision === undefined ||
      digest(member!.delivery) !== digest(receipt.deliveryBinding))
  )
    throw new TeamOwnerError('hold');
  const row = receipt.group
    ? receipt.group.message
    : receipt.crossTeam
      ? crossTeamInboundRow(receipt, receipt.crossTeam)
      : {
          from: actor,
          to,
          text,
          timestamp: receipt.createdAt,
          messageId: receipt.effects.messageId,
          read: false,
          ...(payload.attachments?.length
            ? {
                attachments: attachments!.metadata(payload.attachments, {
                  kind: 'message',
                  member: to,
                }),
              }
            : {}),
          ...(taskRefs?.length ? { taskRefs } : {}),
          ...(payload.summary?.trim() ? { summary: payload.summary.trim() } : {}),
          ...(payload.actionMode ? { actionMode: payload.actionMode } : {}),
        };
  // The canonical writer can deduplicate semantically, not just by supplied ID.
  // Only exact identity/bytes can satisfy this command's effect proof.
  const inbox = policy.readInbox(to);
  const existing = inbox.find(
    (entry) =>
      !!entry &&
      typeof entry === 'object' &&
      !Array.isArray(entry) &&
      entry.messageId === row.messageId
  );
  if (existing) {
    if (digest({ ...(existing as Record<string, JsonValue>), read: false }) !== digest(row))
      throw new TeamOwnerError('hold');
  } else {
    const applied = receipt.group
      ? policy.sendGroupMessage?.({ ...row, member: to })
      : receipt.crossTeam
        ? policy.sendCrossTeamMessage?.({ ...row, member: to })
        : policy.sendMessage(actor, { ...row, member: to });
    if (!applied) throw new TeamOwnerError('hold');
    if (applied.messageId !== row.messageId || digest(applied.message) !== digest(row))
      throw new TeamOwnerError('hold');
  }
  if (to === 'user') return json({ messageId: row.messageId, message: row });
  if (
    !member?.delivery ||
    !receipt.deliveryBinding ||
    receipt.authorityRevision === undefined ||
    digest(member.delivery) !== digest(receipt.deliveryBinding)
  )
    throw new TeamOwnerError('hold');
  const location = `outbox/${receipt.effects.deliveryId}.json`;
  const intent: DeliveryIntent = {
    schemaVersion: 1,
    binding: receipt.deliveryBinding,
    commandId: receipt.commandId,
    principalId: receipt.principalId,
    messageId: row.messageId,
    deliveryId: receipt.effects.deliveryId,
    inputId: receipt.effects.deliveryId,
    content,
    ...(payload.attachments?.length ? { attachments: payload.attachments } : {}),
    authorityRevision: receipt.authorityRevision,
    phase: 'pending',
  };
  const previous = store.read<DeliveryIntent>(location);
  if (previous) {
    if (digest({ ...previous, phase: 'pending', runtimeReceipt: undefined }) !== digest(intent))
      throw new TeamOwnerError('hold');
  } else store.write(location, intent);
  return json({
    messageId: row.messageId,
    deliveryId: intent.deliveryId,
    message: row,
  });
}
