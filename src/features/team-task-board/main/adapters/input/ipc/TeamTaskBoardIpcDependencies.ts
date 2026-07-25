import type {
  ClockPort,
  GlobalTaskQueryPort,
  MainOperationTrackerPort,
  TaskChangePresencePort,
  TaskFields,
  TeamTaskBoardCommandPort,
  TeamTaskBoardLoggerPort,
  TeamTaskBoardQueryPort,
} from '../../../../core/application/ports/TeamTaskBoardPorts';
import type { AddTaskCommentPort } from '../../../../core/application/use-cases/AddTaskCommentUseCase';

export interface UpdateTaskFieldsPort {
  execute(teamName: string, taskId: string, fields: TaskFields): Promise<void>;
}

export interface TeamTaskBoardIpcDependencies {
  queries: TeamTaskBoardQueryPort;
  commands: TeamTaskBoardCommandPort;
  changePresence: TaskChangePresencePort;
  globalTasks: GlobalTaskQueryPort;
  addTaskComment: AddTaskCommentPort;
  updateTaskFields: UpdateTaskFieldsPort;
  operationTracker: MainOperationTrackerPort;
  clock: ClockPort;
  logger: TeamTaskBoardLoggerPort;
}
