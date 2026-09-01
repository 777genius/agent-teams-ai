import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';

import type {
  CliProviderModelAvailability,
  CliProviderModelCatalogItem,
  CliProviderStatus,
} from '@shared/types';

function parseStrictQualifiedModelRef(modelId: string | null | undefined) {
  const parsed = parseOpenCodeQualifiedModelRef(modelId);
  return parsed && parsed.raw.split('/').every((segment) => segment.length > 0) ? parsed : null;
}

export function normalizeProviderIdentity(
  providerId: string | null | undefined
): string | null {
  const normalized = providerId?.trim().toLowerCase() ?? '';
  return normalized && parseStrictQualifiedModelRef(`${normalized}/model`)?.sourceId === normalized
    ? normalized
    : null;
}

function qualifyModelId(providerId: string, modelId: string): string {
  const normalizedProviderId = providerId.trim().toLowerCase();
  const normalizedModelId = modelId.trim();
  if (
    !normalizedProviderId ||
    !normalizedModelId ||
    normalizedModelId !== modelId ||
    /\s/.test(normalizedModelId)
  ) {
    return '';
  }
  if (normalizedModelId.includes('/')) {
    const parsed = parseStrictQualifiedModelRef(normalizedModelId);
    if (!parsed) {
      return '';
    }
    return parsed.sourceId === normalizedProviderId ? parsed.raw : '';
  }
  const parsed = parseStrictQualifiedModelRef(`${normalizedProviderId}/${normalizedModelId}`);
  return parsed?.sourceId === normalizedProviderId ? parsed.raw : '';
}

export function normalizePassiveCatalogModel(
  model: CliProviderModelCatalogItem,
  expectedSourceProviderId?: string
): { model: CliProviderModelCatalogItem; aliases: readonly string[] } | null {
  const rawIds = [model.id, model.launchModel];
  const parsedIds = rawIds.map(parseStrictQualifiedModelRef);
  if (
    rawIds.some(
      (value, index) =>
        !value || value !== value.trim() || /\s/.test(value) || (value.includes('/') && !parsedIds[index])
    )
  ) {
    return null;
  }
  const qualifiedIds = new Set(
    parsedIds.flatMap((candidate) => (candidate ? [candidate.raw] : []))
  );
  const unqualifiedIds = new Set(rawIds.filter((_value, index) => !parsedIds[index]));
  if (qualifiedIds.size > 1 || unqualifiedIds.size > 1) return null;
  const route = model.metadata?.opencode;
  const routeProviderId = normalizeProviderIdentity(route?.providerId);
  const rawRouteModelId = route?.modelId;
  const routeModelRef =
    typeof rawRouteModelId === 'string' && rawRouteModelId === rawRouteModelId.trim()
      ? parseStrictQualifiedModelRef(`route/${rawRouteModelId}`)
      : null;
  const relativeRouteModelId = routeModelRef?.sourceId === 'route' ? routeModelRef.modelId : null;
  const directRouteModelRef = parseStrictQualifiedModelRef(rawRouteModelId);
  const routeModelIdentity =
    routeProviderId && relativeRouteModelId
      ? directRouteModelRef?.sourceId === routeProviderId
        ? directRouteModelRef.raw
        : parseStrictQualifiedModelRef(`${routeProviderId}/${relativeRouteModelId}`)?.raw ?? null
      : null;
  const routeModelId =
    parseStrictQualifiedModelRef(routeModelIdentity)?.modelId ?? relativeRouteModelId;
  const qualifiedIdentity = qualifiedIds.values().next().value;
  const qualifiedRef = parseStrictQualifiedModelRef(qualifiedIdentity);
  if (
    (route?.providerId != null && !routeProviderId) ||
    (route?.modelId != null && !routeModelId) ||
    (routeProviderId && qualifiedRef && routeProviderId !== qualifiedRef.sourceId) ||
    (routeModelId && qualifiedRef && routeModelId !== qualifiedRef.modelId) ||
    (routeModelIdentity && qualifiedIdentity && routeModelIdentity !== qualifiedIdentity)
  ) {
    return null;
  }
  const unqualifiedIdentity = unqualifiedIds.values().next().value;
  if (unqualifiedIdentity) {
    const routeModelId = parseStrictQualifiedModelRef(routeModelIdentity)?.modelId;
    if (!routeProviderId || !routeModelIdentity || routeModelId !== unqualifiedIdentity) {
      return null;
    }
  }
  const identity = qualifiedIdentity ?? routeModelIdentity;
  const sourceProviderId = parseStrictQualifiedModelRef(identity)?.sourceId ?? null;
  if (!identity || !sourceProviderId || (expectedSourceProviderId && sourceProviderId !== expectedSourceProviderId)) {
    return null;
  }
  return {
    model: { ...model, id: identity, launchModel: identity },
    aliases: Array.from(new Set([model.id, model.launchModel, identity])),
  };
}

