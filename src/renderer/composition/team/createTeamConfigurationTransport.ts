import { api } from '@renderer/api';

import type { TeamConfigurationRendererPorts } from '@features/team-configuration/renderer';

export function createTeamConfigurationTransport(): TeamConfigurationRendererPorts {
  return {
    createConfig: (request) => api.teams.createConfig(request),
    getSavedRequest: (teamName) => api.teams.getSavedRequest(teamName),
    updateConfig: (teamName, updates) => api.teams.updateConfig(teamName, updates),
  };
}
