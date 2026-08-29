import { createDegradedProviderStatus } from './providerStatusCheckContract';

import type { CliProviderStatus } from '@shared/types';

function mergeRuntimeCapabilitiesForCatalogHydration(
  live: CliProviderStatus['runtimeCapabilities'],
  hydrated: CliProviderStatus['runtimeCapabilities']
): CliProviderStatus['runtimeCapabilities'] {
  if (!hydrated) {
    return live ?? null;
  }
  if (!live) {
    return hydrated;
  }
  return {
    ...live,
    modelCatalog: hydrated.modelCatalog ?? live.modelCatalog,
    reasoningEffort: hydrated.reasoningEffort ?? live.reasoningEffort,
    fastMode: hydrated.fastMode ?? live.fastMode,
  };
}

export function mergeProviderCatalogFields(
  liveProvider: CliProviderStatus,
  hydratedProvider: CliProviderStatus
): CliProviderStatus {
  if (hydratedProvider.statusCheckOutcome !== 'authoritative') {
    return createDegradedProviderStatus(
      liveProvider,
      hydratedProvider.detailMessage ??
        hydratedProvider.statusMessage ??
        'Provider catalog hydration was not authoritative'
    );
  }
  const modelCatalog = hydratedProvider.modelCatalog ?? liveProvider.modelCatalog ?? null;
  return {
    ...liveProvider,
    models: hydratedProvider.models.length > 0 ? hydratedProvider.models : liveProvider.models,
    modelCatalog,
    modelCatalogRefreshState: modelCatalog
      ? 'ready'
      : hydratedProvider.modelCatalogRefreshState === 'error'
        ? 'error'
        : liveProvider.modelCatalogRefreshState,
    runtimeCapabilities: mergeRuntimeCapabilitiesForCatalogHydration(
      liveProvider.runtimeCapabilities,
      hydratedProvider.runtimeCapabilities
    ),
    subscriptionRateLimits:
      hydratedProvider.subscriptionRateLimits ?? liveProvider.subscriptionRateLimits ?? null,
  };
}

export function canHydrateProviderCatalog(provider: CliProviderStatus): boolean {
  return (
    provider.runtimeCapabilities?.modelCatalog?.dynamic === true &&
    (provider.statusCheckOutcome === 'authoritative' ||
      (provider.providerId === 'opencode' && provider.statusCheckOutcome === 'model_only'))
  );
}
