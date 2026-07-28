import { api } from '@renderer/api';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import type { TeamMessageDeliveryRendererTransports } from '@features/team-message-delivery/renderer';

export function createTeamMessageDeliveryTransport(): TeamMessageDeliveryRendererTransports {
  return {
    crossTeam: {
      listTargets: () => api.crossTeam.listTargets(),
      send: (request) => api.crossTeam.send(request),
    },
    team: {
      getRuntimeDeliveryStatus: (teamName, messageId) =>
        unwrapIpc('team:getOpenCodeRuntimeDeliveryStatus', () =>
          api.teams.getOpenCodeRuntimeDeliveryStatus(teamName, messageId)
        ),
      send: (teamName, request) =>
        unwrapIpc('team:sendMessage', () => api.teams.sendMessage(teamName, request)),
    },
  };
}
