import { parseOpenCodeQualifiedModelRef } from '@shared/utils/opencodeModelRef';

import { RUNTIME_PROVIDER_ONBOARDING_PLANS } from './runtimeProviderOnboarding';

import type { OpenCodeGeneration } from './runtimeProviderOnboarding';
import type { CliProviderStatus } from '@shared/types/cliInstaller';

/** Issue code for a selected model that the loaded OpenCode V2 catalog does not list. */
export const OPENCODE_MODEL_NOT_IN_V2_CATALOG_CODE = 'model_not_in_v2_catalog';

export interface OpenCodeModelNotInV2Catalog {
  readonly modelId: string;
  /** Why the model cannot run, without the model id. */
  readonly reason: string;
  /** The full line for the user, naming the model. */
  readonly message: string;
}

/**
 * Model ids of a loaded OpenCode V2 catalog, or null when it cannot judge a selection.
 * The V2 status reports model_only only after its native catalog read succeeded; an empty
 * or unready catalog proves nothing.
 */
function readOpenCodeV2CatalogModelIds(
  provider: CliProviderStatus | null | undefined
): ReadonlySet<string> | null {
  const catalog = provider?.modelCatalog;
  if (
    provider?.providerId !== 'opencode' ||
    provider.statusCheckOutcome !== 'model_only' ||
    provider.statusCheckErrorCode != null ||
    provider.modelCatalogRefreshState !== 'ready' ||
    catalog?.providerId !== 'opencode' ||
    catalog.status !== 'ready' ||
    catalog.models.length === 0
  ) {
    return null;
  }
  return new Set(catalog.models.flatMap((model) => [model.id.trim(), model.launchModel.trim()]));
}

function buildOpenCodeModelNotInV2CatalogReason(sourceId: string): string {
  // A plan with routes is served by V2 under other provider ids (Kimi Code Membership).
  const plan = RUNTIME_PROVIDER_ONBOARDING_PLANS.find(
    (entry) => entry.providerId === sourceId && entry.routes?.length
  );
  const v2ProviderIds = plan?.routes?.map((route) => route.v2ProviderId) ?? [];
  const cause = plan
    ? `OpenCode V2 serves ${plan.displayName} under different provider ids: ${v2ProviderIds.join(' or ')}.`
    : 'Its provider may be missing in V2 or use a different id there.';
  return `This model is not in the OpenCode V2 model catalog. ${cause} Pick a model from the V2 catalog.`;
}

/**
 * Selected models that a loaded OpenCode V2 catalog does not list. V2 cannot run them: some of
 * its provider ids differ from V1 and there is no reliable mapping between them, so the user
 * has to pick a V2 model. Empty on V1, for an unqualified id, and while the catalog cannot
 * judge (not loaded, refreshing or empty).
 */
export function findOpenCodeModelsNotInV2Catalog(input: {
  readonly generation: OpenCodeGeneration;
  readonly providerStatus: CliProviderStatus | null | undefined;
  readonly modelIds: readonly string[];
}): readonly OpenCodeModelNotInV2Catalog[] {
  if (input.generation !== 'v2') return [];
  const catalogModelIds = readOpenCodeV2CatalogModelIds(input.providerStatus);
  if (!catalogModelIds) return [];
  return input.modelIds.flatMap((modelId) => {
    const parsed = parseOpenCodeQualifiedModelRef(modelId);
    if (!parsed || catalogModelIds.has(modelId.trim()) || catalogModelIds.has(parsed.raw)) {
      return [];
    }
    const reason = buildOpenCodeModelNotInV2CatalogReason(parsed.sourceId);
    return [{ modelId, reason, message: `Selected model ${modelId} is unavailable. ${reason}` }];
  });
}
