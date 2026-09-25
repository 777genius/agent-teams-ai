import { api } from '@renderer/api';

import type { TeamBranchTrackingRendererPorts } from '@features/team-view-read-model/renderer';

export function createTeamBranchTrackingTransport(): TeamBranchTrackingRendererPorts {
  return {
    setTracking: (projectPath, enabled) => api.teams.setProjectBranchTracking(projectPath, enabled),
  };
}
