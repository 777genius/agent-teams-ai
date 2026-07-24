import type {
  TeamLaunchRequest,
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningModelVerificationMode,
} from '@shared/types';

export interface ValidatedTeamLaunchInput {
  payload: Partial<TeamLaunchRequest>;
  teamName: string;
  cwd: string;
  explicitProviderId: TeamProviderId | undefined;
  defaultProviderId: TeamProviderId;
  explicitProviderBackendId: string | undefined;
}

export type TeamLaunchMode = 'draft' | 'existing';

export interface ValidatedProvisioningPrepareInput {
  cwd: string | undefined;
  providerId: TeamProviderId | undefined;
  providerIds: TeamProviderId[] | undefined;
  selectedModels: string[] | undefined;
  limitContext: boolean | undefined;
  modelVerificationMode: TeamProvisioningModelVerificationMode | undefined;
  selectedModelChecks: TeamProvisioningModelCheckRequest[] | undefined;
}

export type InputValidation<T> = { valid: true; value: T } | { valid: false; error: string };
