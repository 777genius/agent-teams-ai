import type {
  TeamProviderId,
  TeamProvisioningModelCheckRequest,
  TeamProvisioningModelVerificationMode,
} from '@shared/types';

export function validateAuthoritativePrepareRequest(input: {
  providerId?: TeamProviderId;
  providerIds?: readonly TeamProviderId[];
  mode?: TeamProvisioningModelVerificationMode;
  checks?: readonly TeamProvisioningModelCheckRequest[];
  allowExperimentalLocalModels: unknown;
}): { valid: true; allowExperimentalLocalModels?: boolean } | { valid: false; error: string } {
  if (
    input.allowExperimentalLocalModels !== undefined &&
    typeof input.allowExperimentalLocalModels !== 'boolean'
  ) {
    return { valid: false, error: 'allowExperimentalLocalModels must be a boolean' };
  }
  if (input.mode === 'deep' && input.checks?.length) {
    const verified = new Set(
      [input.providerId, ...(input.providerIds ?? [])].filter(
        (entry): entry is TeamProviderId => entry !== undefined
      )
    );
    const checked = new Set(input.checks.map((check) => check.providerId));
    if (verified.size !== checked.size || Array.from(checked).some((id) => !verified.has(id))) {
      return {
        valid: false,
        error: 'Deep preparation provider set must exactly match selectedModelChecks providers',
      };
    }
  }
  return {
    valid: true,
    allowExperimentalLocalModels: input.allowExperimentalLocalModels,
  };
}
