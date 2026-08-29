import { hasAuthoritativeProviderLaunchEvidence } from '@shared/utils/providerStatusAuthority';

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
    !hasAuthoritativeProviderLaunchEvidence(hydratedProvider)
  ) {
    const catalogMatchesProvider = hydratedCatalog?.providerId === liveProvider.providerId;
    const retainedCatalog = catalogMatchesProvider
      ? hydratedCatalog
      : (liveProvider.modelCatalog ?? null);
    return {
      ...liveProvider,
      authenticated: false,
      authMethod: null,
      verificationState: hydratedProvider.verificationState,
      statusCheckOutcome: hydratedProvider.statusCheckOutcome,
      statusCheckErrorCode: hydratedProvider.statusCheckErrorCode,
      statusMessage: hydratedProvider.statusMessage ?? liveProvider.statusMessage,
      detailMessage:
        hydratedProvider.detailMessage ??
        hydratedProvider.statusMessage ??
        'Provider catalog hydration did not return an authoritative ready catalog',
      capabilities: { ...liveProvider.capabilities, teamLaunch: false },
      models:
        catalogMatchesProvider && hydratedProvider.models.length > 0
          ? hydratedProvider.models
          : liveProvider.models,
      modelCatalog: retainedCatalog ? { ...retainedCatalog, status: 'stale' } : null,
      modelCatalogRefreshState: retainedCatalog
        ? 'error'
        : hydratedProvider.modelCatalogRefreshState,
      runtimeCapabilities: mergeRuntimeCapabilitiesForCatalogHydration(
        liveProvider.runtimeCapabilities,
        hydratedProvider.runtimeCapabilities
      ),
      subscriptionRateLimits:
        hydratedProvider.subscriptionRateLimits ?? liveProvider.subscriptionRateLimits ?? null,
      externalRuntimeDiagnostics:
        (hydratedProvider.externalRuntimeDiagnostics?.length ?? 0) > 0
          ? hydratedProvider.externalRuntimeDiagnostics
          : liveProvider.externalRuntimeDiagnostics,
    };
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
