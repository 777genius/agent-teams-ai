import type {
  ClockPort,
  GlobalTaskQueryPort,
  MainOperationTrackerPort,
  TaskChangePresencePort,
  TaskCommentAttachmentWriterPort,
  TaskCommentWriterPort,
  TaskFields,
  TeamTaskBoardCommandPort,
  TeamTaskBoardLoggerPort,
  TeamTaskBoardQueryPort,
} from '../../../../core/application/ports/TeamTaskBoardPorts';

export interface UpdateTaskFieldsPort {
  execute(teamName: string, taskId: string, fields: TaskFields): Promise<void>;
}

export interface TeamTaskBoardIpcDependencies {
  queries: TeamTaskBoardQueryPort;
  commands: TeamTaskBoardCommandPort;
  changePresence: TaskChangePresencePort;
  globalTasks: GlobalTaskQueryPort;
  comments: TaskCommentWriterPort;
  commentAttachments: TaskCommentAttachmentWriterPort;
  updateTaskFields: UpdateTaskFieldsPort;
  operationTracker: MainOperationTrackerPort;
  clock: ClockPort;
  logger: TeamTaskBoardLoggerPort;
}
