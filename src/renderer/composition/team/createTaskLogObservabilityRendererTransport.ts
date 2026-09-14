import { api } from '@renderer/api';

import type { TaskLogObservabilityRendererPort } from '@features/task-log-observability/renderer';

const noOpUnsubscribe = (): void => undefined;

export function createTaskLogObservabilityRendererTransport(): TaskLogObservabilityRendererPort {
  const getTaskLogStreamSummary = api.teams.getTaskLogStreamSummary;
  const setTaskLogStreamTracking = api.teams.setTaskLogStreamTracking;

  return {
    getTaskActivity: (teamName, taskId) => api.teams.getTaskActivity(teamName, taskId),
    getTaskActivityDetail: (teamName, taskId, activityId) =>
      api.teams.getTaskActivityDetail(teamName, taskId, activityId),
    getTaskExactLogDetail: (teamName, taskId, exactLogId, expectedSourceGeneration) =>
      api.teams.getTaskExactLogDetail(teamName, taskId, exactLogId, expectedSourceGeneration),
    getTaskExactLogSummaries: (teamName, taskId) =>
      api.teams.getTaskExactLogSummaries(teamName, taskId),
    getTaskLogStream: (teamName, taskId) => api.teams.getTaskLogStream(teamName, taskId),
    ...(typeof getTaskLogStreamSummary === 'function'
      ? {
          getTaskLogStreamSummary: (teamName: string, taskId: string) =>
            getTaskLogStreamSummary(teamName, taskId),
        }
      : {}),
    ...(typeof setTaskLogStreamTracking === 'function'
      ? {
          setTaskLogStreamTracking: (teamName: string, enabled: boolean) =>
            setTaskLogStreamTracking(teamName, enabled),
        }
      : {}),
    subscribeToTeamChanges: (listener) =>
      api.teams.onTeamChange?.((_event, event) => listener(event)) ?? noOpUnsubscribe,
  };
}
