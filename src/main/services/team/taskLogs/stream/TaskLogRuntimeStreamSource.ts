import type { BoardTaskLogStreamResponse } from '@shared/types';

export interface TaskLogRuntimeStreamSource {
  getTaskLogStream(teamName: string, taskId: string): Promise<BoardTaskLogStreamResponse | null>;
}
