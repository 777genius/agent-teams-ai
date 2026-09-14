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
  return {
    ...selectProviderModelDisplayPair(
      catalogProvider,
      provider,
      hasAuthoritativeProviderStatusEvidence(provider)
    ),
    modelCatalog: catalog,
    modelCatalogRefreshState,
  };
}
