import type { CliProviderId, CliProviderStatus } from '@shared/types';

export const CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT = 12;

export function getCliProviderStatusScopeKey(
  providerId: CliProviderId,
  projectPath: string | null | undefined
): string {
  return `${providerId}\0${projectPath?.trim() ?? ''}`;
}

export function setBoundedScopedProviderStatus(
  current: Readonly<Record<string, CliProviderStatus>>,
  scopeKey: string,
  providerStatus: CliProviderStatus
): Readonly<Record<string, CliProviderStatus>> {
  const entries = Object.entries(current).filter(([key]) => key !== scopeKey);
  entries.push([scopeKey, providerStatus]);
  if (entries.length > CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT) {
    entries.splice(0, entries.length - CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT);
  }
  return Object.fromEntries(entries);
}
