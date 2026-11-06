import { z } from 'zod';
import { retainedDeliveryCancellationSchema } from './retainedDeliverySchema.js';
import { digest } from './identity.js';
import { TeamOwnerError } from './contracts.js';
import type { TeamBinding } from './contracts.js';
import type { RetainedDeliveryCancellation } from './cancelRetainedDeliveries.js';
const id = z.string().min(1).max(256).refine(value => !value.includes('\0'));
const hash = z.string().regex(/^[a-f0-9]{64}$/);
export const queuedDiscardInput = z.object({ commandId: id, member: id, messageIds: z.array(id).max(4096) }).strict();
const receipt = z.object({ schemaVersion: z.literal(1), family: z.literal('queued-discard'), binding: z.object({ backendId: id, teamId: id, teamName: id }).strict(),
  commandId: id, principalId: id, fingerprint: hash, member: id, messageIds: z.array(id).max(4096), captureDigest: hash,
  phase: z.enum(['prepared', 'completed']), targets: z.array(retainedDeliveryCancellationSchema).max(4096),
  rows: z.array(z.object({ messageId: id, digest: hash }).strict()).max(4096),
  discardedMessageIds: z.array(id).max(4096).optional(), remainingQueued: z.number().int().min(0).optional() }).strict();
export interface QueuedDiscardReceipt {
  schemaVersion: 1; family: 'queued-discard'; binding: TeamBinding; commandId: string; principalId: string; fingerprint: string;
  member: string; messageIds: string[]; captureDigest: string; phase: 'prepared' | 'completed';
  targets: RetainedDeliveryCancellation[]; rows: { messageId: string; digest: string }[];
  discardedMessageIds?: string[]; remainingQueued?: number;
}
export function validateQueuedDiscardReceipt(raw: unknown): QueuedDiscardReceipt {
  try {
    if (Buffer.byteLength(JSON.stringify(raw)) > 32 * 1024 * 1024) throw new Error('Too large');
    const value = receipt.parse(raw);
    if (value.fingerprint !== digest({ binding: value.binding, principalId: value.principalId,
      input: { commandId: value.commandId, member: value.member, messageIds: value.messageIds } }) ||
      value.captureDigest !== digest({ rows: value.rows, intents: value.targets.map(target => target.intent) }) ||
      new Set(value.messageIds).size !== value.messageIds.length || new Set(value.rows.map(row => row.messageId)).size !== value.rows.length ||
      new Set(value.targets.map(target => target.intent.messageId)).size !== value.targets.length || value.targets.length !== value.rows.length ||
      value.rows.some(row => !value.messageIds.includes(row.messageId)) ||
      value.targets.some(target => !value.rows.some(row => row.messageId === target.intent.messageId) ||
        target.intent.binding.backendId !== value.binding.backendId || target.intent.binding.teamId !== value.binding.teamId ||
        target.intent.binding.teamName !== value.binding.teamName || target.intent.inputId !== target.intent.deliveryId) ||
      value.discardedMessageIds?.some(id => !value.rows.some(row => row.messageId === id)) ||
      (value.phase === 'completed' && (!value.discardedMessageIds || value.remainingQueued === undefined))) throw new Error('Wrong original scope');
    return value as QueuedDiscardReceipt;
  } catch { throw new TeamOwnerError('hold'); }
}
