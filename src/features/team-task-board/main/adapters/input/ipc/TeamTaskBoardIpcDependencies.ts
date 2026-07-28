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
import type { TaskAttachmentOperationsPort } from '../../../../core/application/use-cases/TaskAttachmentUseCases';

export interface UpdateTaskFieldsPort {
  execute(teamName: string, taskId: string, fields: TaskFields): Promise<void>;
}

export interface TeamTaskBoardIpcDependencies {
  queries: TeamTaskBoardQueryPort;
  commands: TeamTaskBoardCommandPort;
  changePresence: TaskChangePresencePort;
  globalTasks: GlobalTaskQueryPort;
  addTaskComment: AddTaskCommentPort;
  taskAttachments: TaskAttachmentOperationsPort;
  taskAttachmentLogger: TeamTaskBoardLoggerPort;
  updateTaskFields: UpdateTaskFieldsPort;
  operationTracker: MainOperationTrackerPort;
  clock: ClockPort;
  logger: TeamTaskBoardLoggerPort;
}
