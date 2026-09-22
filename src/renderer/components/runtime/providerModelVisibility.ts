import { isOpenCodeCatalogHydrating } from './providerConnectionUi';

import type { CliProviderStatus } from '@shared/types';

export function shouldShowLoadedProviderModels(
  provider:
    | Pick<
        CliProviderStatus,
        | 'providerId'
        | 'models'
        | 'modelCatalog'
        | 'modelCatalogRefreshState'
        | 'runtimeCapabilities'
        | 'statusCheckOutcome'
      >
    | null
    | undefined,
  hasVisibleModels: boolean
): boolean {
  if (!provider || !hasVisibleModels) return false;
  if (provider.providerId === 'opencode' && provider.statusCheckOutcome === 'model_only') {
    return true;
  }
  if (!isOpenCodeCatalogHydrating(provider)) return true;

  const reportedModels = provider.models.map((model) => model.trim()).filter(Boolean);
  return reportedModels.length !== 1 || reportedModels[0]?.toLowerCase() !== 'opencode/big-pickle';
}
