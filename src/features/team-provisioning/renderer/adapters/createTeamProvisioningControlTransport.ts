import { api } from '@renderer/api';
import { unwrapIpc } from '@renderer/utils/unwrapIpc';

import type { TeamProvisioningControlTransportPort } from '../ports/TeamProvisioningControlPorts';

export function createTeamProvisioningControlTransport(): TeamProvisioningControlTransportPort {
  return {
    cancel: (runId) =>
      unwrapIpc('team:cancelProvisioning', () => api.teams.cancelProvisioning(runId)),
    getStatus: (runId) =>
      unwrapIpc('team:provisioningStatus', () => api.teams.getProvisioningStatus(runId)),
    subscribe: (listener) => {
      if (!api.teams?.onProvisioningProgress) return null;
      return api.teams.onProvisioningProgress((_event, progress) => listener(progress));
    },
  };
}
