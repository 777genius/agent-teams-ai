import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';

import { RUNTIME_PROVIDER_ONBOARDING_PLANS } from './runtimeProviderOnboarding';

import type {
  OpenCodeGeneration,
  RuntimeProviderOnboardingPlan,
} from './runtimeProviderOnboarding';
import type { CliProviderStatus } from '@shared/types/cliInstaller';

/** Issue code for a selected model that OpenCode V2 provably cannot run. */
export const OPENCODE_MODEL_NOT_IN_V2_CATALOG_CODE = 'model_not_in_v2_catalog';

export interface OpenCodeV2ModelBlock {
  readonly modelId: string;
  /** Why the model cannot run, without the model id. */
  readonly reason: string;
  /** The full line for the user, naming the model. */
  readonly message: string;
}

/**
 * Whether a model_only status carries a V2 catalog the runtime read successfully. Main and
 * the renderer mark every model_only catalog stale with refresh state error, since it never
 * grants launch, so the catalog's own status label says nothing here. The runtime's read
 * diagnostics survive that projection: V2 reports model_only only after a successful catalog
 * read (config ready, app server healthy); a failed read is a transient error.
 */
export function isLoadedOpenCodeV2Catalog(provider: CliProviderStatus | null | undefined): boolean {
  const catalog = provider?.modelCatalog;
  return (
    provider?.providerId === 'opencode' &&
    provider.supported &&
    provider.statusCheckOutcome === 'model_only' &&
    provider.statusCheckErrorCode == null &&
    catalog?.providerId === 'opencode' &&
    catalog.source === 'app-server' &&
    catalog.diagnostics.configReadState === 'ready' &&
    catalog.diagnostics.appServerState === 'healthy' &&
    catalog.models.length > 0
  );
}

function catalogListsProvider(provider: CliProviderStatus, providerId: string): boolean {
  return (provider.modelCatalog?.models ?? []).some(
    (model) =>
      parseOpenCodeQualifiedModelRef(model.launchModel)?.sourceId === providerId ||
      parseOpenCodeQualifiedModelRef(model.id)?.sourceId === providerId
  );
}

function buildV1PlanIdReason(
  plan: RuntimeProviderOnboardingPlan,
  provider: CliProviderStatus
): string {
  const routeIds = (plan.routes ?? []).map((route) => route.v2ProviderId);
  // The status catalog is read without credentials, so a listed route says only that this V2
  // release has it, not that it is connected. V2 2.0.0 has no Kimi integrations at all.
  if (!routeIds.some((id) => catalogListsProvider(provider, id))) {
    return `${plan.displayName} is not available as ${plan.providerId} in OpenCode V2. Pick a model from the V2 catalog.`;
  }
  return (
    `${plan.displayName} uses different provider ids in OpenCode V2 (${routeIds.join(' / ')}). ` +
    `Pick a model under one of them; connect ${plan.displayName} first if you have not.`
  );
}

/**
 * Selected models that OpenCode V2 provably cannot run: the V1 provider id of a plan that V2
 * serves only through other ids (Kimi Code Membership is kimi-code-plan-cn /
 * kimi-code-plan-global on V2, never kimi-for-coding), when the loaded V2 catalog has no such
 * provider at all.
 *
 * Nothing else is judged. The status catalog is built from the bundled snapshot and the project
 * config only, while a launch also imports the user's global config, so a model missing from
 * the catalog may still run. V1, unqualified ids, other providers and a catalog that cannot
 * judge stay with deep verification.
 */
export function findOpenCodeModelsBlockedOnV2(input: {
  readonly generation: OpenCodeGeneration;
  readonly providerStatus: CliProviderStatus | null | undefined;
  readonly modelIds: readonly string[];
}): readonly OpenCodeV2ModelBlock[] {
  if (input.generation !== 'v2') return [];
  const candidates = input.modelIds.flatMap((modelId) => {
    const sourceId = parseOpenCodeQualifiedModelRef(modelId)?.sourceId;
    const plan = RUNTIME_PROVIDER_ONBOARDING_PLANS.find(
      (entry) => entry.providerId === sourceId && entry.routes?.length
    );
    return plan ? [{ modelId, plan }] : [];
  });
  const provider = input.providerStatus;
  if (candidates.length === 0 || !provider || !isLoadedOpenCodeV2Catalog(provider)) return [];
  return candidates.flatMap(({ modelId, plan }) => {
    if (catalogListsProvider(provider, plan.providerId)) return [];
    const reason = buildV1PlanIdReason(plan, provider);
    return [{ modelId, reason, message: `Selected model ${modelId} is unavailable. ${reason}` }];
  });
}
