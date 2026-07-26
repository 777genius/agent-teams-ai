import type {
  SavedTaskCommentAttachment,
  TaskCommentAttachmentTransactionPort,
  TaskCommentAttachmentWriterPort,
  TaskCommentWriterPort,
  TeamTaskBoardLoggerPort,
} from '../ports/TeamTaskBoardPorts';
import type { AttachmentMediaType, TaskComment, TaskRef } from '@shared/types';

export interface AddTaskCommentAttachmentInput {
  id: string;
  filename: string;
  mimeType: AttachmentMediaType;
  base64Data: string;
}

export interface AddTaskCommentInput {
  text: string;
  attachments: readonly AddTaskCommentAttachmentInput[];
  taskRefs?: TaskRef[];
}

export interface AddTaskCommentPort {
  execute(teamName: string, taskId: string, input: AddTaskCommentInput): Promise<TaskComment>;
}

export class AddTaskCommentUseCase implements AddTaskCommentPort {
  constructor(
    private readonly dependencies: {
      comments: TaskCommentWriterPort;
      attachments: TaskCommentAttachmentWriterPort;
      logger: Pick<TeamTaskBoardLoggerPort, 'warn'>;
    }
  ) {}

  async execute(
    teamName: string,
    taskId: string,
    input: AddTaskCommentInput
  ): Promise<TaskComment> {
    if (input.attachments.length === 0) {
      return this.dependencies.comments.addTaskComment(
        teamName,
        taskId,
        input.text,
        undefined,
        input.taskRefs
      );
    }
    return this.dependencies.attachments.runTransaction(teamName, taskId, (transaction) =>
      this.executeAttachmentTransaction(teamName, taskId, input, transaction)
    );
  }

  private async executeAttachmentTransaction(
    teamName: string,
    taskId: string,
    input: AddTaskCommentInput,
    attachments: TaskCommentAttachmentTransactionPort
  ): Promise<TaskComment> {
    const savedAttachments: SavedTaskCommentAttachment[] = [];
    let comment: TaskComment;
    try {
      for (const attachment of input.attachments) {
        const saved = await attachments.saveAttachment(
          attachment.id,
          attachment.filename,
          attachment.mimeType,
          attachment.base64Data
        );
        savedAttachments.push(saved);
      }

      comment = await this.dependencies.comments.addTaskComment(
        teamName,
        taskId,
        input.text,
        savedAttachments.length > 0
          ? savedAttachments.map((attachment) => attachment.metadata)
          : undefined,
        input.taskRefs
      );
    } catch (error) {
      await this.rollbackSavedAttachments(savedAttachments);
      throw error;
    }

    await this.finalizeSavedAttachments(savedAttachments);
    return comment;
  }

  private async finalizeSavedAttachments(
    attachments: readonly SavedTaskCommentAttachment[]
  ): Promise<void> {
    for (const attachment of attachments) {
      try {
        await attachment.finalize();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.dependencies.logger.warn(
          `[teams:addTaskComment] Failed to finalize attachment ${attachment.metadata.id}: ${message}`
        );
      }
    }
  }

  private async rollbackSavedAttachments(
    attachments: readonly SavedTaskCommentAttachment[]
  ): Promise<void> {
    for (const attachment of [...attachments].reverse()) {
      try {
        await attachment.rollback();
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.dependencies.logger.warn(
          `[teams:addTaskComment] Failed to roll back attachment ${attachment.metadata.id}: ${message}`
        );
      }
    }
  }
}
