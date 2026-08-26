import {
  resolveAnthropicFastMode,
  resolveAnthropicRuntimeSelection,
} from '@features/anthropic-runtime-profile/main';
import {
  resolveCodexFastMode,
  resolveCodexRuntimeSelection,
} from '@features/codex-runtime-profile/main';
import {
  type EffortLevel,
  type ProviderModelLaunchIdentity,
  type TeamLeadRuntimeSelectionProvenance,
  type TeamProviderBackendId,
  type TeamProviderId,
} from '@shared/types';
import { resolveAnthropicLaunchModel } from '@shared/utils/anthropicLaunchModel';
import {
  getDefaultProviderBackendId,
  migrateProviderBackendId,
} from '@shared/utils/providerBackend';
import { inferProviderBillingMode } from '@shared/utils/providerBillingMode';
import {
  isResolvedLeadRuntimeSelectionProvenance,
  resolveLeadRuntimeSelectionProvenance,
} from '@shared/utils/teamMemberRuntimeSelectionProvenance';

import { resolveTeamProviderId } from '../../runtime/providerRuntimeEnv';

import {
  getExplicitLaunchModelSelection,
  type LeadRuntimeSelectionRequest,
} from './TeamProvisioningMemberSpecs';

import type { RuntimeProviderLaunchFacts } from './TeamProvisioningRuntimeLaunchSelection';

type ResolvedLeadRuntimeSelectionProvenance = TeamLeadRuntimeSelectionProvenance & {
  providerBackendId: 'default' | 'explicit';
  model: 'default' | 'explicit';
  effort: 'default' | 'explicit';
};

export interface RuntimeSelectionIntent {
  provenance: ResolvedLeadRuntimeSelectionProvenance;
  providerBackendId: TeamProviderBackendId | undefined;
  model: string | undefined;
  effort: EffortLevel | undefined;
}

function concreteBackendSnapshot(
  providerId: TeamProviderId,
  value: TeamProviderBackendId | null | undefined
): TeamProviderBackendId | undefined {
  if (value == null) return undefined;
  const normalized = migrateProviderBackendId(providerId, value, 'explicit-selection');
  if (!normalized) throw new Error('Runtime backend snapshot is incompatible with its provider');
  return normalized;
}

export function getExactCatalogModelForLaunchSelection(
  facts: Pick<RuntimeProviderLaunchFacts, 'modelCatalog'>,
  explicitModel: string | undefined
): NonNullable<RuntimeProviderLaunchFacts['modelCatalog']>['models'][number] | null {
  const catalog = facts.modelCatalog;
  if (!catalog) return null;
  if (explicitModel) {
    return (
      catalog.models.find(
        (model) => model.launchModel === explicitModel || model.id === explicitModel
      ) ?? null
    );
  }
  return (
    catalog.models.find((model) => model.id === catalog.defaultModelId) ??
    catalog.models.find((model) => model.launchModel === catalog.defaultLaunchModel) ??
    catalog.models.find((model) => model.isDefault) ??
    null
  );
}

export function hasAuthoritativeGenericLaunchCatalog(
  facts: Pick<RuntimeProviderLaunchFacts, 'modelIds' | 'modelListParsed' | 'modelCatalog'>
): boolean {
  if (facts.modelListParsed === true && facts.modelIds.size > 0) return true;
  const catalog = facts.modelCatalog;
  return Boolean(
    catalog &&
    catalog.source !== 'static-fallback' &&
    catalog.status === 'ready' &&
    catalog.models.some(
      (model) => !model.hidden && Boolean(model.launchModel.trim() || model.id.trim())
    )
  );
}

function requireExplicitValue<T>(value: T | null | undefined, axis: string): T {
  if (value == null || (typeof value === 'string' && value.trim().length === 0)) {
    throw new Error(`Explicit runtime ${axis} selection is missing its exact value`);
  }
  return value;
}

export function resolveRuntimeSelectionIntent(
  request: LeadRuntimeSelectionRequest
): RuntimeSelectionIntent {
  const provenance = resolveLeadRuntimeSelectionProvenance(request);
  if (!isResolvedLeadRuntimeSelectionProvenance(provenance)) {
    throw new Error(
      `Runtime selection provenance is ${provenance.unknownReason ?? 'unknown'}; choose backend, model, and effort again`
    );
  }
  const providerId = resolveTeamProviderId(request.providerId);
  // Concrete values on default axes are preparation snapshots. Keep the UI
  // intent as default, but pin runtime resolution to the exact identity that
  // was proved instead of re-reading mutable defaults before invocation.
  const providerBackendId = concreteBackendSnapshot(providerId, request.providerBackendId);
  if (provenance.providerBackendId === 'explicit' && !providerBackendId) {
    requireExplicitValue(providerBackendId, 'backend');
  }
  const model = getExplicitLaunchModelSelection(request.model);
  if (provenance.model === 'explicit' && !model) requireExplicitValue(model, 'model');
  const effort = request.effort;
  if (provenance.effort === 'explicit' && !effort) requireExplicitValue(effort, 'effort');
  return { provenance, providerBackendId, model, effort };
}

function currentDefaultBackend(
  providerId: TeamProviderId,
  facts: RuntimeProviderLaunchFacts
): TeamProviderBackendId | null {
  if (providerId === 'anthropic') return null;
  const status = facts.providerStatus;
  for (const candidate of [
    status?.resolvedBackendId,
    status?.selectedBackendId,
    status?.backend?.kind,
    getDefaultProviderBackendId(providerId),
  ]) {
    const normalized = migrateProviderBackendId(providerId, candidate, 'explicit-selection');
    if (normalized) return normalized;
  }
  return null;
}

