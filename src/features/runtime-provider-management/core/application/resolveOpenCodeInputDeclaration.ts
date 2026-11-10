import { parseStrictQualifiedModelRef, qualifyModelId } from '../domain/openCodeModelIdentity';

import { loadOpenCodeScopedCatalog } from './loadOpenCodeScopedCatalog';

import type { RuntimeProviderManagementApi } from '../../contracts';

/** Reads the existing scoped catalog/cache; failures never grant media authority. */
export function createOpenCodeInputDeclarationResolver(
  loadModels: RuntimeProviderManagementApi['loadModels']
) {
  return async ({
    projectPath,
    model,
  }: {
    projectPath: string;
    model: string;
  }): Promise<readonly string[] | null> => {
    const identity = parseStrictQualifiedModelRef(model);
    if (!identity || !projectPath.trim()) return null;
    try {
      const catalog = await loadOpenCodeScopedCatalog(
        loadModels,
        identity.sourceId,
        projectPath,
        undefined,
        () => true,
        false
      );
      if (!catalog.freshUntil || Date.parse(catalog.freshUntil) <= Date.now()) return null;
      const row = catalog.models.find(
        (candidate) => qualifyModelId(candidate.providerId, candidate.modelId) === identity.raw
      );
      return row?.declaredInputModalities ?? null;
    } catch {
      return null;
    }
  };
}
