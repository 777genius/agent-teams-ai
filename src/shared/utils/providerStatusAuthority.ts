import type { CliProviderStatus } from '@shared/types/cliInstaller';

export function isProviderModelCatalogExactReady(provider: CliProviderStatus): boolean {
  const catalog = provider.modelCatalog;
  return (
    catalog?.schemaVersion === 1 &&
    catalog.providerId === provider.providerId &&
    catalog.status === 'ready' &&
    provider.modelCatalogRefreshState === 'ready' &&
    typeof catalog.fetchedAt === 'string' &&
    catalog.fetchedAt.trim().length > 0 &&
    typeof catalog.staleAt === 'string' &&
    catalog.staleAt.trim().length > 0 &&
    Array.isArray(catalog.models) &&
    catalog.models.every(
      (model) =>
        typeof model?.id === 'string' &&
        model.id.trim().length > 0 &&
        typeof model.launchModel === 'string' &&
        model.launchModel.trim().length > 0 &&
        typeof model.displayName === 'string' &&
        model.displayName.trim().length > 0
    )
  );
}

export function hasExactReadyDynamicProviderCatalog(provider: CliProviderStatus): boolean {
  return (
    provider.runtimeCapabilities?.modelCatalog?.dynamic !== true ||
    isProviderModelCatalogExactReady(provider)
  );
}

export function hasAuthoritativeProviderLaunchEvidence(provider: CliProviderStatus): boolean {
  return (
    provider.statusCheckOutcome === 'authoritative' &&
    provider.statusCheckErrorCode == null &&
    provider.verificationState === 'verified' &&
    (provider.modelCatalog == null || isProviderModelCatalogExactReady(provider)) &&
    hasExactReadyDynamicProviderCatalog(provider)
  );
}
