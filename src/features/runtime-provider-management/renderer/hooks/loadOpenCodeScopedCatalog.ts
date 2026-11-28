import { api } from '@renderer/api';

import { loadOpenCodeScopedCatalog as loadScopedCatalog } from '../../core/application/loadOpenCodeScopedCatalog';

import type { RuntimeProviderManagementApi } from '../../contracts';

export {
  MODEL_CATALOG_FRESHNESS_MS,
  normalizeModelResponseDiagnostics,
} from '../../core/application/loadOpenCodeScopedCatalog';
export function loadOpenCodeScopedCatalog(
  sourceProviderId: string,
  projectPath: string | null,
  requestGroupId: string,
  isCurrentRequest: () => boolean,
  refresh = true,
  loadModels: RuntimeProviderManagementApi['loadModels'] = (request) =>
    api.runtimeProviderManagement.loadModels(request)
) {
  return loadScopedCatalog(
    loadModels,
    sourceProviderId,
    projectPath,
    requestGroupId,
    isCurrentRequest,
    refresh
  );
}
