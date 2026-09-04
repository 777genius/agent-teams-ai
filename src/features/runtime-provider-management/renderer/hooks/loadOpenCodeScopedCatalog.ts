import { api } from '@renderer/api';

import {
  parseStrictQualifiedModelRef,
  qualifyModelId,
} from '../../core/domain/openCodeModelIdentity';

import type {
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderModelDto,
} from '../../contracts';

const MAX_MODEL_PAGES = 20;
export const MODEL_CATALOG_FRESHNESS_MS = 2 * 60_000;
function responseFailure(
  response: RuntimeProviderManagementModelsResponse,
  sourceProviderId: string
): string | null {
  if (response.schemaVersion !== 1 || response.runtimeId !== 'opencode') {
    return 'The runtime returned an unsupported provider-model catalog response.';
  }
  if (response.error) {
    return response.error.message || 'The provider-model catalog request failed.';
  }
  if (!response.models) {
    return 'The runtime did not return a provider-model catalog.';
  }
  if (response.models.runtimeId !== 'opencode') {
    return 'The runtime returned an unsupported provider-model catalog response.';
  }
  if (response.models.providerId.trim().toLowerCase() !== sourceProviderId) {
    return `The runtime returned models for ${response.models.providerId}, not ${sourceProviderId}.`;
  }
  for (const model of response.models.models) {
    const modelProviderId = model.providerId.trim().toLowerCase();
    if (modelProviderId !== sourceProviderId) {
      return `The runtime returned a foreign ${model.providerId || 'unknown'} model in the ${sourceProviderId} catalog.`;
    }
    const qualifiedModel = parseStrictQualifiedModelRef(model.modelId);
    if (qualifiedModel && qualifiedModel.sourceId !== sourceProviderId) {
      return `The runtime returned foreign model ${qualifiedModel.raw} in the ${sourceProviderId} catalog.`;
    }
    if (!qualifyModelId(sourceProviderId, model.modelId)) {
      return `The runtime returned an invalid model identifier in the ${sourceProviderId} catalog.`;
    }
    if (typeof model.displayName !== 'string' || typeof model.sourceLabel !== 'string') {
      return `The runtime returned invalid model display fields in the ${sourceProviderId} catalog.`;
    }
  }
  const qualifiedDefault = parseStrictQualifiedModelRef(response.models.defaultModelId);
  if (qualifiedDefault && qualifiedDefault.sourceId !== sourceProviderId) {
    return `The runtime returned foreign default model ${qualifiedDefault.raw} in the ${sourceProviderId} catalog.`;
  }
  if (
    response.models.defaultModelId != null &&
    !qualifyModelId(sourceProviderId, response.models.defaultModelId)
  ) {
    return `The runtime returned an invalid default model identifier in the ${sourceProviderId} catalog.`;
  }
  return null;
}

export function normalizeModelResponseDiagnostics(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === 'string')
    : [];
}

