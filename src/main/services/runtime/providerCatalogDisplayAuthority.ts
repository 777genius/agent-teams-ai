import {
  hasAuthoritativeProviderStatusEvidence,
  selectProviderModelDisplayPair,
} from '@shared/utils/providerStatusAuthority';

import type { CliProviderModelCatalog, CliProviderStatus } from '@shared/types';

export function mergeProviderCatalogDisplayAuthority(
  provider: CliProviderStatus,
  catalog: CliProviderModelCatalog,
  modelCatalogRefreshState: CliProviderStatus['modelCatalogRefreshState']
): Pick<
  CliProviderStatus,
  'models' | 'modelAvailability' | 'modelCatalog' | 'modelCatalogRefreshState'
> {
  const catalogProvider: CliProviderStatus = {
    ...provider,
    modelCatalog: catalog,
    modelCatalogRefreshState,
  };
  const pair = selectProviderModelDisplayPair(
    catalogProvider,
    provider,
    hasAuthoritativeProviderStatusEvidence(provider)
  );
  const extraLaunchModels = catalog.models
    .filter((model) => model.metadata?.configuredFromLocalCatalog === true)
    .map((model) => model.launchModel.trim())
    .filter(Boolean);
  const models = [...pair.models];
  const seen = new Set(models);
  for (const launchModel of extraLaunchModels) {
    if (seen.has(launchModel)) {
      continue;
    }
    seen.add(launchModel);
    models.push(launchModel);
  }
  return {
    ...pair,
    models,
    modelCatalog: catalog,
    modelCatalogRefreshState,
  };
}
