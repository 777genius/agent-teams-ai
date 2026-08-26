import {
  formatProviderBackendLabel,
  getDefaultProviderBackendId,
  isTeamProviderBackendId,
  migrateProviderBackendId,
} from '@shared/utils/providerBackend';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { CliProviderStatus, TeamProviderBackendId, TeamProviderId } from '@shared/types';

function normalizeOptionalBackendId(value: string | null | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

export { formatProviderBackendLabel, getDefaultProviderBackendId };

export function resolveEffectiveProviderBackendId(
  provider: Pick<CliProviderStatus, 'selectedBackendId' | 'resolvedBackendId'> | null | undefined
): TeamProviderBackendId | undefined {
  const backendId = normalizeOptionalBackendId(
    provider?.resolvedBackendId ?? provider?.selectedBackendId
  );
  return isTeamProviderBackendId(backendId) ? backendId : undefined;
}

export function resolveUiOwnedProviderBackendId(
  providerId: TeamProviderId | CliProviderStatus['providerId'] | undefined,
  provider: Pick<CliProviderStatus, 'selectedBackendId' | 'resolvedBackendId'> | null | undefined
): TeamProviderBackendId | undefined {
  const normalizedProviderId = normalizeOptionalTeamProviderId(providerId);
  return migrateProviderBackendId(
    normalizedProviderId,
    provider?.resolvedBackendId ?? provider?.selectedBackendId,
    'explicit-selection'
  );
}

export function formatUiOwnedProviderBackendLabel(
  providerId: TeamProviderId | CliProviderStatus['providerId'] | undefined,
  provider: Pick<CliProviderStatus, 'selectedBackendId' | 'resolvedBackendId'> | null | undefined
): string | undefined {
  return formatProviderBackendLabel(
    normalizeOptionalTeamProviderId(providerId),
    resolveUiOwnedProviderBackendId(providerId, provider)
  );
}

export function formatTeamProviderBackendLabel(
  providerId: TeamProviderId | undefined,
  providerBackendId: string | undefined
): string | undefined {
  return formatProviderBackendLabel(providerId, providerBackendId);
}
