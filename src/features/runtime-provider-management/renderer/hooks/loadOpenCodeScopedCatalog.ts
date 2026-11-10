import { api } from '@renderer/api';

import { loadOpenCodeScopedCatalog as loadScopedCatalog } from '../../core/application/loadOpenCodeScopedCatalog';
export {
  MODEL_CATALOG_FRESHNESS_MS,
  normalizeModelResponseDiagnostics,
} from '../../core/application/loadOpenCodeScopedCatalog';
export function loadOpenCodeScopedCatalog(
  sourceProviderId: string,
  projectPath: string | null,
  requestGroupId: string,
  isCurrentRequest: () => boolean,
  refresh = true
) {
  return loadScopedCatalog(
    (request) => api.runtimeProviderManagement.loadModels(request),
    sourceProviderId,
    projectPath,
    requestGroupId,
    isCurrentRequest,
    refresh
  );
}
