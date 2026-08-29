import type { CliProviderStatus } from '@shared/types';

export function hasFreshAuthoritativeScopedProviderStatus(provider: CliProviderStatus): boolean {
  if (provider.statusCheckOutcome !== 'authoritative') return false;
  if (provider.providerId !== 'opencode') return true;
  const staleAtMs = Date.parse(provider.modelCatalog?.staleAt ?? '');
  return (
    provider.modelCatalog?.providerId === 'opencode' &&
    provider.modelCatalog.status === 'ready' &&
    provider.modelCatalogRefreshState === 'ready' &&
    Number.isFinite(staleAtMs) &&
    staleAtMs > Date.now()
  );
}
