import { api } from '@renderer/api';

import type { RuntimeProviderProvisioningReadinessPort } from '@features/runtime-provider-management/renderer';

export function createRuntimeProviderProvisioningReadinessTransport(): RuntimeProviderProvisioningReadinessPort {
  return {
    checkReadiness: (cwd, modelRoute) =>
      api.teams.prepareProvisioning(cwd, 'opencode', ['opencode'], [modelRoute], false, 'deep'),
  };
}
