import { TeamTaskAttachmentStore } from '@main/services/team/TeamTaskAttachmentStore';

import type {
  TaskCommentAttachmentCleanupPort,
  TaskCommentAttachmentWriterPort,
} from '../../../core/application/ports/TeamTaskBoardPorts';
import type { AttachmentMediaType, TaskAttachmentMeta } from '@shared/types';

export class TeamTaskCommentAttachmentWriter
  implements TaskCommentAttachmentWriterPort, TaskCommentAttachmentCleanupPort
{
  constructor(private readonly store: TeamTaskAttachmentStore = new TeamTaskAttachmentStore()) {}

  saveAttachment(
    teamName: string,
    taskId: string,
    attachmentId: string,
    filename: string,
    mimeType: AttachmentMediaType,
    base64Data: string
  ): Promise<TaskAttachmentMeta> {
    return this.store.saveAttachment(
      teamName,
      taskId,
      attachmentId,
      filename,
      mimeType,
      base64Data
    );
  }

  deleteAttachment(
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: AttachmentMediaType
  ): Promise<void> {
    return this.store.deleteAttachment(teamName, taskId, attachmentId, mimeType);
  }
}
