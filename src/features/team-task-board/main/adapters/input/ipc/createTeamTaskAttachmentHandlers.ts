import { validateTaskId, validateTeamName } from '@main/ipc/guards';

import { executeTeamTaskBoardHandler } from './executeTeamTaskBoardHandler';
import { isValidStoredAttachmentMimeType } from './teamTaskBoardValidation';

import type { TeamTaskBoardIpcEvent } from '../../../composition/TeamTaskBoardIpcBoundary';
import type { TeamTaskBoardIpcDependencies } from './TeamTaskBoardIpcDependencies';
import type { IpcResult, TaskAttachmentMeta } from '@shared/types';

function validateAttachmentId(
  value: unknown
): { valid: true; value: string } | { valid: false; error: string } {
  if (typeof value !== 'string' || value.trim().length === 0) {
    return { valid: false, error: 'attachmentId must be a non-empty string' };
  }
  const attachmentId = value.trim();
  if (attachmentId.includes('/') || attachmentId.includes('\\') || attachmentId.includes('..')) {
    return { valid: false, error: 'Invalid attachmentId' };
  }
  return { valid: true, value: attachmentId };
}

export function createTeamTaskAttachmentHandlers(dependencies: TeamTaskBoardIpcDependencies): {
  save(
    event: TeamTaskBoardIpcEvent,
    teamName: unknown,
    taskId: unknown,
    attachmentId: unknown,
    filename: unknown,
    mimeType: unknown,
    base64Data: unknown
  ): Promise<IpcResult<TaskAttachmentMeta>>;
  get(
    event: TeamTaskBoardIpcEvent,
    teamName: unknown,
    taskId: unknown,
    attachmentId: unknown,
    mimeType: unknown
  ): Promise<IpcResult<string | null>>;
  delete(
    event: TeamTaskBoardIpcEvent,
    teamName: unknown,
    taskId: unknown,
    attachmentId: unknown,
    mimeType: unknown
  ): Promise<IpcResult<void>>;
} {
  return {
    async save(_event, teamName, taskId, attachmentId, filename, mimeType, base64Data) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedTaskId = validateTaskId(taskId);
      if (!validatedTaskId.valid) {
        return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
      }
      if (typeof attachmentId !== 'string' || attachmentId.trim().length === 0) {
        return { success: false, error: 'attachmentId must be a non-empty string' };
      }
      if (typeof filename !== 'string' || filename.trim().length === 0) {
        return { success: false, error: 'filename must be a non-empty string' };
      }
      if (!isValidStoredAttachmentMimeType(mimeType)) {
        return { success: false, error: 'Invalid mimeType' };
      }
      if (typeof base64Data !== 'string' || base64Data.length === 0) {
        return { success: false, error: 'base64Data must be a non-empty string' };
      }
      const validatedAttachmentId = validateAttachmentId(attachmentId);
      if (!validatedAttachmentId.valid) {
        return { success: false, error: validatedAttachmentId.error };
      }

      return executeTeamTaskBoardHandler(
        dependencies.taskAttachmentLogger,
        'saveTaskAttachment',
        () =>
          dependencies.taskAttachments.save(
            validatedTeamName.value!,
            validatedTaskId.value!,
            validatedAttachmentId.value,
            filename,
            mimeType.trim(),
            base64Data
          )
      );
    },

    async get(_event, teamName, taskId, attachmentId, mimeType) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedTaskId = validateTaskId(taskId);
      if (!validatedTaskId.valid) {
        return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
      }
      if (typeof attachmentId !== 'string' || attachmentId.trim().length === 0) {
        return { success: false, error: 'attachmentId must be a non-empty string' };
      }
      if (!isValidStoredAttachmentMimeType(mimeType)) {
        return { success: false, error: 'Invalid mimeType' };
      }
      const validatedAttachmentId = validateAttachmentId(attachmentId);
      if (!validatedAttachmentId.valid) {
        return { success: false, error: validatedAttachmentId.error };
      }

      return executeTeamTaskBoardHandler(
        dependencies.taskAttachmentLogger,
        'getTaskAttachment',
        () =>
          dependencies.taskAttachments.get(
            validatedTeamName.value!,
            validatedTaskId.value!,
            validatedAttachmentId.value,
            mimeType.trim()
          )
      );
    },

    async delete(_event, teamName, taskId, attachmentId, mimeType) {
      const validatedTeamName = validateTeamName(teamName);
      if (!validatedTeamName.valid) {
        return { success: false, error: validatedTeamName.error ?? 'Invalid teamName' };
      }
      const validatedTaskId = validateTaskId(taskId);
      if (!validatedTaskId.valid) {
        return { success: false, error: validatedTaskId.error ?? 'Invalid taskId' };
      }
      if (typeof attachmentId !== 'string' || attachmentId.trim().length === 0) {
        return { success: false, error: 'attachmentId must be a non-empty string' };
      }
      if (!isValidStoredAttachmentMimeType(mimeType)) {
        return { success: false, error: 'Invalid mimeType' };
      }
      const validatedAttachmentId = validateAttachmentId(attachmentId);
      if (!validatedAttachmentId.valid) {
        return { success: false, error: validatedAttachmentId.error };
      }

      return executeTeamTaskBoardHandler(
        dependencies.taskAttachmentLogger,
        'deleteTaskAttachment',
        () =>
          dependencies.taskAttachments.delete(
            validatedTeamName.value!,
            validatedTaskId.value!,
            validatedAttachmentId.value,
            mimeType.trim()
          )
      );
    },
  };
}