export function normalizePassiveProviderOverview(
  provider: CliProviderStatus | null | undefined
): CliProviderStatus | null | undefined {
  if (!provider) return provider;
  const catalog = provider.modelCatalog;
  const normalizedEntries = (catalog?.models ?? []).flatMap((model) => {
    const normalized = normalizePassiveCatalogModel(model);
    return normalized ? [normalized] : [];
  });
  const aliases = new Map<string, string | null>();
  for (const entry of normalizedEntries) {
    for (const alias of entry.aliases) {
      if (!aliases.has(alias)) {
        aliases.set(alias, entry.model.launchModel);
      } else if (aliases.get(alias) !== entry.model.launchModel) {
        aliases.set(alias, null);
      }
    }
  }
  const normalizeVisibleModelId = (modelId: string | null | undefined): string | null => {
    if (!modelId) return null;
    const parsed = parseStrictQualifiedModelRef(modelId);
    const qualified = parsed ? qualifyModelId(parsed.sourceId, modelId) : '';
    return qualified || aliases.get(modelId) || null;
  };
  const models = Array.from(
    new Set(provider.models.flatMap((modelId) => {
      const normalized = normalizeVisibleModelId(modelId);
      return normalized ? [normalized] : [];
    }))
  );
  const visibleModelIds = new Set(
    [...models, ...normalizedEntries.map((entry) => entry.model.launchModel)]
  );
  const availabilityByModelId = new Map<string, CliProviderModelAvailability>();
  for (const availability of provider.modelAvailability ?? []) {
    const modelId = normalizeVisibleModelId(availability.modelId);
    if (modelId && visibleModelIds.has(modelId)) {
      availabilityByModelId.set(modelId, { ...availability, modelId });
    }
  }
  const defaultModelId = normalizeVisibleModelId(catalog?.defaultModelId);
  const defaultLaunchModel = normalizeVisibleModelId(catalog?.defaultLaunchModel);
  const declaredDefaults = new Set(
    [defaultModelId, defaultLaunchModel].filter(
      (modelId): modelId is string => modelId !== null && visibleModelIds.has(modelId)
    )
  );
  const flaggedDefaults = new Set(
    normalizedEntries.filter((entry) => entry.model.isDefault).map((entry) => entry.model.launchModel)
  );
  const resolvedDefault =
    declaredDefaults.size === 1
      ? declaredDefaults.values().next().value ?? null
      : declaredDefaults.size === 0 && flaggedDefaults.size === 1
        ? flaggedDefaults.values().next().value ?? null
        : null;
  const catalogModels = normalizedEntries.map((entry) => ({
    ...entry.model,
    isDefault: entry.model.launchModel === resolvedDefault,
  }));

  return {
    ...provider,
    models,
    modelAvailability: provider.modelAvailability
      ? Array.from(availabilityByModelId.values())
      : provider.modelAvailability,
    modelCatalog: catalog
      ? {
          ...catalog,
          defaultModelId: resolvedDefault,
          defaultLaunchModel: resolvedDefault,
          models: catalogModels,
        }
      : catalog,
  };
}
