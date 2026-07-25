import type {
  TaskCommentAttachmentCleanupPort,
  TaskCommentAttachmentWriterPort,
  TaskCommentWriterPort,
  TeamTaskBoardLoggerPort,
} from '../ports/TeamTaskBoardPorts';
import type { AttachmentMediaType, TaskAttachmentMeta, TaskComment, TaskRef } from '@shared/types';

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
      attachmentCleanup: TaskCommentAttachmentCleanupPort;
      logger: Pick<TeamTaskBoardLoggerPort, 'warn'>;
    }
  ) {}

  async execute(
    teamName: string,
    taskId: string,
    input: AddTaskCommentInput
  ): Promise<TaskComment> {
    const savedAttachments: TaskAttachmentMeta[] = [];
    try {
      for (const attachment of input.attachments) {
        const metadata = await this.dependencies.attachments.saveAttachment(
          teamName,
          taskId,
          attachment.id,
          attachment.filename,
          attachment.mimeType,
          attachment.base64Data
        );
        savedAttachments.push(metadata);
      }

      return await this.dependencies.comments.addTaskComment(
        teamName,
        taskId,
        input.text,
        savedAttachments.length > 0 ? savedAttachments : undefined,
        input.taskRefs
      );
    } catch (error) {
      await this.rollbackSavedAttachments(teamName, taskId, savedAttachments);
      throw error;
    }
  }

  private async rollbackSavedAttachments(
    teamName: string,
    taskId: string,
    attachments: readonly TaskAttachmentMeta[]
  ): Promise<void> {
    for (const attachment of [...attachments].reverse()) {
      try {
        await this.dependencies.attachmentCleanup.deleteAttachment(
          teamName,
          taskId,
          attachment.id,
          attachment.mimeType
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.dependencies.logger.warn(
          `[teams:addTaskComment] Failed to roll back attachment ${attachment.id}: ${message}`
        );
      }
    }
  }
}
