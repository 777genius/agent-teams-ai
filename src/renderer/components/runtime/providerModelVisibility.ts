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
      >
    | null
    | undefined,
  hasVisibleModels: boolean
): boolean {
  if (!provider || !hasVisibleModels) return false;
  if (!isOpenCodeCatalogHydrating(provider)) return true;

  const reportedModels = provider.models.map((model) => model.trim()).filter(Boolean);
  return reportedModels.length !== 1 || reportedModels[0]?.toLowerCase() !== 'opencode/big-pickle';
}
