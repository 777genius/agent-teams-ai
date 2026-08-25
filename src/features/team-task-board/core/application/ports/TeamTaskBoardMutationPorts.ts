import type {
  CreateTaskRequest,
  KanbanColumnId,
  TeamTask,
  TeamTaskStatus,
  UpdateKanbanPatch,
} from '../models/TeamTaskBoardPortModels';

export type TaskRelationshipType = 'blockedBy' | 'blocks' | 'related';
export type TaskClarificationValue = 'lead' | 'user' | null;
export interface TaskFields {
  subject?: string;
  description?: string;
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

export interface TaskFieldsWriterPort {
  updateTaskFields(teamName: string, taskId: string, fields: TaskFields): Promise<void>;
}
