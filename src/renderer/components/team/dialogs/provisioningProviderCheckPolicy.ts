import type { ProvisioningProviderCheck } from './ProvisioningProviderStatusList';
import type { TeamProviderId } from '@shared/types';

/** Retains provider-local progress while aligning checks to the current launch request. */
export function alignProvisioningProviderChecks(
  existingChecks: readonly ProvisioningProviderCheck[],
  providerIds: readonly TeamProviderId[]
): ProvisioningProviderCheck[] {
  const existingByProviderId = new Map(
    existingChecks.map((check) => [check.providerId, check] as const)
  );
  return providerIds.map(
    (providerId) =>
      existingByProviderId.get(providerId) ?? {
        providerId,
        status: 'pending',
        backendSummary: null,
        details: [],
      }
  );
}
