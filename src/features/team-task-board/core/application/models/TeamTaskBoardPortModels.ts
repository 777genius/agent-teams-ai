import type { AttachmentMediaType, TaskAttachmentMeta } from '../../../contracts/taskAttachments';

export type TeamTaskStatus = 'pending' | 'in_progress' | 'completed' | 'deleted';

export interface TaskRef {
  taskId: string;
  displayId: string;
  teamName: string;
}

export interface ApplicationCommandRequestIdentity {
  commandId: string;
  idempotencyKey: string;
}

export interface CreateTaskRequest {
  command?: ApplicationCommandRequestIdentity;
  subject: string;
  description?: string;
  descriptionTaskRefs?: TaskRef[];
  owner?: string;
  blockedBy?: string[];
  related?: string[];
  prompt?: string;
  promptTaskRefs?: TaskRef[];
  startImmediately?: boolean;
}

export type KanbanColumnId = 'todo' | 'in_progress' | 'done' | 'review' | 'approved';

export type UpdateKanbanPatch =
  | { op: 'set_column'; column: Extract<KanbanColumnId, 'review' | 'approved'> }
  | { op: 'remove' }
  | { op: 'request_changes'; comment?: string; taskRefs?: TaskRef[] };

export type TaskChangePresenceState = 'has_changes' | 'needs_attention' | 'no_changes' | 'unknown';

export interface TeamTask {
  id: string;
  subject: string;
  status: TeamTaskStatus;
}

export interface TeamTaskWithKanban extends TeamTask {
  kanbanColumn?: 'review' | 'approved';
  reviewer?: string | null;
  changePresence?: TaskChangePresenceState;
}

export interface GlobalTask extends TeamTaskWithKanban {
  teamName: string;
  teamDisplayName: string;
  projectPath?: string;
  teamDeleted?: boolean;
}

export type TaskCommentType = 'regular' | 'review_request' | 'review_approved';

export interface CommentAttachmentPayload {
  id: string;
  filename: string;
  mimeType: AttachmentMediaType;
  base64Data: string;
}

export interface TaskComment {
  id: string;
  author: string;
  text: string;
  createdAt: string;
  type: TaskCommentType;
  taskRefs?: TaskRef[];
  attachments?: TaskAttachmentMeta[];
}

export interface AddTaskCommentRequest {
  text: string;
  attachments?: CommentAttachmentPayload[];
  taskRefs?: TaskRef[];
}
