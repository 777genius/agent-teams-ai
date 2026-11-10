import { z } from 'zod';
import { defineTool as define } from './toolDefinition.js';
import { groupMutationSchema } from '../group-chats/operations.js';
import type { BoundTool } from './toolDefinition.js';
import type { GroupMutation } from '../group-chats/operations.js';
export interface TeamMcpGroupPort {
  list(): Promise<unknown>;
  execute(commandId: string, request: GroupMutation): Promise<unknown>;
  lookup(commandId: string): unknown;
}
const commandId = z.string().min(1).max(256);
/** Existing group behavior only. Every effect binds the actual native input in composition. */
export function createGroupMcpTools(port: TeamMcpGroupPort | undefined): BoundTool[] {
  if (!port) return [];
  return [
    define(
      'group_chat_list',
      'List the authenticated Team group chats and current recipients.',
      z.strictObject({}),
      () => port.list(),
      false
    ),
    define(
      'group_chat_create',
      'Create a group from the exact original human sourceMessageId; Team validates recipients and source authority.',
      groupMutationSchema.options[1].omit({ operation: true }).extend({ commandId }),
      ({ commandId, ...payload }) =>
        port.execute(
          commandId,
          groupMutationSchema.parse({ ...payload, operation: 'create.agent' })
        )
    ),
    define(
      'group_chat_send',
      'Post a logical group message. Relay the current physical inbound with relayOfMessageId. Retain commandId when looking up; use a fresh UUID messageId for a distinct post.',
      groupMutationSchema.options[3].omit({ operation: true }).extend({ commandId }),
      ({ commandId, ...payload }) =>
        port.execute(commandId, groupMutationSchema.parse({ ...payload, operation: 'send' }))
    ),
    define(
      'group_chat_react',
      'Acknowledge the exact current physical inbound with relayOfMessageId. Logical IDs and human reactions are not agent consumption proof.',
      groupMutationSchema.options[5].omit({ operation: true }).extend({ commandId }),
      ({ commandId, ...payload }) =>
        port.execute(
          commandId,
          groupMutationSchema.parse({ ...payload, operation: 'reaction.ack' })
        )
    ),
    define(
      'group_chat_lookup',
      'Read the original group command receipt without repeating its effects.',
      z.strictObject({ commandId }),
      ({ commandId }) => port.lookup(commandId),
      false
    ),
  ].map((tool) =>
    tool.definition.name === 'group_chat_lookup' ? tool : { ...tool, asynchronous: true as const }
  );
}
