import { z } from 'zod';
const id = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => !/[\0\r\n]/.test(value));
const uuid = z.string().uuid();
const name = z
  .string()
  .min(1)
  .max(200)
  .refine((value) => value === value.trim());
const names = z
  .array(name)
  .max(200)
  .refine((value) => new Set(value).size === value.length);
const refs = z.array(z.strictObject({ teamName: name, taskId: id, displayId: id })).max(100);
export const groupMutationSchema = z.discriminatedUnion('operation', [
  z.strictObject({
    operation: z.literal('create'),
    id: uuid,
    name: z.string().trim().min(1).max(100),
    selectedMemberNames: names,
    excludedMemberNames: names,
    autoIncludeNewMembers: z.boolean(),
  }),
  z.strictObject({
    operation: z.literal('create.agent'),
    sourceMessageId: id,
    name: z.string().trim().min(1).max(100),
    selectedMemberNames: names,
    autoIncludeNewMembers: z.boolean().optional(),
  }),
  z.strictObject({ operation: z.literal('archive'), groupChatId: uuid, archived: z.boolean() }),
  z.strictObject({
    operation: z.literal('send'),
    groupChatId: uuid,
    messageId: uuid,
    recipientName: name.optional(),
    text: z
      .string()
      .min(1)
      .max(100_000)
      .refine((value) => !!value.trim()),
    summary: z.string().max(1_000).optional(),
    taskRefs: refs.optional(),
    relayOfMessageId: id.optional(),
  }),
  z.strictObject({
    operation: z.literal('reaction.set'),
    groupChatId: uuid,
    messageId: uuid,
    active: z.boolean(),
  }),
  z.strictObject({ operation: z.literal('reaction.ack'), groupChatId: uuid, relayOfMessageId: id }),
]);
export type GroupMutation = z.infer<typeof groupMutationSchema>;

export const groupReactionTargetSchema = z.strictObject({ groupChatId: uuid, messageId: uuid });
export function parseGroupPayload(operation: string, raw: unknown) {
  if (operation === 'group.list' || operation === 'group.lookup')
    return z.strictObject({}).parse(raw);
  if (operation === 'group.reaction.read') return groupReactionTargetSchema.parse(raw);
  const selected = operation.slice('group.'.length);
  const rawPayload = z.record(z.string(), z.unknown()).parse(raw);
  if (Object.hasOwn(rawPayload, 'operation')) throw new Error('Unexpected group operation field');
  const request = groupMutationSchema.parse({
    ...rawPayload,
    operation: selected,
  });
  if (request.operation === 'create.agent' || request.operation === 'reaction.ack')
    throw new Error('Native-only group operation');
  const { operation: _operation, ...payload } = request;
  return Object.fromEntries(
    Object.entries(payload).filter(([, value]) => value !== undefined)
  ) as typeof payload;
}
