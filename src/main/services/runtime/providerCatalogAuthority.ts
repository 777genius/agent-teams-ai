import {
  hasAuthoritativeProviderStatusEvidence,
  isProviderModelCatalogExactReady,
  selectProviderModelDisplayPair,
} from '@shared/utils/providerStatusAuthority';

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
  const authoritativeCatalogReplacement =
    hydratedProvider.providerId === liveProvider.providerId &&
    hasAuthoritativeProviderStatusEvidence(liveProvider) &&
    hasAuthoritativeProviderStatusEvidence(hydratedProvider) &&
    isProviderModelCatalogExactReady(hydratedProvider);
  const canRestoreLaunch =
    authoritativeCatalogReplacement &&
    liveProvider.authenticated === true &&
    liveProvider.capabilities.teamLaunch === true &&
    hydratedProvider.capabilities.teamLaunch === true;
  if (!authoritativeCatalogReplacement) {
    const catalogMatchesProvider =
      hydratedProvider.providerId === liveProvider.providerId &&
      hydratedCatalog?.providerId === liveProvider.providerId;
    const retainedCatalog = catalogMatchesProvider
      ? hydratedCatalog
      : (liveProvider.modelCatalog ?? null);
    const displayPair = selectProviderModelDisplayPair(hydratedProvider, liveProvider, false);
    return {
      ...liveProvider,
      capabilities: { ...liveProvider.capabilities, teamLaunch: false },
      ...displayPair,
      modelCatalog: retainedCatalog ? { ...retainedCatalog, status: 'stale' } : null,
      modelCatalogRefreshState: 'error',
    };
  }
  const displayPair = selectProviderModelDisplayPair(hydratedProvider, liveProvider, true);
  return {
    ...liveProvider,
    ...displayPair,
    capabilities: { ...liveProvider.capabilities, teamLaunch: canRestoreLaunch },
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

export function markProviderCatalogRefreshFailed(
  liveProvider: CliProviderStatus
): CliProviderStatus {
  return {
    ...liveProvider,
    capabilities: { ...liveProvider.capabilities, teamLaunch: false },
    modelCatalog: liveProvider.modelCatalog
      ? { ...liveProvider.modelCatalog, status: 'stale' }
      : null,
    modelCatalogRefreshState: 'error',
  };
}

export function canHydrateProviderCatalog(provider: CliProviderStatus): boolean {
  // OpenCode inventory is intentionally explicit and source-provider scoped through
  // runtime-provider-management.loadModels. A status refresh must never expand it.
  if (provider.providerId === 'opencode') {
    return false;
  }
  return (
    provider.runtimeCapabilities?.modelCatalog?.dynamic === true &&
    provider.statusCheckOutcome === 'authoritative'
  );
}
