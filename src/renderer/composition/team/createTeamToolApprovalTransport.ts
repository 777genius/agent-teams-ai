import { api } from '@renderer/api';

import type { TeamToolApprovalRendererTransportPort } from '@features/team-provisioning/renderer';

export function createTeamToolApprovalTransport(): TeamToolApprovalRendererTransportPort {
  return {
    respond: (teamName, runId, requestId, allow, message) =>
      api.teams.respondToToolApproval(teamName, runId, requestId, allow, message),
    updateSettings: (teamName, settings) =>
      api.teams.updateToolApprovalSettings(teamName, settings),
  };
}
