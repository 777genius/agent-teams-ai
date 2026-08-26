import type { CliProviderStatus } from '@shared/types';

export const CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT = 12;

export interface ScopedCliProviderLaunchProof {
  providerStatus: CliProviderStatus;
  requestId: number;
  epoch: number;
  fetchedAtMs: number;
}

export function setBoundedScopedProviderLaunchProof(
  current: Readonly<Record<string, ScopedCliProviderLaunchProof>>,
  scopeKey: string,
  proof: ScopedCliProviderLaunchProof
): Readonly<Record<string, ScopedCliProviderLaunchProof>> {
  const entries = Object.entries(current).filter(([key]) => key !== scopeKey);
  entries.push([scopeKey, proof]);
  if (entries.length > CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT) {
    entries.splice(0, entries.length - CLI_PROVIDER_STATUS_SCOPE_CACHE_LIMIT);
  }
  return Object.fromEntries(entries);
}
