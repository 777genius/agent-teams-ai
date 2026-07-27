import { api } from '@renderer/api';

import type { TeamTaskNotificationTransportPort } from '../ports/TeamTaskNotificationPorts';

export function createTeamNotificationTransport(): TeamTaskNotificationTransportPort {
  return {
    show: (data) => api.teams?.showMessageNotification(data) ?? Promise.resolve(),
  };
}
