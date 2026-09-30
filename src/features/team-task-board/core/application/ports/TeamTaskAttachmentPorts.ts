import type { AttachmentMediaType, TaskAttachmentMeta } from '../../../contracts/taskAttachments';

export interface TaskAttachmentMetadataPort {
  addTaskAttachment(teamName: string, taskId: string, metadata: TaskAttachmentMeta): Promise<void>;
  removeTaskAttachment(teamName: string, taskId: string, attachmentId: string): Promise<void>;
}

export interface TaskAttachmentStoragePort {
  runTransaction<T>(
    teamName: string,
    taskId: string,
    operation: (transaction: TaskAttachmentStorageTransactionPort) => Promise<T>
  ): Promise<T>;
  getAttachment(
    teamName: string,
    taskId: string,
    attachmentId: string,
    mimeType: AttachmentMediaType
  ): Promise<string | null>;
}

export interface TaskAttachmentStorageTransactionPort {
  saveAttachment(
    attachmentId: string,
    filename: string,
    mimeType: AttachmentMediaType,
    base64Data: string
  ): Promise<SavedTaskAttachment>;
  prepareAttachmentDeletion(
    attachmentId: string,
    mimeType: AttachmentMediaType
  ): Promise<PreparedTaskAttachmentDeletion | null>;
  markCommitted(): void;
}

export interface SavedTaskAttachment {
  readonly metadata: TaskAttachmentMeta;
  finalize(): Promise<void>;
  rollback(): Promise<void>;
}

export interface PreparedTaskAttachmentDeletion {
  finalize(): Promise<void>;
  rollback(): Promise<void>;
}
