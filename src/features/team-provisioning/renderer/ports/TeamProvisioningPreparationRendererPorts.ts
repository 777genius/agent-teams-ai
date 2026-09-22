import type {
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningModelVerificationMode,
  TeamProvisioningPrepareResult,
} from '@shared/types';

export interface TeamProvisioningPreparationRendererPorts {
  prepareProvisioning?: (
    cwd?: string,
    providerId?: TeamProviderId,
    providerIds?: TeamProviderId[],
    selectedModels?: string[],
    limitContext?: boolean,
    modelVerificationMode?: TeamProvisioningModelVerificationMode,
    selectedModelChecks?: TeamProvisioningModelCheckRequest[]
  ) => Promise<TeamProvisioningPrepareResult>;
}
