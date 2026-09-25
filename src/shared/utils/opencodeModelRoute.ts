import { parseOpenCodeQualifiedModelRef } from './opencodeModelRef';

const OPEN_CODE_LOCAL_PROVIDER_IDS = new Set([
  'atomic-chat',
  'llama.cpp',
  'llamacpp',
  'lmstudio',
  'lm-studio',
  'local',
  'ollama',
  'vllm',
]);

export type OpenCodeModelRoutePresentationStatus =
  | 'connected'
  | 'configured'
  | 'local'
  | 'free'
  | null;

export interface OpenCodeModelRouteFacts {
  modelId?: string | null;
  catalogId?: string | null;
  providerId?: string | null;
  routeKind?: string | null;
  accessKind?: string | null;
  free?: boolean | null;
  badgeLabel?: string | null;
}

function normalizeProviderId(providerId: string | null | undefined): string | null {
  const normalized = providerId?.trim().toLowerCase();
  return normalized || null;
}

function resolveOpenCodeModelSourceId(input: OpenCodeModelRouteFacts): string | null {
  return (
    normalizeProviderId(input.providerId) ??
    parseOpenCodeQualifiedModelRef(input.modelId)?.sourceId ??
    parseOpenCodeQualifiedModelRef(input.catalogId)?.sourceId ??
    null
  );
}

export function isOpenCodeLocalProviderId(providerId: string | null | undefined): boolean {
  const normalized = normalizeProviderId(providerId);
  return normalized ? OPEN_CODE_LOCAL_PROVIDER_IDS.has(normalized) : false;
}

export function isKnownConfiguredLocalOpenCodeCatalogModel(
  modelId: string | null | undefined,
  catalogModel?: {
    id?: string | null;
    launchModel?: string | null;
    metadata?: {
      opencode?: {
        providerId?: string | null;
        routeKind?: string | null;
        accessKind?: string | null;
      } | null;
    } | null;
  } | null
): boolean {
  const route = catalogModel?.metadata?.opencode;
  return (
    getOpenCodeModelRoutePresentationStatus({
      modelId: modelId ?? catalogModel?.launchModel,
      catalogId: catalogModel?.id,
      providerId: route?.providerId,
      routeKind: route?.routeKind,
      accessKind: route?.accessKind,
    }) === 'local'
  );
}

export function countConfiguredLocalOpenCodeCatalogModels(
  models: readonly {
    id?: string | null;
    launchModel?: string | null;
    metadata?: {
      opencode?: {
        providerId?: string | null;
        routeKind?: string | null;
        accessKind?: string | null;
      } | null;
    } | null;
  }[]
): number {
  const ids = new Set<string>();
  for (const model of models) {
    if (!isKnownConfiguredLocalOpenCodeCatalogModel(model.launchModel, model)) {
      continue;
    }
    const id = model.launchModel?.trim() || model.id?.trim();
    if (id) {
      ids.add(id);
    }
  }
  return ids.size;
}

export function getOpenCodeModelRoutePresentationStatus(
  input: OpenCodeModelRouteFacts
): OpenCodeModelRoutePresentationStatus {
  switch (input.routeKind) {
    case 'connected_provider':
      return 'connected';
    case 'configured_local':
      return isOpenCodeLocalProviderId(resolveOpenCodeModelSourceId(input))
        ? 'local'
        : 'configured';
    case 'builtin_free':
      return 'free';
    default:
      return null;
  }
}

export function hasExplicitFreeOpenCodeModelId(modelId: string | null | undefined): boolean {
  const normalized = modelId?.trim().toLowerCase() ?? '';
  return (
    normalized === 'opencode/big-pickle' ||
    normalized.includes(':free') ||
    normalized.endsWith('-free') ||
    normalized.endsWith('/free')
  );
}

// A model id alone never proves a route is accessible without a key (see
// isOpenCodeRouteAccessFreeWithoutKey). Big Pickle is the one route the
// runtime's own strict-profile allowlist already treats as access-free, so it
// is safe to surface before the metadata-rich catalog has loaded. Do not
// extend this to a suffix pattern: "-free" in a name is a price hint, not an
// access guarantee, and OpenCode Go route names use the same convention.
export function isKnownOpenCodeAccessFreeModelId(modelId: string | null | undefined): boolean {
  return modelId?.trim().toLowerCase() === 'opencode/big-pickle';
}

export function isOpenCodeModelExplicitlyFree(input: OpenCodeModelRouteFacts): boolean {
  const hasFreeModelId =
    hasExplicitFreeOpenCodeModelId(input.modelId) ||
    hasExplicitFreeOpenCodeModelId(input.catalogId);
  if (input.routeKind === 'builtin_free' || input.accessKind === 'builtin_free' || hasFreeModelId) {
    return true;
  }

  // Connected cloud and configured routes can inherit zero prices or a stale
  // Free badge from catalog transport. Neither proves that the user's route is
  // free. Explicit free model IDs above remain authoritative.
  if (input.routeKind === 'connected_provider' || input.routeKind === 'configured_local') {
    return false;
  }

  return input.free === true || input.badgeLabel?.trim().toLowerCase() === 'free';
}

export function isOpenCodeRouteAccessFreeWithoutKey(input: OpenCodeModelRouteFacts): boolean {
  // Access is a stronger claim than price: it means the route works without
  // connecting any provider. Only the live catalog's builtin_free route proves
  // that. OpenCode Go always requires an active subscription key even when a
  // specific model is priced at zero, and a name that merely looks free (e.g.
  // ends in "-free") must never be trusted for this claim.
  //
  // routeKind is the catalog's static category for the route; accessKind is
  // the live, checked result and can disagree with it (e.g. a builtin_free
  // route whose strict-profile probe just failed). accessKind wins whenever
  // it reports an actual blocker, so a stale or optimistic routeKind can
  // never claim the route is usable when the live check says otherwise.
  if (input.accessKind === 'not_authenticated' || input.accessKind === 'execution_failed') {
    return false;
  }
  return input.routeKind === 'builtin_free' || input.accessKind === 'builtin_free';
}
