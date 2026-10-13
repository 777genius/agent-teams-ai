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
  submitRevision: number;
  inlineEditOwnerSurfaceId: string | null;
}

export interface OpenTaskDetailTabResult {
  tabId: string;
  paneId: string;
  created: boolean;
}
