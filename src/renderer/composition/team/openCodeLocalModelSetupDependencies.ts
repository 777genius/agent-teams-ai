import { api } from '@renderer/api';

import { createRuntimeProviderProvisioningReadinessTransport } from './createRuntimeProviderProvisioningReadinessTransport';

const readinessTransport = createRuntimeProviderProvisioningReadinessTransport();

export const openCodeLocalModelSetupDependencies = {
  configureLocalProvider: (
    input: Parameters<typeof api.runtimeProviderManagement.configureLocalProvider>[0]
  ) => api.runtimeProviderManagement.configureLocalProvider(input),
  checkReadiness: readinessTransport.checkReadiness,
};
