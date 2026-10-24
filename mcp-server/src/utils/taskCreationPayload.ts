import { z } from 'zod';

import type { getController } from '../controller';
import { taskRefSchema } from './schemas';
import { assertConfiguredTaskActor } from './teamConfig';

export function resolveTaskCreationActor(params: {
  teamName: string;
  claudeDir?: string;
  createdBy?: string;
  from?: string;
}): { createdBy?: string; from?: string } {
  const explicitActor = params.createdBy?.trim();
  const fallbackActor = params.from?.trim();
  const actor = explicitActor?.length ? explicitActor : fallbackActor;
  if (!actor) {
    return {};
  }

  const validatedActor = assertConfiguredTaskActor(params.teamName, actor, params.claudeDir);
  return explicitActor ? { createdBy: validatedActor } : { from: validatedActor };
}

/**
 * Shared payload builder for task_create and task_create_from_message.
 *
 * Both tools MUST stay semantically aligned — any new field added to task_create
 * that also applies to message-derived tasks must be added here, not duplicated.
 * Do not turn this into a repo-wide abstraction; keep it local to MCP tools.
 */
export function buildCreateTaskPayload(params: {
  subject: string;
  description?: string;
  groupChatId?: string;
  owner?: string;
  createdBy?: string;
  from?: string;
  blockedBy?: string[];
  related?: string[];
  prompt?: string;
  descriptionTaskRefs?: z.infer<typeof taskRefSchema>[];
  promptTaskRefs?: z.infer<typeof taskRefSchema>[];
  startImmediately?: boolean;
  sourceMessageId?: string;
  sourceMessage?: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    subject: params.subject,
    ...(params.groupChatId !== undefined ? { groupChatId: params.groupChatId } : {}),
    ...(params.description ? { description: params.description } : {}),
    ...(params.owner ? { owner: params.owner } : {}),
    ...(params.createdBy ? { createdBy: params.createdBy } : {}),
    ...(!params.createdBy && params.from ? { from: params.from } : {}),
    ...(params.blockedBy?.length ? { 'blocked-by': params.blockedBy.join(',') } : {}),
    ...(params.related?.length ? { related: params.related.join(',') } : {}),
    ...(params.prompt ? { prompt: params.prompt } : {}),
    ...(params.descriptionTaskRefs?.length
      ? { descriptionTaskRefs: params.descriptionTaskRefs }
      : {}),
    ...(params.promptTaskRefs?.length ? { promptTaskRefs: params.promptTaskRefs } : {}),
    ...(params.startImmediately !== undefined ? { startImmediately: params.startImmediately } : {}),
    ...(params.sourceMessageId ? { sourceMessageId: params.sourceMessageId } : {}),
    ...(params.sourceMessage ? { sourceMessage: params.sourceMessage } : {}),
  };
}

export async function assertTaskGroupAssociation(params: {
  teamName: string;
  claudeDir?: string;
  groupChatId?: string;
  taskActor: { createdBy?: string; from?: string };
  controller: ReturnType<typeof getController>;
}): Promise<void> {
  if (params.groupChatId === undefined) return;
  if (!z.uuid().safeParse(params.groupChatId).success)
    throw new Error('Invalid task groupChatId: expected a group UUID');
  const actor = params.taskActor.createdBy ?? params.taskActor.from;
  if (!actor || actor.toLowerCase() === 'user')
    throw new Error(
      'Group-associated task creation requires your configured non-user createdBy/from actor'
    );
  const from = assertConfiguredTaskActor(params.teamName, actor, params.claudeDir);
  const catalog = await params.controller.groupChats.listGroupChats({ from });
  if (!Array.isArray(catalog)) throw new Error('Group chat catalog unavailable');
  const group = catalog.find(
    (entry: unknown) =>
      entry &&
      typeof entry === 'object' &&
      (entry as Record<string, unknown>).id === params.groupChatId
  ) as Record<string, unknown> | undefined;
  if (!group) throw new Error('Task groupChatId does not identify a group in this team');
  if (group.archivedAt !== null)
    throw new Error('Cannot associate a new task with an archived group');
}

/** Called only after exact-message lookup and the existing user-source provenance guard. */
export function resolveSourceGroupChatId(
  message: Record<string, unknown>,
  explicitGroupChatId?: string
): string | undefined {
  // Physical group deliveries are relay copies, never user originals.
  if (
    (message.groupChatId && message.messageId !== message.groupMessageId) ||
    (typeof message.relayOfMessageId === 'string' && message.relayOfMessageId.trim())
  ) {
    throw new Error(
      'Cannot create task from a relay copy. Use the original user_sent message and its explicit User MessageId from the relay prompt instead.'
    );
  }

  const sourceGroupChatId = message.groupChatId;
  if (sourceGroupChatId === undefined) return explicitGroupChatId;
  if (
    typeof sourceGroupChatId !== 'string' ||
    !z.uuid().safeParse(sourceGroupChatId).success ||
    message.from !== 'user' ||
    message.to !== 'user' ||
    message.groupChatProtocolVersion !== 1
  )
    throw new Error('Invalid original user group message');
  if (explicitGroupChatId !== undefined && explicitGroupChatId !== sourceGroupChatId)
    throw new Error('groupChatId must agree with the original user message');
  return sourceGroupChatId;
}
