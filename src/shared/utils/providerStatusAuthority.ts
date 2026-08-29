import type { CliProviderStatus } from '@shared/types/cliInstaller';

export interface ProviderModelDisplayPair {
  models: CliProviderStatus['models'];
  modelAvailability: CliProviderStatus['modelAvailability'];
}

export function selectProviderModelDisplayPair(
  incoming: CliProviderStatus,
  current: CliProviderStatus | undefined,
  replacePair: boolean
): ProviderModelDisplayPair {
  if (replacePair && isProviderModelCatalogExactReady(incoming)) {
    const models = incoming.modelCatalog!.models.map((model) => model.launchModel);
    const modelIds = new Set(
      incoming.modelCatalog!.models.flatMap((model) => [model.id, model.launchModel])
    );
    return {
      models,
      modelAvailability: (incoming.modelAvailability ?? []).filter((availability) =>
        modelIds.has(availability.modelId)
      ),
    };
  }
  const currentHasDisplayEvidence =
    current !== undefined &&
    (current.models.length > 0 || (current.modelAvailability?.length ?? 0) > 0);
  const source = replacePair || !currentHasDisplayEvidence ? incoming : current;
  return {
    models: source.models,
    modelAvailability: source.modelAvailability,
  };
}

export function isProviderModelCatalogExactReady(
  provider: CliProviderStatus,
  now: number = Date.now()
): boolean {
  const catalog = provider.modelCatalog;
  const fetchedAt = typeof catalog?.fetchedAt === 'string' ? Date.parse(catalog.fetchedAt) : NaN;
  const staleAt = typeof catalog?.staleAt === 'string' ? Date.parse(catalog.staleAt) : NaN;
  return (
    Number.isFinite(now) &&
    catalog?.schemaVersion === 1 &&
    catalog.providerId === provider.providerId &&
    catalog.status === 'ready' &&
    provider.modelCatalogRefreshState === 'ready' &&
    Number.isFinite(fetchedAt) &&
    Number.isFinite(staleAt) &&
    fetchedAt <= now &&
    now < staleAt &&
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

export function hasAuthoritativeProviderStatusEvidence(provider: CliProviderStatus): boolean {
  return (
    provider.statusCheckOutcome === 'authoritative' &&
    provider.statusCheckErrorCode == null &&
    provider.verificationState === 'verified'
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
    hasAuthoritativeProviderStatusEvidence(provider) &&
    provider.authenticated === true &&
    provider.capabilities.teamLaunch === true &&
    isProviderModelCatalogExactReady(provider) &&
    hasExactReadyDynamicProviderCatalog(provider)
  );
}
