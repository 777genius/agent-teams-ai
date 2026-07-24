import { validateTaskId, validateTeamName } from '@main/ipc/guards';
import { validateTaskRefs } from '@main/ipc/validation/taskRefs';
import { MAX_TEXT_LENGTH } from '@shared/constants/teamLimits';

import { executeTeamTaskBoardHandler } from './executeTeamTaskBoardHandler';
import { isValidStoredAttachmentMimeType } from './teamTaskBoardValidation';

import type { TaskCommentRequest } from '../../../../core/application/ports/TeamTaskBoardPorts';
import type { TeamTaskBoardIpcDependencies } from './TeamTaskBoardIpcDependencies';
import type { IpcResult, TaskAttachmentMeta, TaskComment } from '@shared/types';
import type { IpcMainInvokeEvent } from 'electron';

const MAX_ATTACHMENTS = 5;

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
        let savedAttachments: TaskAttachmentMeta[] | undefined;
        if (rawAttachments.length > 0) {
          savedAttachments = [];
          for (const attachment of rawAttachments) {
            if (!attachment || typeof attachment !== 'object') {
              throw new Error('Invalid attachment data');
            }
            const candidate = attachment as unknown as Record<string, unknown>;
            if (
              typeof candidate.id !== 'string' ||
              typeof candidate.filename !== 'string' ||
              !isValidStoredAttachmentMimeType(candidate.mimeType) ||
              typeof candidate.base64Data !== 'string' ||
              candidate.base64Data.length === 0
            ) {
              throw new Error('Invalid attachment data');
            }
            const safeId = candidate.id.trim();
            if (safeId.includes('/') || safeId.includes('\\') || safeId.includes('..')) {
              throw new Error('Invalid attachment ID');
            }
            const metadata = await dependencies.commentAttachments.saveAttachment(
              validatedTeamName.value!,
              validatedTaskId.value!,
              safeId,
              candidate.filename,
              candidate.mimeType.trim(),
              candidate.base64Data
            );
            savedAttachments.push(metadata);
          }
        }

        return dependencies.comments.addTaskComment(
          validatedTeamName.value!,
          validatedTaskId.value!,
          text.trim(),
          savedAttachments,
          validatedTaskRefs.value
        );
      });
    },
  };
}
