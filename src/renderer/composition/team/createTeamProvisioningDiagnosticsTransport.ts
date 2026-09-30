import { api } from '@renderer/api';

import type { TeamProvisioningDiagnosticsRendererPorts } from '@features/team-provisioning/renderer';

export function createTeamProvisioningDiagnosticsTransport(): TeamProvisioningDiagnosticsRendererPorts {
  return {
    getLaunchFailureDiagnostics: (teamName, runId) =>
      api.teams.getLaunchFailureDiagnostics(teamName, runId),
    validateCliArgs: (rawArgs) => api.teams.validateCliArgs(rawArgs),
  };
}
