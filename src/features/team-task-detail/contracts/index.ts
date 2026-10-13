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

export interface TaskDetailReplyDraft {
  taskId: string;
  author: string;
  text: string;
}

export interface TaskDetailSession {
  commentText: string;
  commentChips: string[];
  pendingAttachments: unknown[];
  reply: TaskDetailReplyDraft | null;
  subjectDraft: string;
  descriptionDraft: string;
  editingSubject: boolean;
  editingDescription: boolean;
  editRevision: number;
  partRevisions: TaskDetailPartRevisions;
  submitRevision: number;
  submittedPartRevisions: Partial<Record<TaskDetailSubmitPart, number>> | null;
  saveRevision: number;
  savedPartRevisions: Partial<Record<TaskDetailSavePart, number>> | null;
  inlineEditOwnerSurfaceId: string | null;
  ownerSurfaceId: string | null;
  ownerRevision: number;
}

export interface OpenTaskDetailTabResult {
  tabId: string;
  paneId: string;
  created: boolean;
}
