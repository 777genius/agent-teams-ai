import type { InlineChip } from '@shared/types/inlineChip';

export interface TaskDetailIdentity {
  contextId: string;
  teamName: string;
  taskId: string;
}

export type TaskDetailReadPhase =
  | 'hydrating'
  | 'ready'
  | 'missing'
  | 'deleted'
  | 'provisioning'
  | 'unavailable';

export type TaskDetailEditPart =
  | 'commentText'
  | 'commentChips'
  | 'pendingAttachments'
  | 'reply'
  | 'subject'
  | 'description';

export type TaskDetailSubmitPart = Extract<
  TaskDetailEditPart,
  'commentText' | 'commentChips' | 'pendingAttachments' | 'reply'
>;

export type TaskDetailSavePart = Extract<TaskDetailEditPart, 'subject' | 'description'>;

export type TaskDetailPartRevisions = Record<TaskDetailEditPart, number>;
export type TaskDetailSaveRevision = Partial<Record<TaskDetailSavePart, number>>;

export interface TaskDetailReplyDraft {
  taskId: string;
  author: string;
  text: string;
}

export interface PendingAttachment {
  id: string;
  filename: string;
  mimeType: string;
  base64Data: string;
  previewUrl: string;
  size: number;
}

export interface TaskDetailSession {
  commentText: string;
  commentChips: InlineChip[];
  pendingAttachments: PendingAttachment[];
  reply: TaskDetailReplyDraft | null;
  subjectDraft: string;
  descriptionDraft: string;
  editingSubject: boolean;
  editingDescription: boolean;
  editRevision: number;
  partRevisions: TaskDetailPartRevisions;
  submitRevision: number;
  submittedPartRevisions: Partial<Record<TaskDetailSubmitPart, number>> | null;
  saveRevisionByPart: Record<TaskDetailSavePart, number>;
  savedPartRevisionByPart: Record<TaskDetailSavePart, number | null>;
  ownerSurfaceId: string | null;
  ownerRevision: number;
  submitPending: boolean;
  submitError: string | null;
  saveErrorByPart: Record<TaskDetailSavePart, string | null>;
  pendingAttachmentPreparationIds: string[];
}

export interface OpenTaskDetailTabResult {
  tabId: string;
  paneId: string;
  created: boolean;
}
