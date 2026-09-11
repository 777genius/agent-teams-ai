import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';
import {
  isKnownConfiguredLocalOpenCodeCatalogModel,
  isOpenCodeLocalProviderId,
} from '@shared/utils/opencodeModelRoute';

interface CatalogModel {
  id?: string | null;
  launchModel?: string | null;
  metadata?: {
    opencode?: {
      providerId?: string | null;
      routeKind?: string | null;
      accessKind?: string | null;
    } | null;
  } | null;
}

export const OPENCODE_COMPANION_SOURCE_IDS = new Set(['cursor-acp', 'kiro']);

export function isAppManagedOpenCodeLocalModel(
  modelId: string,
  catalogModel: CatalogModel | null | undefined
): boolean {
  const route = catalogModel?.metadata?.opencode;
  const sourceId =
    route?.providerId?.trim().toLowerCase() ||
    parseOpenCodeQualifiedModelRef(modelId)?.sourceId ||
    null;
  // OpenCode currently reports Cursor ACP and Kiro as configured_authless.
  // They are companion runtimes, not local OpenAI-compatible servers managed by this app.
  if (sourceId && OPENCODE_COMPANION_SOURCE_IDS.has(sourceId)) {
    return false;
  }
  if (!route) {
    return isOpenCodeLocalProviderId(sourceId);
  }
  if (route.routeKind !== 'configured_local') {
    return false;
  }

  return route.accessKind !== 'credentialed' || modelId.startsWith('local/');
}

export function shouldRetainOpenCodeLocalCatalogModel(
  modelId: string,
  catalogModel: CatalogModel | null | undefined,
  overlayModelIds: ReadonlySet<string>
): boolean {
  if (
    overlayModelIds.has(modelId) ||
    (catalogModel?.launchModel && overlayModelIds.has(catalogModel.launchModel)) ||
    (catalogModel?.id && overlayModelIds.has(catalogModel.id))
  ) {
    return true;
  }
  return isKnownConfiguredLocalOpenCodeCatalogModel(modelId, catalogModel);
}
