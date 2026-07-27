import { api } from '@renderer/api';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import type { TeamRuntimeOperationsRendererTransportPort } from '../ports/TeamRuntimeOperationsRendererPorts';

export function createTeamRuntimeOperationsTransport(): TeamRuntimeOperationsRendererTransportPort {
  return {
    restartMember: (teamName, memberName) =>
      unwrapIpc('team:restartMember', () => api.teams.restartMember(teamName, memberName)),
    retryFailedSecondaryLanes: (teamName) =>
      unwrapIpc('team:retryFailedOpenCodeSecondaryLanes', () =>
        api.teams.retryFailedOpenCodeSecondaryLanes(teamName)
      ),
    skipMemberForLaunch: (teamName, memberName) =>
      unwrapIpc('team:skipMemberForLaunch', () =>
        api.teams.skipMemberForLaunch(teamName, memberName)
      ),
  };
}
