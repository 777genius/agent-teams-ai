export function resolveOpenCodeCompatibilityModel(
  requestedModelId: string,
  availableModels: readonly string[]
): { ok: true; resolvedModelId: string } | { ok: false; reason: string } {
  const trimmedModelId = requestedModelId.trim();
  if (!trimmedModelId) {
    return { ok: false, reason: 'Selected model id is empty.' };
  }

  if (availableModels.includes(trimmedModelId)) {
    return { ok: true, resolvedModelId: trimmedModelId };
  }

  const equivalentOpenRouterMatches = findEquivalentOpenRouterModelIds(
    trimmedModelId,
    availableModels
  );
  if (equivalentOpenRouterMatches.length === 1) {
    return { ok: true, resolvedModelId: equivalentOpenRouterMatches[0] };
  }
  if (equivalentOpenRouterMatches.length > 1) {
    return {
      ok: false,
      reason:
        `Selected model ${trimmedModelId} matched multiple live provider models: ` +
        equivalentOpenRouterMatches.join(', '),
    };
  }

  if (trimmedModelId.includes('/')) {
    const requestedProviderId = extractOpenCodeCatalogProviderId(trimmedModelId);
    const availableProviderIds = getOpenCodeCatalogProviderIds(availableModels);
    if (
      requestedProviderId === 'openrouter' &&
      !availableProviderIds.includes(requestedProviderId)
    ) {
      const availableProviderList =
        availableProviderIds.length > 0 ? availableProviderIds.join(', ') : 'none';
      return {
        ok: false,
        reason:
          `OpenCode provider "openrouter" for selected model "${trimmedModelId}" ` +
          'is not available in the current runtime catalog for this project/profile. ' +
          `Live catalog providers: ${availableProviderList}. ` +
          'Connect OpenRouter in OpenCode provider management or choose one of the listed OpenCode models.',
      };
    }

    return {
      ok: false,
      reason: `Selected model ${trimmedModelId} was not found in the live provider catalog.`,
    };
  }

  const matchingProviderScopedModels = availableModels.filter(
    (candidate) => candidate.split('/').at(-1) === trimmedModelId
  );
  if (matchingProviderScopedModels.length === 1) {
    return { ok: true, resolvedModelId: matchingProviderScopedModels[0] };
  }
  if (matchingProviderScopedModels.length > 1) {
    return {
      ok: false,
      reason:
        `Selected model ${trimmedModelId} matched multiple live provider models: ` +
        matchingProviderScopedModels.join(', '),
    };
  }

  return {
    ok: false,
    reason: `Selected model ${trimmedModelId} was not found in the live provider catalog.`,
  };
}

export function extractOpenCodeCatalogProviderId(modelId: string): string | null {
  const separatorIndex = modelId.indexOf('/');
  if (separatorIndex <= 0) return null;
  return modelId.slice(0, separatorIndex).trim().toLowerCase() || null;
}

export function getOpenCodeCatalogProviderIds(availableModels: readonly string[]): string[] {
  return Array.from(
    new Set(
      availableModels
        .map((modelId) => extractOpenCodeCatalogProviderId(modelId.trim()))
        .filter((providerId): providerId is string => Boolean(providerId))
    )
  ).sort((left, right) => left.localeCompare(right));
}

export function findEquivalentOpenRouterModelIds(
  requestedModelId: string,
  availableModels: readonly string[]
): string[] {
  const equivalentIds = new Set<string>();
  if (requestedModelId.startsWith('openrouter/')) {
    equivalentIds.add(requestedModelId.slice('openrouter/'.length));
  } else if (requestedModelId.includes('/')) {
    equivalentIds.add(`openrouter/${requestedModelId}`);
  }
  return equivalentIds.size === 0
    ? []
    : Array.from(
        new Set(availableModels.filter((candidate) => equivalentIds.has(candidate.trim())))
      );
}
