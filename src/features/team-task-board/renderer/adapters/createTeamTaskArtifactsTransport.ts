import { api } from '@renderer/api';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import type { TeamTaskArtifactsTransport } from './createTeamTaskArtifactsRendererSlice';

export function createTeamTaskArtifactsTransport(): TeamTaskArtifactsTransport {
  return {
    addTaskComment: (teamName, taskId, request) =>
      unwrapIpc('team:addTaskComment', () => api.teams.addTaskComment(teamName, taskId, request)),
    deleteTaskAttachment: (teamName, taskId, attachmentId, mimeType) =>
      unwrapIpc('team:deleteTaskAttachment', () =>
        api.teams.deleteTaskAttachment(teamName, taskId, attachmentId, mimeType)
      ),
    getTaskAttachmentData: (teamName, taskId, attachmentId, mimeType) =>
      unwrapIpc('team:getTaskAttachment', () =>
        api.teams.getTaskAttachment(teamName, taskId, attachmentId, mimeType)
      ),
    getTaskChangePresence: (teamName) =>
      unwrapIpc('team:getTaskChangePresence', () => api.teams.getTaskChangePresence(teamName)),
    saveTaskAttachment: (teamName, taskId, attachmentId, filename, mimeType, base64) =>
      unwrapIpc('team:saveTaskAttachment', () =>
        api.teams.saveTaskAttachment(teamName, taskId, attachmentId, filename, mimeType, base64)
      ),
  };
}
