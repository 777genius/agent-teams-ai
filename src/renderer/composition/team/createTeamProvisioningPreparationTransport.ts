import { api } from '@renderer/api';

import type { TeamProvisioningPreparationRendererPorts } from '@features/team-provisioning/renderer';

export function createTeamProvisioningPreparationTransport(): TeamProvisioningPreparationRendererPorts {
  const prepareProvisioning = api.teams.prepareProvisioning;
  if (typeof prepareProvisioning !== 'function') {
    return {};
  }
  return {
    prepareProvisioning: (
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
      ),
  };
}
