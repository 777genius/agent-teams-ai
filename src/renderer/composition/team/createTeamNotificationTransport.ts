import { api } from '@renderer/api';

import type { TeamTaskNotificationTransportPort } from '@features/team-task-board/renderer';

export function createTeamNotificationTransport(): TeamTaskNotificationTransportPort {
  return {
    show: (data) => api.teams?.showMessageNotification(data) ?? Promise.resolve(),
  };
}
