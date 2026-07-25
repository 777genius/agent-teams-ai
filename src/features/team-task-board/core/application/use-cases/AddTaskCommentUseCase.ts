import type {
  SavedTaskCommentAttachment,
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
    const savedAttachments: SavedTaskCommentAttachment[] = [];
    try {
      for (const attachment of input.attachments) {
        const saved = await this.dependencies.attachments.saveAttachment(
          teamName,
          taskId,
          attachment.id,
          attachment.filename,
          attachment.mimeType,
          attachment.base64Data
        );
        savedAttachments.push(saved);
      }

      return await this.dependencies.comments.addTaskComment(
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
