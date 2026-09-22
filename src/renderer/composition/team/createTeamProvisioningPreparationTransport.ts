import { api } from '@renderer/api';

import type { TeamProvisioningPreparationRendererPort } from '@features/team-provisioning/renderer';

export function createTeamProvisioningPreparationTransport(): TeamProvisioningPreparationRendererPort {
  const prepareProvisioning = api.teams.prepareProvisioning;
  const workspaceTrust = api.workspaceTrust;
  const port: TeamProvisioningPreparationRendererPort = {};
  if (typeof prepareProvisioning === 'function') {
    port.prepareProvisioning = (
      cwd,
      providerId,
      providerIds,
      selectedModels,
      limitContext,
      modelVerificationMode,
      selectedModelChecks
    ) =>
      prepareProvisioning(
        cwd,
        providerId,
        providerIds,
        selectedModels,
        limitContext,
        modelVerificationMode,
        selectedModelChecks
      );
  }
  if (typeof workspaceTrust?.getProjectStatus === 'function') {
    port.getWorkspaceTrustProjectStatus = (request) => workspaceTrust.getProjectStatus(request);
  }
  return port;
}