function billingMode(
  providerId: TeamProviderId,
  providerBackendId: TeamProviderBackendId | null,
  facts: RuntimeProviderLaunchFacts,
  model: string | null,
  catalogModel?: NonNullable<RuntimeProviderLaunchFacts['modelCatalog']>['models'][number] | null
) {
  return inferProviderBillingMode({
    providerId,
    providerBackendId,
    authMethod: facts.providerStatus?.authMethod,
    authMethodDetail: facts.providerStatus?.backend?.authMethodDetail,
    backendKind: facts.providerStatus?.backend?.kind,
    selectedBackendId: facts.providerStatus?.selectedBackendId,
    resolvedBackendId: facts.providerStatus?.resolvedBackendId,
    authenticated: facts.providerStatus?.authenticated,
    model,
    catalogModel,
  });
}

export function buildProviderModelLaunchIdentity(params: {
  request: LeadRuntimeSelectionRequest;
  facts: RuntimeProviderLaunchFacts;
  anthropicFastModeDefault: boolean;
}): ProviderModelLaunchIdentity {
  const providerId = resolveTeamProviderId(params.request.providerId);
  const intent = resolveRuntimeSelectionIntent(params.request);
  const resolvedFallbackModel =
    providerId === 'anthropic'
      ? resolveAnthropicLaunchModel({
          selectedModel: intent.model,
          limitContext: params.request.limitContext === true,
          availableLaunchModels: params.facts.modelIds,
          defaultLaunchModel: params.facts.defaultModel,
        })
      : (intent.model ?? params.facts.defaultModel);

  if (providerId === 'anthropic') {
    const selection = resolveAnthropicRuntimeSelection({
      source: {
        modelCatalog: params.facts.modelCatalog,
        runtimeCapabilities: params.facts.runtimeCapabilities,
      },
      selectedModel: intent.model,
      limitContext: params.request.limitContext === true,
      availableLaunchModels: params.facts.modelCatalog ? undefined : params.facts.modelIds,
    });
    const resolvedLaunchModel = selection.resolvedLaunchModel ?? resolvedFallbackModel;
    const resolvedEffort = intent.effort ?? null;
    const fast = resolveAnthropicFastMode({
      selection,
      selectedFastMode: params.request.fastMode,
      providerFastModeDefault: params.anthropicFastModeDefault,
    });
    return {
      providerId,
      providerBackendId: intent.providerBackendId ?? null,
      billingMode: billingMode(
        providerId,
        intent.providerBackendId ?? null,
        params.facts,
        resolvedLaunchModel,
        selection.catalogModel
      ),
      selectedModel: intent.provenance.model === 'explicit' ? (intent.model ?? null) : null,
      selectedModelKind: intent.provenance.model,
      resolvedLaunchModel,
      catalogId: selection.catalogModel?.id.trim() || resolvedLaunchModel,
      catalogSource: selection.catalogSource,
      catalogFetchedAt: selection.catalogFetchedAt,
      selectedEffort: intent.provenance.effort === 'explicit' ? (intent.effort ?? null) : null,
      resolvedEffort,
      selectedFastMode: params.request.fastMode ?? 'inherit',
      resolvedFastMode: fast.resolvedFastMode,
      fastResolutionReason: fast.disabledReason,
    };
  }

  if (providerId === 'codex') {
    const selection = resolveCodexRuntimeSelection({
      source: {
        providerStatus: params.facts.providerStatus,
        providerBackendId: intent.providerBackendId,
      },
      selectedModel: intent.model,
    });
    const resolvedLaunchModel = selection.resolvedLaunchModel ?? resolvedFallbackModel;
    const providerBackendId = intent.providerBackendId ?? selection.providerBackendId;
    const resolvedEffort = intent.effort ?? null;
    const fast = resolveCodexFastMode({ selection, selectedFastMode: params.request.fastMode });
    return {
      providerId,
      providerBackendId,
      billingMode: billingMode(
        providerId,
        providerBackendId,
        params.facts,
        resolvedLaunchModel,
        selection.catalogModel
      ),
      selectedModel: intent.provenance.model === 'explicit' ? (intent.model ?? null) : null,
      selectedModelKind: intent.provenance.model,
      resolvedLaunchModel,
      catalogId: selection.catalogModel?.id.trim() || resolvedLaunchModel,
      catalogSource: selection.catalogSource,
      catalogFetchedAt: selection.catalogFetchedAt,
      selectedEffort: intent.provenance.effort === 'explicit' ? (intent.effort ?? null) : null,
      resolvedEffort,
      selectedFastMode: params.request.fastMode ?? 'inherit',
      resolvedFastMode: fast.resolvedFastMode,
      fastResolutionReason: fast.disabledReason,
    };
  }

  const providerBackendId =
    intent.providerBackendId ?? currentDefaultBackend(providerId, params.facts);
  const resolvedEffort = intent.effort ?? null;
  return {
    providerId,
    providerBackendId,
    billingMode: billingMode(providerId, providerBackendId, params.facts, resolvedFallbackModel),
    selectedModel: intent.provenance.model === 'explicit' ? (intent.model ?? null) : null,
    selectedModelKind: intent.provenance.model,
    resolvedLaunchModel: resolvedFallbackModel,
    catalogId: resolvedFallbackModel,
    catalogSource: params.facts.modelCatalog?.source ?? 'runtime',
    catalogFetchedAt: params.facts.modelCatalog?.fetchedAt ?? null,
    selectedEffort: intent.provenance.effort === 'explicit' ? (intent.effort ?? null) : null,
    resolvedEffort,
  };
}
