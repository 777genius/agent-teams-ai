import { api } from '@renderer/api';

import type { ToolApprovalDiffFileReadPort } from '@features/team-approvals/renderer';

export function createTeamToolApprovalDiffFileReadTransport(): ToolApprovalDiffFileReadPort {
  return {
    readFile: (request) => api.teams.readFileForToolApproval(request),
  };
}
