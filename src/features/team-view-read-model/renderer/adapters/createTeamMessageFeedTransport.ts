import { api } from '@renderer/api';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import type { TeamMessageFeedTransportPort } from '../ports/TeamMessageFeedRendererPorts';

export function createTeamMessageFeedTransport(): TeamMessageFeedTransportPort {
  return {
    getMemberActivityMeta: (teamName) =>
      unwrapIpc('team:getMemberActivityMeta', () => api.teams.getMemberActivityMeta(teamName)),
    getMessagesPage: (teamName, options) =>
      unwrapIpc('team:getMessagesPage', () => api.teams.getMessagesPage(teamName, options)),
  };
}
