import { api } from '@renderer/api';

import type { TeamOperationalReadRendererPorts } from '@features/team-view-read-model/renderer';

export function createTeamOperationalReadTransport(): TeamOperationalReadRendererPorts {
  return {
    readLeadLogs: (teamName, query) => api.teams.getClaudeLogs(teamName, query),
    readMemberStats: (teamName, memberName) => api.teams.getMemberStats(teamName, memberName),
  };
}
