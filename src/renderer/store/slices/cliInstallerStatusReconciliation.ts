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
  const modelEvidenceRetained =
    incomingProvider.models.length === 0 &&
    (incomingProvider.modelAvailability?.length ?? 0) === 0 &&
    !(
      incomingProvider.modelCatalog?.status === 'ready' &&
      incomingProvider.modelCatalog.models.length > 0
    ) &&
    (currentProvider.models.length > 0 || (currentProvider.modelAvailability?.length ?? 0) > 0);
  const launchUnproved =
    incomingProvider.statusCheckOutcome !== 'authoritative' ||
    incomingProvider.statusCheckErrorCode != null ||
    (incomingProvider.modelCatalog != null && incomingProvider.modelCatalog.status !== 'ready') ||
    catalogRetained ||
    modelEvidenceRetained;
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
    models: incomingProvider.models.length > 0 ? incomingProvider.models : currentProvider.models,
    modelAvailability:
      (incomingProvider.modelAvailability?.length ?? 0) > 0
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
    incomingProvider.statusCheckOutcome === 'authoritative' &&
    incomingProvider.statusCheckErrorCode == null &&
    (incomingProvider.modelCatalog == null || incomingProvider.modelCatalog.status === 'ready') &&
    (!currentProvider ||
      (incomingProvider.modelCatalog != null && incomingProvider.models.length > 0) ||
      (currentProvider.modelCatalog == null && currentProvider.models.length === 0))
  ) {
    return mergedProvider;
  }
  return revokeProviderLaunchAuthority(mergedProvider);
}
