import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';
import {
  findEquivalentOpenRouterModelIds,
  isOpenCodeLocalProviderId,
} from '@shared/utils/opencodeModelRoute';

import { RUNTIME_PROVIDER_ONBOARDING_PLANS } from './runtimeProviderOnboarding';

import type { OpenCodeGeneration } from './runtimeProviderOnboarding';
import type { CliProviderStatus } from '@shared/types/cliInstaller';

/** Issue code for a selected model that OpenCode V2 provably cannot run. */
export const OPENCODE_MODEL_NOT_IN_V2_CATALOG_CODE = 'model_not_in_v2_catalog';

/** Models of a V2 catalog that the runtime read for this project, by provider id. */
export interface OpenCodeV2Catalog {
  readonly modelIdsByProviderId: ReadonlyMap<string, ReadonlySet<string>>;
  readonly modelIds: readonly string[];
}

export interface OpenCodeV2ModelBlock {
  readonly modelId: string;
  /** Why the model cannot run, without the model id. */
  readonly reason: string;
  /** The full line for the user, naming the model. */
  readonly message: string;
}

/**
 * The V2 catalog of a model_only status, or null when the status cannot judge a selection.
 * Main and the renderer mark every model_only catalog stale with refresh state error, since
 * it never grants launch, so the catalog's own status label says nothing here. The runtime's
 * read diagnostics survive that projection: V2 reports model_only only after a successful
 * catalog read (config ready, app server healthy); a failed read is a transient error.
 */
export function readLoadedOpenCodeV2Catalog(
  provider: CliProviderStatus | null | undefined
): OpenCodeV2Catalog | null {
  const catalog = provider?.modelCatalog;
  if (
    provider?.providerId !== 'opencode' ||
    !provider.supported ||
    provider.statusCheckOutcome !== 'model_only' ||
    provider.statusCheckErrorCode != null ||
    catalog?.providerId !== 'opencode' ||
    catalog.source !== 'app-server' ||
    catalog.diagnostics.configReadState !== 'ready' ||
    catalog.diagnostics.appServerState !== 'healthy'
  ) {
    return null;
  }
  const modelIdsByProviderId = new Map<string, Set<string>>();
  const modelIds: string[] = [];
  for (const model of catalog.models) {
    for (const id of new Set([model.id.trim(), model.launchModel.trim()])) {
      const parsed = parseOpenCodeQualifiedModelRef(id);
      if (!parsed) continue;
      const providerModelIds = modelIdsByProviderId.get(parsed.sourceId) ?? new Set<string>();
      providerModelIds.add(parsed.raw);
      modelIdsByProviderId.set(parsed.sourceId, providerModelIds);
      modelIds.push(parsed.raw);
    }
  }
  // An empty catalog proves nothing about any provider.
  return modelIdsByProviderId.size > 0 ? { modelIdsByProviderId, modelIds } : null;
}

function buildV1PlanIdReason(
  plan: (typeof RUNTIME_PROVIDER_ONBOARDING_PLANS)[number],
  catalog: OpenCodeV2Catalog
): string {
  const routes = plan.routes ?? [];
  const routeIds = routes.map((route) => route.v2ProviderId);
  const listedRouteIds = routeIds.filter((id) => catalog.modelIdsByProviderId.has(id));
  const hosts = routes.map((route) => route.host).join(' or ');
  // A connected route always has catalog models, so no listed route means none is connected.
  const next = listedRouteIds.length
    ? `Pick its model under ${listedRouteIds.join(' or ')} in the V2 catalog instead.`
    : `Connect ${plan.displayName} for OpenCode V2 in the provider settings (${hosts}), then pick its model.`;
  return (
    `${plan.displayName} uses a different provider id in OpenCode V2 ` +
    `(${routeIds.join(' / ')}), so this V1 model id cannot run there. ${next}`
  );
}

/**
 * Selected models that OpenCode V2 provably cannot run, judged against the catalog V2 read
 * for this project. Only two cases count:
 * - the V1 provider id of a plan that V2 serves through other ids (Kimi Code Membership is
 *   kimi-code-plan-cn / kimi-code-plan-global on V2, never kimi-for-coding);
 * - a provider the catalog lists, without the selected model or an OpenRouter equivalent.
 * Everything else stays with deep verification: V1, an unqualified id, a local route, a
 * provider the catalog does not know, and a catalog that cannot judge.
 */
export function findOpenCodeModelsBlockedOnV2(input: {
  readonly generation: OpenCodeGeneration;
  readonly catalog: OpenCodeV2Catalog | null;
  readonly modelIds: readonly string[];
}): readonly OpenCodeV2ModelBlock[] {
  const { catalog } = input;
  if (input.generation !== 'v2' || !catalog) return [];
  return input.modelIds.flatMap((modelId) => {
    const parsed = parseOpenCodeQualifiedModelRef(modelId);
    if (!parsed || isOpenCodeLocalProviderId(parsed.sourceId)) return [];
    const providerModelIds = catalog.modelIdsByProviderId.get(parsed.sourceId);
    let reason: string;
    if (!providerModelIds) {
      const plan = RUNTIME_PROVIDER_ONBOARDING_PLANS.find(
        (entry) => entry.providerId === parsed.sourceId && entry.routes?.length
      );
      if (!plan) return [];
      reason = buildV1PlanIdReason(plan, catalog);
    } else {
      if (
        providerModelIds.has(parsed.raw) ||
        findEquivalentOpenRouterModelIds(parsed.raw, catalog.modelIds).length > 0
      ) {
        return [];
      }
      reason =
        `OpenCode V2 lists the provider ${parsed.sourceId}, but not this model. ` +
        'Pick one of its models from the V2 catalog.';
    }
    return [{ modelId, reason, message: `Selected model ${modelId} is unavailable. ${reason}` }];
  });
}
