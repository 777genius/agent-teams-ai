import { api } from '@renderer/api';

import type { TeamWorktreeGitReadinessRendererPorts } from '@features/team-provisioning/renderer';

export function createTeamWorktreeGitReadinessTransport(): TeamWorktreeGitReadinessRendererPorts {
  return {
    getStatus: (projectPath) => api.teams.getWorktreeGitStatus(projectPath),
    initialize: (projectPath) => api.teams.initializeGitRepository(projectPath),
    createInitialCommit: (projectPath) => api.teams.createInitialGitCommit(projectPath),
  };
}
