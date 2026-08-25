import { api } from '@renderer/api';

import type { TeamGraphTaskNotificationPort } from '@features/agent-graph/renderer';

export function createTeamGraphTaskNotificationTransport(): TeamGraphTaskNotificationPort {
  return {
    notifyTeam: (teamName, message) => api.teams.processSend(teamName, message),
  };
}
