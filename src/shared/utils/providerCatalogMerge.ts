import type { CliProviderModelCatalogItem } from '@shared/types';

export function markConfiguredLocalCatalogModel(
  model: CliProviderModelCatalogItem
): CliProviderModelCatalogItem {
  return {
    ...model,
    metadata: {
      ...model.metadata,
      configuredFromLocalCatalog: true,
    },
  };
}

export function findConfiguredLocalCatalogModel(
  models: readonly CliProviderModelCatalogItem[] | undefined,
  modelId: string | undefined
): CliProviderModelCatalogItem | undefined {
  const trimmed = modelId?.trim();
  if (!trimmed || !models?.length) {
    return undefined;
  }
  return models.find(
    (model) =>
      model.metadata?.configuredFromLocalCatalog === true &&
      (model.id === trimmed || model.launchModel === trimmed)
  );
}

/**
 * Provider-agnostic extra-catalog merge: live/vendor rows win on id and launch
 * model. Extra rows are tagged so any provider can skip vendor-endpoint probes.
 */
export function mergeProviderCatalogModels(
  primary: readonly CliProviderModelCatalogItem[],
  extras: readonly CliProviderModelCatalogItem[]
): CliProviderModelCatalogItem[] {
  const seenIds = new Set<string>();
  const seenLaunchModels = new Set<string>();
  const merged: CliProviderModelCatalogItem[] = [];

  for (const model of primary) {
    seenIds.add(model.id);
    seenLaunchModels.add(model.launchModel);
    merged.push(model);
  }

  const primaryHasDefault = merged.some((model) => model.isDefault);
  for (const extra of extras) {
    if (seenIds.has(extra.id) || seenLaunchModels.has(extra.launchModel)) {
      continue;
    }
    seenIds.add(extra.id);
    seenLaunchModels.add(extra.launchModel);
    const tagged = markConfiguredLocalCatalogModel(extra);
    merged.push(primaryHasDefault && tagged.isDefault ? { ...tagged, isDefault: false } : tagged);
  }

  return merged;
}
