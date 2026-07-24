import { TeamTaskAttachmentStore } from '@main/services/team/TeamTaskAttachmentStore';

import type { TaskCommentAttachmentWriterPort } from '../../../core/application/ports/TeamTaskBoardPorts';
import type { AttachmentMediaType, TaskAttachmentMeta } from '@shared/types';

export class TeamTaskCommentAttachmentWriter implements TaskCommentAttachmentWriterPort {
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
}
