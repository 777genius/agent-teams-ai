import type {
  AddTaskCommentRequest,
  AttachmentMediaType,
  CreateTaskRequest,
  GlobalTask,
  KanbanColumnId,
  TaskAttachmentMeta,
  TaskChangePresenceState,
  TaskComment,
  TaskRef,
  TeamTask,
  TeamTaskStatus,
  TeamTaskWithKanban,
  UpdateKanbanPatch,
} from '@shared/types';

export type TaskRelationshipType = 'blockedBy' | 'blocks' | 'related';
export type TaskClarificationValue = 'lead' | 'user' | null;
export interface TaskFields {
  subject?: string;
  description?: string;
}

export interface TeamTaskBoardQueryPort {
  getTask(teamName: string, taskId: string): Promise<TeamTaskWithKanban | null>;
  getDeletedTasks(teamName: string): Promise<TeamTask[]>;
}

export interface TeamTaskBoardCommandPort {
  createTask(teamName: string, request: CreateTaskRequest): Promise<TeamTask>;
  requestReview(teamName: string, taskId: string): Promise<void>;
  updateKanban(teamName: string, taskId: string, patch: UpdateKanbanPatch): Promise<void>;
  updateKanbanColumnOrder(
    teamName: string,
    columnId: KanbanColumnId,
    orderedTaskIds: string[]
  ): Promise<void>;
  updateTaskStatus(teamName: string, taskId: string, status: TeamTaskStatus): Promise<void>;
  updateTaskOwner(teamName: string, taskId: string, owner: string | null): Promise<void>;
  startTask(teamName: string, taskId: string): Promise<{ notifiedOwner: boolean }>;
  startTaskByUser(teamName: string, taskId: string): Promise<{ notifiedOwner: boolean }>;
  softDeleteTask(teamName: string, taskId: string): Promise<void>;
  restoreTask(teamName: string, taskId: string): Promise<void>;
  setTaskNeedsClarification(
    teamName: string,
    taskId: string,
    value: TaskClarificationValue
  ): Promise<void>;
  addTaskRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: TaskRelationshipType
  ): Promise<void>;
  removeTaskRelationship(
    teamName: string,
    taskId: string,
    targetId: string,
    type: TaskRelationshipType
  ): Promise<void>;
}

export interface TaskChangePresencePort {
  getTaskChangePresence(teamName: string): Promise<Record<string, TaskChangePresenceState>>;
  setTaskChangePresenceTracking(teamName: string, enabled: boolean): void;
}

export interface GlobalTaskQueryPort {
  getAllTasks(): Promise<GlobalTask[]>;
}

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
  saveAttachment(
    teamName: string,
    taskId: string,
    attachmentId: string,
    filename: string,
    mimeType: AttachmentMediaType,
    base64Data: string
  ): Promise<TaskAttachmentMeta>;
}

export interface TaskFieldsWriterPort {
  updateTaskFields(teamName: string, taskId: string, fields: TaskFields): Promise<void>;
}

export interface TeamRuntimeStatusPort {
  isTeamAlive(teamName: string): boolean;
}

export interface TeamLeadNotificationPort {
  sendMessageToTeam(teamName: string, message: string): Promise<void>;
}

export interface TeamTaskBoardLoggerPort {
  error(message: string): void;
  warn(message: string): void;
}

export interface MainOperationTrackerPort {
  setCurrent(operation: string | null): void;
}

export interface ClockPort {
  now(): number;
}

export type TaskCommentRequest = AddTaskCommentRequest;