export async function loadOpenCodeScopedCatalog(
  sourceProviderId: string,
  projectPath: string | null,
  requestGroupId: string,
  isCurrentRequest: () => boolean,
  refresh = true
) {
  const modelById = new Map<string, RuntimeProviderModelDto>();
  let cursor: string | null = null;
  const defaultModelIds = new Set<string>();
  let diagnostics: readonly string[] = [];
  let sawStaleCatalog = false;
  let sawUnknownCatalogState = false;
  let sawMultiplePages = false;
  let expectedTotalCount: number | null = null;
  const seenCursors = new Set<string>();

  for (let page = 0; page < MAX_MODEL_PAGES; page += 1) {
    if (!isCurrentRequest()) {
      throw new Error('Catalog request cancelled.');
    }
    const response = await api.runtimeProviderManagement.loadModels({
      runtimeId: 'opencode',
      providerId: sourceProviderId,
      projectPath,
      query: null,
      // The current orchestrator builds the complete provider snapshot before
      // slicing it. Request that snapshot once so launch authority cannot span
      // independently refreshed pages. The loop remains for older runtimes that
      // still paginate an unbounded request.
      limit: null,
      cursor,
      refresh,
      requestGroupId,
    });
    if (!isCurrentRequest()) {
      throw new Error('Catalog request cancelled.');
    }
    const failure = responseFailure(response, sourceProviderId);
    if (failure) {
      throw new Error(failure);
    }
    const modelPage = response.models!;
    if (modelPage.cursor !== undefined) {
      const responseCursor = modelPage.cursor?.trim() || null;
      if (responseCursor !== cursor) {
        throw new Error('The runtime returned a mismatched provider-model pagination cursor.');
      }
    }
    if (
      modelPage.returnedCount !== undefined &&
      (!Number.isInteger(modelPage.returnedCount) ||
        modelPage.returnedCount < 0 ||
        modelPage.returnedCount !== modelPage.models.length)
    ) {
      throw new Error('The runtime returned an invalid provider-model page count.');
    }
    if (modelPage.totalCount !== undefined) {
      if (!Number.isInteger(modelPage.totalCount) || modelPage.totalCount < 0) {
        throw new Error('The runtime returned an invalid provider-model total count.');
      }
      if (expectedTotalCount !== null && expectedTotalCount !== modelPage.totalCount) {
        throw new Error('The runtime changed the provider-model total during pagination.');
      }
      expectedTotalCount = modelPage.totalCount;
    }
    for (const model of modelPage.models) {
      const modelId = qualifyModelId(model.providerId, model.modelId);
      if (modelId) {
        if (modelById.has(modelId)) {
          throw new Error('The runtime returned a duplicate provider model across pages.');
        }
        modelById.set(modelId, model);
      }
    }
    if (modelPage.defaultModelId) {
      const normalizedDefaultModelId = qualifyModelId(sourceProviderId, modelPage.defaultModelId);
      if (normalizedDefaultModelId) defaultModelIds.add(normalizedDefaultModelId);
    }
    diagnostics = normalizeModelResponseDiagnostics(modelPage.diagnostics);
    if (modelPage.catalogState === 'stale') {
      sawStaleCatalog = true;
    } else if (modelPage.catalogState !== 'fresh') {
      sawUnknownCatalogState = true;
    }
    const nextCursor = modelPage.nextCursor?.trim() || null;
    if (!nextCursor) {
      break;
    }
    sawMultiplePages = true;
    if (seenCursors.has(nextCursor) || page === MAX_MODEL_PAGES - 1) {
      throw new Error('The runtime returned an invalid provider-model pagination cursor.');
    }
    if (!isCurrentRequest()) {
      throw new Error('Catalog request cancelled.');
    }
    seenCursors.add(nextCursor);
    cursor = nextCursor;
  }

  if (!isCurrentRequest()) {
    throw new Error('Catalog request cancelled.');
  }
  if (defaultModelIds.size > 1) {
    throw new Error('The runtime returned conflicting provider-model catalog defaults.');
  }
  if (expectedTotalCount !== null && expectedTotalCount !== modelById.size) {
    throw new Error('The runtime returned an incomplete provider-model catalog.');
  }
  const defaultModelId = defaultModelIds.values().next().value ?? null;
  if (defaultModelId && !modelById.has(defaultModelId)) {
    throw new Error('The runtime returned a default outside the provider-model catalog.');
  }
  const completedAt = new Date().toISOString();
  // Separate page requests have no shared generation token in the compatibility
  // contract. Keep their models usable for display, but never grant fresh launch
  // authority to a response that may have crossed catalog generations.
  const catalogState: 'fresh' | 'stale' | null =
    sawUnknownCatalogState || sawMultiplePages ? null : sawStaleCatalog ? 'stale' : 'fresh';

  return {
    models: Array.from(modelById.values()),
    defaultModelId,
    diagnostics,
    catalogState,
    completedAt,
    freshUntil:
      catalogState === 'fresh'
        ? new Date(Date.parse(completedAt) + MODEL_CATALOG_FRESHNESS_MS).toISOString()
        : null,
  };
}
