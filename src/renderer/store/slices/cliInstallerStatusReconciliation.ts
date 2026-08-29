import {
  hasAuthoritativeProviderLaunchEvidence,
  isProviderModelCatalogExactReady,
} from '@shared/utils/providerStatusAuthority';

import type { CliProviderId, CliProviderStatus } from '@shared/types';

export function settleCliProviderStatusLoading(
  currentLoading: Partial<Record<CliProviderId, boolean>>,
  providerId: CliProviderId,
  options: { silent: boolean; projectPath?: string | null }
): Partial<Record<CliProviderId, boolean>> {
  return options.silent && !options.projectPath
    ? currentLoading
    : {
        ...currentLoading,
        [providerId]: false,
      };
}

function mergeProviderCatalogCache(
  incomingProvider: CliProviderStatus,
  currentProvider: CliProviderStatus
): CliProviderStatus {
  const retainedCatalog = incomingProvider.modelCatalog ?? currentProvider.modelCatalog ?? null;
  const catalogRetained =
    incomingProvider.modelCatalog == null && currentProvider.modelCatalog != null;
  const authoritativeCatalogReplacement =
    hasAuthoritativeProviderLaunchEvidence(incomingProvider) &&
    isProviderModelCatalogExactReady(incomingProvider);
  const modelsRetained =
    !authoritativeCatalogReplacement &&
    incomingProvider.models.length === 0 &&
    currentProvider.models.length > 0;
  const modelAvailabilityRetained =
    !authoritativeCatalogReplacement &&
    (incomingProvider.modelAvailability?.length ?? 0) === 0 &&
    (currentProvider.modelAvailability?.length ?? 0) > 0;
  const launchUnproved =
    !hasAuthoritativeProviderLaunchEvidence(incomingProvider) ||
    catalogRetained ||
    modelsRetained ||
    modelAvailabilityRetained;
  const modelCatalog =
    retainedCatalog && launchUnproved
      ? { ...retainedCatalog, status: 'stale' as const }
      : retainedCatalog;
  return {
    ...incomingProvider,
    supported: incomingProvider.supported,
    authenticated: launchUnproved ? false : incomingProvider.authenticated,
    authMethod: launchUnproved ? null : incomingProvider.authMethod,
    canLoginFromUi: launchUnproved
      ? currentProvider.canLoginFromUi
      : incomingProvider.canLoginFromUi,
    capabilities: launchUnproved
      ? { ...incomingProvider.capabilities, teamLaunch: false }
      : incomingProvider.capabilities,
    selectedBackendId: launchUnproved
      ? currentProvider.selectedBackendId
      : incomingProvider.selectedBackendId,
    resolvedBackendId: launchUnproved
      ? currentProvider.resolvedBackendId
      : incomingProvider.resolvedBackendId,
    models:
      authoritativeCatalogReplacement || incomingProvider.models.length > 0
        ? incomingProvider.models
        : currentProvider.models,
    modelAvailability:
      authoritativeCatalogReplacement || (incomingProvider.modelAvailability?.length ?? 0) > 0
        ? incomingProvider.modelAvailability
        : currentProvider.modelAvailability,
    availableBackends:
      (incomingProvider.availableBackends?.length ?? 0) > 0
        ? incomingProvider.availableBackends
        : currentProvider.availableBackends,
    externalRuntimeDiagnostics:
      (incomingProvider.externalRuntimeDiagnostics?.length ?? 0) > 0
        ? incomingProvider.externalRuntimeDiagnostics
        : currentProvider.externalRuntimeDiagnostics,
    backend: incomingProvider.backend ?? currentProvider.backend,
    connection: incomingProvider.connection ?? currentProvider.connection,
    modelCatalog,
    modelCatalogRefreshState:
      modelCatalog && launchUnproved
        ? incomingProvider.modelCatalogRefreshState === 'loading'
          ? 'loading'
          : 'error'
        : (incomingProvider.modelCatalogRefreshState ?? currentProvider.modelCatalogRefreshState),
    runtimeCapabilities:
      incomingProvider.runtimeCapabilities ?? currentProvider.runtimeCapabilities ?? null,
    subscriptionRateLimits:
      incomingProvider.subscriptionRateLimits ?? currentProvider.subscriptionRateLimits ?? null,
  };
}

export function revokeProviderLaunchAuthority(provider: CliProviderStatus): CliProviderStatus {
  return {
    ...provider,
    authenticated: false,
    authMethod: null,
    capabilities: { ...provider.capabilities, teamLaunch: false },
    modelCatalog: provider.modelCatalog ? { ...provider.modelCatalog, status: 'stale' } : null,
    modelCatalogRefreshState: provider.modelCatalog
      ? provider.modelCatalogRefreshState === 'loading'
        ? 'loading'
        : 'error'
      : provider.modelCatalogRefreshState,
  };
}

/** Retains same-provider display evidence without retaining uncertain launch authority. */
export function reconcileCliProviderSnapshot(
  currentProvider: CliProviderStatus | undefined,
  incomingProvider: CliProviderStatus
): CliProviderStatus {
  if (currentProvider && currentProvider.providerId !== incomingProvider.providerId) {
    return revokeProviderLaunchAuthority(currentProvider);
  }
  const mergedProvider = currentProvider
    ? mergeProviderCatalogCache(incomingProvider, currentProvider)
    : incomingProvider;
  if (
    hasAuthoritativeProviderLaunchEvidence(incomingProvider) &&
    (!currentProvider ||
      isProviderModelCatalogExactReady(incomingProvider) ||
      (currentProvider.modelCatalog == null && currentProvider.models.length === 0) ||
      (currentProvider.authenticated &&
        currentProvider.statusCheckOutcome === 'authoritative' &&
        currentProvider.verificationState === 'verified'))
  ) {
    return mergedProvider;
  }
  return revokeProviderLaunchAuthority(mergedProvider);
}
