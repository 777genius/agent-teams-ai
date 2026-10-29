import { z } from 'zod';
import type {
  TeamGroupChatDTO,
  GroupMessageReactionDTO,
  GroupChatSendResult,
  GroupChatReactionResult,
} from './contracts.js';
const name = z.string().min(1).max(200);
const uuid = z.string().uuid();
const names = z
  .array(name)
  .max(256)
  .refine((rows) => new Set(rows).size === rows.length);
const membership = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('fixed'), memberNames: names }),
  z.object({ kind: z.literal('auto'), excludedMemberNames: names }),
]);
const group = z.object({
  id: uuid,
  name: z.string().min(1).max(100),
  createdAt: name,
  membership,
  archivedAt: name.nullable(),
  memberNames: names,
  availableRecipientNames: names,
  canSend: z.boolean(),
  reason: z.string().max(4096).optional(),
});
const reaction = z.object({
  groupChatId: uuid,
  messageId: uuid,
  actorNames: z
    .array(name)
    .max(257)
    .refine((rows) => new Set(rows).size === rows.length),
  hasUserReacted: z.boolean(),
  canReact: z.boolean(),
});
const sent = z.object({
  saved: z.literal(true),
  groupChatId: uuid,
  messageId: uuid,
  statusPersisted: z.boolean(),
  deliverySummary: z
    .object({
      recordedAt: name,
      recipients: z
        .array(
          z.object({
            memberName: name,
            physicalMessageId: z.string().min(1).max(256),
            status: z.enum(['queued', 'accepted', 'failed', 'unknown', 'skipped']),
            reason: z.string().max(4096).optional(),
          })
        )
        .max(256),
    })
    .optional(),
});
const ack = z.object({
  saved: z.literal(true),
  acknowledged: z.literal(true),
  teamName: name,
  groupChatId: uuid,
  messageId: uuid,
  relayOfMessageId: z.string().min(1).max(256),
  from: name,
  groupRunKey: z.string().min(1).max(500),
});
export type GroupProductResult =
  | TeamGroupChatDTO
  | GroupMessageReactionDTO
  | GroupChatSendResult
  | GroupChatReactionResult;
export interface GroupCommandView {
  kind: 'group-chat-command';
  commandId: string;
  phase: 'absent' | 'prepared' | 'held' | 'completed';
  operation?: string;
  result?: GroupProductResult;
}
export function readGroupList(raw: unknown): TeamGroupChatDTO[] {
  return z.array(group).max(10000).parse(raw) as TeamGroupChatDTO[];
}
export function readGroupReaction(raw: unknown): GroupMessageReactionDTO {
  return reaction.parse(raw);
}
/** Project only group product data; receipts, private runtime bindings and source proofs never escape. */
export function readGroupCommand(raw: unknown, commandId: string): GroupCommandView {
  const header = z
    .object({
      kind: z.literal('group-chat-command'),
      commandId: z.literal(commandId),
      phase: z.enum(['absent', 'prepared', 'held', 'completed']),
      operation: z
        .enum(['create', 'create.agent', 'archive', 'send', 'reaction.set', 'reaction.ack'])
        .optional(),
      result: z.unknown().optional(),
    })
    .parse(raw);
  if (header.phase === 'absent') {
    if (header.operation !== undefined || header.result !== undefined)
      throw new Error('Invalid absent group receipt');
    return { kind: header.kind, commandId, phase: header.phase };
  }
  if (!header.operation) throw new Error('Missing group operation');
  const projected: GroupCommandView = {
    kind: header.kind,
    commandId,
    phase: header.phase,
    operation: header.operation,
  };
  if (header.phase === 'completed') {
    const schema =
      header.operation === 'send'
        ? sent
        : header.operation === 'reaction.set'
          ? reaction
          : header.operation === 'reaction.ack'
            ? ack
            : group;
    projected.result = schema.parse(header.result) as GroupProductResult;
  } else if (header.result !== undefined) throw new Error('Uncompleted group result');
  return projected;
}
