import type { AttachmentMediaType, TaskAttachmentMeta } from '../../../contracts/taskAttachments';
import type {
  SavedTaskAttachment,
  TaskAttachmentMetadataPort,
  TaskAttachmentStoragePort,
  TeamTaskBoardLoggerPort,
} from '../ports/TeamTaskBoardPorts';

export interface TaskAttachmentOperationsPort {
  save(
    teamName: string,
    taskId: string,
    attachmentId: string,
    filename: string,
    mimeType: AttachmentMediaType,
    base64Data: string
  ): Promise<TaskAttachmentMeta>;
  get(
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: AttachmentMediaType
  ): Promise<string | null>;
  delete(
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: AttachmentMediaType
  ): Promise<void>;
}

export class TaskAttachmentUseCases implements TaskAttachmentOperationsPort {
  constructor(
    private readonly dependencies: {
      metadata: TaskAttachmentMetadataPort;
      storage: TaskAttachmentStoragePort;
      logger: Pick<TeamTaskBoardLoggerPort, 'warn'>;
    }
  ) {}

  save(
    teamName: string,
    taskId: string,
    attachmentId: string,
    filename: string,
    mimeType: AttachmentMediaType,
    base64Data: string
  ): Promise<TaskAttachmentMeta> {
    return this.dependencies.storage.runTransaction(teamName, taskId, async (transaction) => {
      const attachment = await transaction.saveAttachment(
        attachmentId,
        filename,
        mimeType,
        base64Data
      );
      try {
        await this.dependencies.metadata.addTaskAttachment(teamName, taskId, attachment.metadata);
        transaction.markCommitted();
      } catch (error) {
        await this.rollbackAttachment(attachment, attachmentId);
        throw error;
      }

      try {
        await attachment.finalize();
      } catch (error) {
        this.dependencies.logger.warn(
          `[teams:saveTaskAttachment] Failed to finalize attachment ${attachmentId}: ${
            error instanceof Error ? error.message : String(error)
          }`
        );
      }
      return attachment.metadata;
    });
  }

  private async rollbackAttachment(
    attachment: SavedTaskAttachment,
    attachmentId: string
  ): Promise<void> {
    try {
      await attachment.rollback();
    } catch (rollbackError) {
      this.dependencies.logger.warn(
        `[teams:saveTaskAttachment] Failed to roll back attachment ${attachmentId}: ${
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        }`
      );
    }
  }

  get(
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: AttachmentMediaType
  ): Promise<string | null> {
    return this.dependencies.storage.getAttachment(teamName, taskId, attachmentId, mimeType);
  }

  delete(
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: AttachmentMediaType
  ): Promise<void> {
    return this.dependencies.storage.runTransaction(teamName, taskId, async (transaction) => {
      const attachment = await transaction.prepareAttachmentDeletion(attachmentId, mimeType);
      try {
        await this.dependencies.metadata.removeTaskAttachment(teamName, taskId, attachmentId);
      } catch (error) {
        if (attachment) {
          try {
            await attachment.rollback();
          } catch (rollbackError) {
            this.dependencies.logger.warn(
              `[teams:deleteTaskAttachment] Failed to restore attachment ${attachmentId}: ${
                rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
              }`
            );
          }
        }
        throw error;
      }
      transaction.markCommitted();
      await attachment?.finalize();
    });
  }
}
