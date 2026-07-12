import { api } from '@renderer/api';
import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';

import type {
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderModelDto,
} from '../contracts';

const PROJECT_MODELS_CACHE_TTL_MS = 30_000;
const PROJECT_MODELS_LIMIT = 50;

interface ProjectModelsCacheEntry {
  expiresAt: number;
  promise: Promise<RuntimeProviderManagementModelsResponse>;
}

const projectModelsCache = new Map<string, ProjectModelsCacheEntry>();

export interface OpenCodeLocalModelLimitSuggestion {
  providerId: string;
  modelId: string;
  displayName: string;
  contextTokens: number | null;
  outputTokens: number | null;
  managed: boolean;
}

export function resolveOpenCodeLocalProviderId(selectedModel: string): string | null {
  return parseOpenCodeQualifiedModelRef(selectedModel.trim())?.sourceId ?? null;
}

export function resolveOpenCodeLocalModelLimitSuggestion(
  models: readonly RuntimeProviderModelDto[] | null | undefined,
  selectedModel: string
): OpenCodeLocalModelLimitSuggestion | null {
  const modelId = selectedModel.trim();
  if (!modelId) return null;
  const model = models?.find((candidate) => candidate.modelId === modelId);
  if (!model || model.routeKind !== 'configured_local') return null;
  const providerId = model.providerId.trim() || resolveOpenCodeLocalProviderId(modelId);
  if (!providerId) return null;
  const managed = model.managedContextTokens != null && model.managedOutputTokens != null;
  return {
    providerId,
    modelId,
    displayName: model.displayName.trim() || modelId,
    contextTokens: managed ? model.managedContextTokens! : (model.catalogContextTokens ?? null),
    outputTokens: managed ? model.managedOutputTokens! : (model.catalogOutputTokens ?? null),
    managed,
  };
}

function getProjectModelsCachePrefix(projectPath: string, providerId: string): string {
  return `${projectPath.trim()}\u0000${providerId.trim()}\u0000`;
}

function getProjectModelsCacheKey(
  projectPath: string,
  providerId: string,
  modelId: string
): string {
  return `${getProjectModelsCachePrefix(projectPath, providerId)}${modelId.trim()}`;
}

export function invalidateOpenCodeProjectModels(projectPath: string, providerId: string): void {
  const prefix = getProjectModelsCachePrefix(projectPath, providerId);
  for (const cacheKey of projectModelsCache.keys()) {
    if (cacheKey.startsWith(prefix)) projectModelsCache.delete(cacheKey);
  }
}

export function loadOpenCodeProjectModels(input: {
  projectPath: string;
  providerId: string;
  modelId: string;
  refresh?: boolean;
}): Promise<RuntimeProviderManagementModelsResponse> {
  const projectPath = input.projectPath.trim();
  const providerId = input.providerId.trim();
  const modelId = input.modelId.trim();
  const cacheKey = getProjectModelsCacheKey(projectPath, providerId, modelId);
  if (input.refresh) {
    projectModelsCache.delete(cacheKey);
  } else {
    const cached = projectModelsCache.get(cacheKey);
    if (cached && cached.expiresAt > Date.now()) return cached.promise;
  }

  const entry = {} as ProjectModelsCacheEntry;
  const promise = api.runtimeProviderManagement
    .loadModels({
      runtimeId: 'opencode',
      providerId,
      projectPath,
      query: modelId,
      limit: PROJECT_MODELS_LIMIT,
    })
    .then((response) => {
      if (response.error && projectModelsCache.get(cacheKey) === entry) {
        projectModelsCache.delete(cacheKey);
      } else if (projectModelsCache.get(cacheKey) === entry) {
        entry.expiresAt = Date.now() + PROJECT_MODELS_CACHE_TTL_MS;
      }
      return response;
    })
    .catch((error: unknown) => {
      if (projectModelsCache.get(cacheKey) === entry) {
        projectModelsCache.delete(cacheKey);
      }
      throw error;
    });
  entry.expiresAt = Number.POSITIVE_INFINITY;
  entry.promise = promise;
  projectModelsCache.set(cacheKey, entry);
  return promise;
}
