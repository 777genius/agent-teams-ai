import type {
  BoardTaskActivityDetailResult,
  BoardTaskActivityEntry,
  BoardTaskExactLogDetailResult,
  BoardTaskExactLogSummariesResponse,
  BoardTaskLogStreamResponse,
  BoardTaskLogStreamSummary,
} from '@shared/types';

export interface TaskActivityReader {
  getTaskActivity(teamName: string, taskId: string): Promise<BoardTaskActivityEntry[]>;
}

export interface TaskActivityDetailReader {
  getTaskActivityDetail(
    teamName: string,
    taskId: string,
    activityId: string
  ): Promise<BoardTaskActivityDetailResult>;
}

export interface TaskLogStreamReader {
  getTaskLogStream(teamName: string, taskId: string): Promise<BoardTaskLogStreamResponse>;
  getTaskLogStreamSummary(teamName: string, taskId: string): Promise<BoardTaskLogStreamSummary>;
}

export interface TaskExactLogSummaryReader {
  getTaskExactLogSummaries(
    teamName: string,
    taskId: string
  ): Promise<BoardTaskExactLogSummariesResponse>;
}

export interface TaskExactLogDetailReader {
  getTaskExactLogDetail(
    teamName: string,
    taskId: string,
    exactLogId: string,
    expectedSourceGeneration: string
  ): Promise<BoardTaskExactLogDetailResult>;
}

export interface TaskLogObservabilityReaders {
  activity: TaskActivityReader;
  activityDetail: TaskActivityDetailReader;
  stream: TaskLogStreamReader;
  exactLogSummaries: TaskExactLogSummaryReader;
  exactLogDetail: TaskExactLogDetailReader;
}
