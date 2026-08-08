import type { AttachmentMediaType, TaskAttachmentMeta } from '../../../contracts/taskAttachments';
import type {
  AddTaskCommentRequest,
  TaskComment,
  TaskRef,
} from '../models/TeamTaskBoardPortModels';

export interface TaskCommentWriterPort {
  addTaskComment(
    teamName: string,
    taskId: string,
    text: string,
    attachments?: TaskAttachmentMeta[],
    taskRefs?: TaskRef[]
  ): Promise<TaskComment>;
}

export interface TaskCommentAttachmentWriterPort {
  runTransaction<T>(
    teamName: string,
    taskId: string,
    operation: (transaction: TaskCommentAttachmentTransactionPort) => Promise<T>
  ): Promise<T>;
}

export interface TaskCommentAttachmentTransactionPort {
  saveAttachment(
    attachmentId: string,
    filename: string,
    mimeType: AttachmentMediaType,
    base64Data: string
  ): Promise<SavedTaskCommentAttachment>;
  markCommitted(): void;
}

export interface SavedTaskCommentAttachment {
  readonly metadata: TaskAttachmentMeta;
  finalize(): Promise<void>;
  rollback(): Promise<void>;
}

export type TaskCommentRequest = AddTaskCommentRequest;
