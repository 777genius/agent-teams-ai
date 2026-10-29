import { TeamOwnerError } from '../team/contracts.js';
import { digest } from '../team/identity.js';
import type { JsonValue } from '../contracts.js';
import type { TeamBinding, DeliveryBinding } from '../team/contracts.js';
import type { GroupMessage } from './message.js';

import { groupMutationSchema } from './operations.js';
import type { GroupMutation } from './operations.js';
export { groupMutationSchema } from './operations.js';
export type { GroupMutation } from './operations.js';
export interface GroupRecipient {
  name: string;
  physicalMessageId: string;
  commandId: string;
  binding: DeliveryBinding;
}
export interface GroupCommandReceipt {
  schemaVersion: 1;
  family: 'group-chat';
  binding: TeamBinding;
  commandId: string;
  principalId: string;
  actor: string;
  authorityRevision: number;
  request: GroupMutation;
  createdAt: string;
  fingerprint: string;
  phase: 'prepared' | 'held' | 'completed';
  publication: 'not-requested' | 'requested';
  deliveries: { recipient: GroupRecipient; messageDigest: string }[];
  response?: JsonValue;
}
/** Original Team-owned physical delivery, never accepted from a public request. */
export interface CapturedGroupIntent {
  binding: TeamBinding;
  sourceCommandId: string;
  sourceFingerprint: string;
  principalId: string;
  actor: string;
  authorityRevision: number;
  recipient: GroupRecipient;
  message: GroupMessage & { messageId: string; to: string };
}
export function groupReceiptFingerprint(receipt: Omit<GroupCommandReceipt, 'fingerprint'>): string {
  return digest({
    family: 'group-chat',
    binding: receipt.binding,
    commandId: receipt.commandId,
    principalId: receipt.principalId,
    actor: receipt.actor,
    authorityRevision: receipt.authorityRevision,
    request: receipt.request,
    createdAt: receipt.createdAt,
  });
}
export function validateGroupCommandReceipt(value: GroupCommandReceipt): GroupCommandReceipt {
  try {
    if (
      !value ||
      value.schemaVersion !== 1 ||
      value.family !== 'group-chat' ||
      !value.binding ||
      !value.principalId ||
      !value.actor ||
      !value.commandId ||
      value.commandId.length > 256 ||
      !Number.isSafeInteger(value.authorityRevision) ||
      value.authorityRevision < 1 ||
      !['prepared', 'held', 'completed'].includes(value.phase) ||
      !['not-requested', 'requested'].includes(value.publication) ||
      !Number.isFinite(Date.parse(value.createdAt)) ||
      !Array.isArray(value.deliveries) ||
      value.deliveries.length > 256 ||
      new Set(value.deliveries.map((row) => row.recipient.name)).size !== value.deliveries.length ||
      !/^[a-f0-9]{64}$/.test(value.fingerprint) ||
      groupReceiptFingerprint(value) !== value.fingerprint ||
      (value.response !== undefined && value.phase !== 'completed') ||
      Buffer.byteLength(JSON.stringify(value)) > 2 * 1024 * 1024
    )
      throw new Error();
    groupMutationSchema.parse(value.request);
    for (const capture of value.deliveries) {
      if (
        !capture.recipient ||
        typeof capture.recipient.name !== 'string' ||
        !capture.recipient.name ||
        capture.recipient.name.length > 200 ||
        typeof capture.recipient.commandId !== 'string' ||
        !capture.recipient.commandId ||
        capture.recipient.commandId.length > 256 ||
        typeof capture.recipient.physicalMessageId !== 'string' ||
        !capture.recipient.physicalMessageId ||
        capture.recipient.physicalMessageId.length > 256 ||
        !/^[a-f0-9]{64}$/.test(capture.messageDigest) ||
        !capture.recipient.binding ||
        capture.recipient.commandId !== capture.recipient.physicalMessageId ||
        value.request.operation !== 'send'
      )
        throw new Error();
    }
    return value;
  } catch {
    throw new TeamOwnerError('hold');
  }
}
