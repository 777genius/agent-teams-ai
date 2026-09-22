import type {
  BoardTaskActivityDetailResult,
  BoardTaskActivityEntry,
  BoardTaskExactLogDetailResult,
  BoardTaskExactLogSummariesResponse,
  BoardTaskLogStreamResponse,
  BoardTaskLogStreamSummary,
  TeamChangeEvent,
} from '@shared/types';

export type TaskLogObservabilityTeamChangeListener = (event: TeamChangeEvent) => void;

export interface TaskLogObservabilityRendererPort {
  getTaskActivity(teamName: string, taskId: string): Promise<BoardTaskActivityEntry[]>;
  getTaskActivityDetail(
    teamName: string,
    taskId: string,
    activityId: string
  ): Promise<BoardTaskActivityDetailResult>;
  getTaskExactLogDetail(
    teamName: string,
    taskId: string,
    exactLogId: string,
    expectedSourceGeneration: string
  ): Promise<BoardTaskExactLogDetailResult>;
  getTaskExactLogSummaries(
    teamName: string,
    taskId: string
  ): Promise<BoardTaskExactLogSummariesResponse>;
  getTaskLogStream(teamName: string, taskId: string): Promise<BoardTaskLogStreamResponse>;
  getTaskLogStreamSummary?: (
    teamName: string,
    taskId: string
  ) => Promise<BoardTaskLogStreamSummary>;
  setTaskLogStreamTracking?: (teamName: string, enabled: boolean) => Promise<void>;
  subscribeToTeamChanges(listener: TaskLogObservabilityTeamChangeListener): () => void;
}
