import { api } from '@renderer/api';

import type { TeamTaskDetailRendererPorts } from '@features/team-task-board/renderer';

export function createTeamTaskDetailTransport(): TeamTaskDetailRendererPorts {
  return {
    readTask: (teamName, taskId) => api.teams.getTask(teamName, taskId),
    notifyTaskLead: (teamName, message) => api.teams.processSend(teamName, message),
  };
}
