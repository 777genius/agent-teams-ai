import type {
  GlobalTask,
  TaskChangePresenceState,
  TeamTask,
  TeamTaskWithKanban,
} from '../models/TeamTaskBoardPortModels';

export interface TeamTaskBoardQueryPort {
  getTask(teamName: string, taskId: string): Promise<TeamTaskWithKanban | null>;
  getDeletedTasks(teamName: string): Promise<TeamTask[]>;
}

export interface TaskChangePresencePort {
  getTaskChangePresence(teamName: string): Promise<Record<string, TaskChangePresenceState>>;
  setTaskChangePresenceTracking(teamName: string, enabled: boolean): void;
}

export interface GlobalTaskQueryPort {
  getAllTasks(): Promise<GlobalTask[]>;
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
