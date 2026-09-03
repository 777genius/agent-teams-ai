import {
  hasAuthoritativeProviderLaunchEvidence,
  hasAuthoritativeProviderStatusEvidence,
  isProviderModelCatalogExactReady,
  selectProviderModelDisplayPair,
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
  const displayPair = selectProviderModelDisplayPair(
    incomingProvider,
    currentProvider,
    authoritativeCatalogReplacement
  );
  const displayPairRetained = displayPair.models === currentProvider.models;
  const hasAuthoritativeStatusEvidence = hasAuthoritativeProviderStatusEvidence(incomingProvider);
  const launchUnproved =
    !hasAuthoritativeProviderLaunchEvidence(incomingProvider) ||
    catalogRetained ||
    displayPairRetained;
  const modelCatalog =
    retainedCatalog && launchUnproved
      ? { ...retainedCatalog, status: 'stale' as const }
      : retainedCatalog;
  // A partial response means the refresh is still in flight from the user's
  // perspective. Keep the retained catalog visibly loading instead of turning
  // that intermediate snapshot into a false error (notably on Anthropic).
  const catalogRefreshPending =
    incomingProvider.modelCatalogRefreshState === 'loading' ||
    incomingProvider.statusCheckOutcome === 'pending' ||
    incomingProvider.statusCheckErrorCode === 'partial_response';
  return {
    ...incomingProvider,
    supported: incomingProvider.supported,
    authenticated: hasAuthoritativeStatusEvidence ? incomingProvider.authenticated : false,
    authMethod: hasAuthoritativeStatusEvidence ? incomingProvider.authMethod : null,
    canLoginFromUi: !hasAuthoritativeStatusEvidence
      ? currentProvider.canLoginFromUi
      : incomingProvider.canLoginFromUi,
    capabilities: launchUnproved
      ? { ...incomingProvider.capabilities, teamLaunch: false }
      : incomingProvider.capabilities,
    selectedBackendId: !hasAuthoritativeStatusEvidence
      ? currentProvider.selectedBackendId
      : incomingProvider.selectedBackendId,
    resolvedBackendId: !hasAuthoritativeStatusEvidence
      ? currentProvider.resolvedBackendId
      : incomingProvider.resolvedBackendId,
    ...displayPair,
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
        ? catalogRefreshPending
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
  const hasAuthoritativeStatusEvidence = hasAuthoritativeProviderStatusEvidence(provider);
  return {
    ...provider,
    authenticated: hasAuthoritativeStatusEvidence ? provider.authenticated : false,
    authMethod: hasAuthoritativeStatusEvidence ? provider.authMethod : null,
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
