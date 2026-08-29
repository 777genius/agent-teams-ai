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
  const hydratedCatalog = hydratedProvider.modelCatalog;
  if (
    hydratedProvider.providerId !== liveProvider.providerId ||
    hydratedProvider.statusCheckOutcome !== 'authoritative' ||
    hydratedProvider.statusCheckErrorCode != null ||
    hydratedCatalog?.providerId !== liveProvider.providerId ||
    hydratedCatalog.status !== 'ready'
  ) {
    return createDegradedProviderStatus(
      liveProvider,
      hydratedProvider.detailMessage ??
        hydratedProvider.statusMessage ??
        'Provider catalog hydration did not return an authoritative ready catalog'
    );
  }
  return {
    ...liveProvider,
    models: hydratedProvider.models.length > 0 ? hydratedProvider.models : liveProvider.models,
    modelCatalog: hydratedCatalog,
    modelCatalogRefreshState: 'ready',
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
