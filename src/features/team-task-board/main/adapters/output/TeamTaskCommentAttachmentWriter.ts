import { TeamTaskAttachmentStore } from '@main/services/team/TeamTaskAttachmentStore';

import type {
  SavedTaskCommentAttachment,
  TaskCommentAttachmentWriterPort,
} from '../../../core/application/ports/TeamTaskBoardPorts';
import type { AttachmentMediaType } from '@shared/types';

export class TeamTaskCommentAttachmentWriter implements TaskCommentAttachmentWriterPort {
  constructor(private readonly store: TeamTaskAttachmentStore = new TeamTaskAttachmentStore()) {}

  async saveAttachment(
    teamName: string,
    taskId: string,
    attachmentId: string,
    filename: string,
    mimeType: AttachmentMediaType,
    base64Data: string
  ): Promise<SavedTaskCommentAttachment> {
    const receipt = await this.store.saveAttachmentWithReceipt(
      teamName,
      taskId,
      attachmentId,
      filename,
      mimeType,
      base64Data
    );
    return {
      metadata: receipt.metadata,
      rollback: () => this.store.rollbackAttachment(receipt),
    };
  }
}
