import { validateTaskId, validateTeamName } from '@main/ipc/guards';
import { validateTaskRefs } from '@main/ipc/validation/taskRefs';
import { MAX_TEXT_LENGTH } from '@shared/constants/teamLimits';

import {
  estimateTaskAttachmentDecodedBytes,
  TEAM_TASK_ATTACHMENT_MAX_BASE64_LENGTH,
  TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES,
} from '../../../../core/domain/taskAttachmentPayloadPolicy';

import { executeTeamTaskBoardHandler } from './executeTeamTaskBoardHandler';
import { isValidStoredAttachmentMimeType } from './teamTaskBoardValidation';

import type { TaskCommentRequest } from '../../../../core/application/ports/TeamTaskBoardPorts';
import type { AddTaskCommentAttachmentInput } from '../../../../core/application/use-cases/AddTaskCommentUseCase';
import type { TeamTaskBoardIpcDependencies } from './TeamTaskBoardIpcDependencies';
import type { IpcResult, TaskComment } from '@shared/types';
import type { IpcMainInvokeEvent } from 'electron';

const MAX_ATTACHMENTS = 5;

function normalizeAttachment(attachment: unknown): AddTaskCommentAttachmentInput {
  if (!attachment || typeof attachment !== 'object') {
    throw new Error('Invalid attachment data');
  }
  const candidate = attachment as Record<string, unknown>;
  if (
    typeof candidate.id !== 'string' ||
    typeof candidate.filename !== 'string' ||
    !isValidStoredAttachmentMimeType(candidate.mimeType) ||
    typeof candidate.base64Data !== 'string'
  ) {
    throw new Error('Invalid attachment data');
  }

  const id = candidate.id.trim();
  const base64Data = candidate.base64Data.trim();
  if (
    id.length === 0 ||
    id.includes('/') ||
    id.includes('\\') ||
    id.includes('..') ||
    id.includes('\0')
  ) {
    throw new Error('Invalid attachment ID');
  }
  if (base64Data.length === 0) {
    throw new Error('Invalid attachment data');
  }
  if (
    base64Data.length > TEAM_TASK_ATTACHMENT_MAX_BASE64_LENGTH ||
    estimateTaskAttachmentDecodedBytes(base64Data) > TEAM_TASK_ATTACHMENT_MAX_DECODED_BYTES
  ) {
    throw new Error('Attachment payload exceeds the 20 MiB decoded size limit');
  }

  return {
    id,
    filename: candidate.filename,
    mimeType: candidate.mimeType.trim(),
    base64Data,
  };
}

export function createTeamTaskBoardCommentHandlers(dependencies: TeamTaskBoardIpcDependencies): {
  addTaskComment(
    event: IpcMainInvokeEvent,
    teamName: unknown,
    taskId: unknown,
    request: unknown
  ): Promise<IpcResult<TaskComment>>;
} {
  return {
    async addTaskComment(_event, teamName, taskId, request) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedTaskId = validateTaskId(taskId);
      if (!validatedTaskId.valid) {
        return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
      }
      if (!request || typeof request !== 'object') {
        return { success: false, error: 'Invalid add task comment request' };
      }
      const payload = request as Partial<TaskCommentRequest>;
      const text = payload.text;
      if (typeof text !== 'string' || text.trim().length === 0) {
        return { success: false, error: 'Comment text must be non-empty' };
      }
      if (text.trim().length > MAX_TEXT_LENGTH) {
        return { success: false, error: `Comment exceeds ${MAX_TEXT_LENGTH} characters` };
      }
      const validatedTaskRefs = validateTaskRefs(payload.taskRefs);
      if (!validatedTaskRefs.valid) {
        return { success: false, error: validatedTaskRefs.error };
      }

      const rawAttachments = Array.isArray(payload.attachments) ? payload.attachments : [];
      if (rawAttachments.length > MAX_ATTACHMENTS) {
        return { success: false, error: `Maximum ${MAX_ATTACHMENTS} attachments per comment` };
      }

      return executeTeamTaskBoardHandler(dependencies.logger, 'addTaskComment', async () => {
        const attachments = rawAttachments.map(normalizeAttachment);
        return dependencies.addTaskComment.execute(
          validatedTeamName.value!,
          validatedTaskId.value!,
          {
            text: text.trim(),
            attachments,
            taskRefs: validatedTaskRefs.value,
          }
        );
      });
    },
  };
}
