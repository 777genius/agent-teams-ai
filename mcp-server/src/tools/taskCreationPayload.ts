import { z } from 'zod';

import { assertConfiguredTaskActor } from '../utils/teamConfig';
import { taskRefSchema } from '../utils/schemas';

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
