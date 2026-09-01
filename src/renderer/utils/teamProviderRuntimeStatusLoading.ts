import {
  isTeamProviderModelVerificationPending,
  type TeamModelRuntimeProviderStatus,
} from './teamModelAvailability';

import type { CliProviderId, TeamProviderId } from '@shared/types';

type SupportedProviderId = CliProviderId | TeamProviderId;

export function isTeamProviderRuntimeStatusLoading(
  providerId: SupportedProviderId | undefined,
  providerStatus?: TeamModelRuntimeProviderStatus | null,
  providerLoading = false
): boolean {
  if (!providerId) {
    return false;
  }

  if (isTeamProviderModelVerificationPending(providerId, providerStatus)) {
    return true;
  }

  // Cached model truth must not make an explicit provider/auth check look settled.
  return providerLoading;
}
