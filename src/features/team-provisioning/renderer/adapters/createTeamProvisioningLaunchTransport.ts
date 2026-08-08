import { api } from '@renderer/api';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import type { TeamProvisioningLaunchTransportPort } from '../ports/TeamProvisioningLaunchPorts';

export function createTeamProvisioningLaunchTransport(): TeamProvisioningLaunchTransportPort {
  return {
    create: (request) => {
      if (typeof api.teams.createTeam !== 'function') {
        throw new Error(
          'Current preload version does not support team:create. Restart the dev app.'
        );
      }
      return unwrapIpc('team:create', () => api.teams.createTeam(request));
    },
    launch: (request) => unwrapIpc('team:launch', () => api.teams.launchTeam(request)),
  };
}
