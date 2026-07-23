import type {
  TaskFieldsWriterPort,
  TeamTaskBoardCommandPort,
  TeamTaskBoardQueryPort,
} from './TeamTaskBoardPorts';
import type { CreateTaskRequest, TeamTask, TeamViewSnapshot } from '@shared/types';

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
  getTeamData(teamName: string): TeamViewSnapshot | null;
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
    teamData: TeamViewSnapshot | null,
    startedAtMs: number
  ): void;
}

export interface TeamTaskLifecyclePort extends TeamTaskCreationLifecyclePort {
  clearTeam(teamName: string): void;
}

export interface TeamTaskBoardClockPort {
  now(): number;
}
