import type {
  CreateTaskRequest,
  TeamTask,
  TeamTaskBoardSnapshot,
} from '../models/TeamTaskBoardPortModels';
import type {
  TaskFieldsWriterPort,
  TeamTaskBoardCommandPort,
  TeamTaskBoardQueryPort,
} from './TeamTaskBoardPorts';

export type TeamTaskBoardMutationPort = Pick<
  TeamTaskBoardCommandPort,
  | 'addTaskRelationship'
  | 'createTask'
  | 'removeTaskRelationship'
  | 'requestReview'
  | 'restoreTask'
  | 'setTaskNeedsClarification'
  | 'softDeleteTask'
  | 'startTask'
  | 'startTaskByUser'
  | 'updateKanban'
  | 'updateKanbanColumnOrder'
  | 'updateTaskOwner'
  | 'updateTaskStatus'
> &
  TaskFieldsWriterPort;

export type TeamTaskBoardDeletedTaskQueryPort = Pick<TeamTaskBoardQueryPort, 'getDeletedTasks'>;

export interface TeamTaskBoardRefreshPort {
  refreshAllTasks(): Promise<void>;
  refreshTeamData(teamName: string): Promise<void>;
}

export interface TeamTaskBoardInteractionStatePort {
  getTeamData(teamName: string): TeamTaskBoardSnapshot | null;
  setDeletedTasks(tasks: TeamTask[], loading: boolean): void;
  setDeletedTasksLoading(loading: boolean): void;
  setReviewActionError(error: string | null): void;
}

export interface TeamTaskBoardPresenceRefreshPort {
  refreshAfterTaskTransition(teamName: string, taskId: string): Promise<void>;
}

export interface TeamTaskBoardReviewErrorPort {
  map(error: unknown): string;
}

export interface TeamTaskBoardInteractionLoggerPort {
  error(message: string, error: unknown): void;
}

export interface TeamTaskCreationLifecyclePort {
  recordCreatedTask(
    teamName: string,
    task: TeamTask,
    request: CreateTaskRequest,
    teamData: TeamTaskBoardSnapshot | null,
    startedAtMs: number
  ): void;
}

export interface TeamTaskLifecyclePort extends TeamTaskCreationLifecyclePort {
  clearTeam(teamName: string): void;
}

export interface TeamTaskBoardClockPort {
  now(): number;
}
