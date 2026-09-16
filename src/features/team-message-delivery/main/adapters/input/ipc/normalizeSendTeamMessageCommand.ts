import { validateFromField, validateMemberName, validateTeamName } from '@main/ipc/guards';
import { validateTaskRefs } from '@main/ipc/validation/taskRefs';

import {
  validateAttachments,
  validateAttachmentSerializedPayload,
} from '../../../../core/domain/attachmentPayloadPolicy';

import type { SendTeamMessageCommand } from '../../../../core/application/SendTeamMessageCommand';
import type { SendMessageRequest } from '@shared/types';

export type NormalizeSendTeamMessageResult =
  | { valid: true; value: SendTeamMessageCommand }
  | { valid: false; error: string };

export function normalizeSendTeamMessageCommand(
  teamName: unknown,
  request: unknown
): NormalizeSendTeamMessageResult {
  const validatedTeamName = validateTeamName(teamName);
  if (!validatedTeamName.valid) {
    return { valid: false, error: validatedTeamName.error ?? 'Invalid teamName' };
  }
  if (!request || typeof request !== 'object') {
    return { valid: false, error: 'Invalid send message request' };
  }
  const payload = request as Partial<SendMessageRequest>;
  const validatedMember = validateMemberName(payload.member);
  if (!validatedMember.valid) {
    return { valid: false, error: validatedMember.error ?? 'Invalid member' };
  }
  if (typeof payload.text !== 'string' || payload.text.trim().length === 0) {
    return { valid: false, error: 'text must be non-empty string' };
  }
  if (payload.summary !== undefined && typeof payload.summary !== 'string') {
    return { valid: false, error: 'summary must be string' };
  }
  if (payload.from !== undefined) {
    const validatedFrom = validateFromField(payload.from);
    if (!validatedFrom.valid) {
      return { valid: false, error: validatedFrom.error ?? 'Invalid from' };
    }
  }
  if (payload.actionMode !== undefined && !isAgentActionMode(payload.actionMode)) {
    return { valid: false, error: 'actionMode must be one of: do, ask, delegate' };
  }
  const validatedTaskRefs = validateTaskRefs(payload.taskRefs);
  if (!validatedTaskRefs.valid) {
    return { valid: false, error: validatedTaskRefs.error };
  }

  let attachments;
  if (
    payload.attachments !== undefined &&
    Array.isArray(payload.attachments) &&
    payload.attachments.length > 0
  ) {
    const validated = validateAttachments(payload.attachments);
    if (!validated.valid) return validated;
    attachments = validated.value;
    const serialized = validateAttachmentSerializedPayload({
      text: payload.text,
      attachments,
    });
    if (!serialized.valid) return serialized;
  }

  return {
    valid: true,
    value: {
      teamName: validatedTeamName.value!,
      memberName: validatedMember.value!,
      text: payload.text,
      summary: payload.summary,
      from: payload.from,
      actionMode: payload.actionMode,
      taskRefs: validatedTaskRefs.value,
      attachments,
    },
  };
}

function isAgentActionMode(value: unknown): value is SendTeamMessageCommand['actionMode'] {
  return value === 'do' || value === 'ask' || value === 'delegate';
}
