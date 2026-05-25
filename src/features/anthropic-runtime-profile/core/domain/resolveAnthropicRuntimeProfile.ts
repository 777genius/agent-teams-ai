import { resolveAnthropicLaunchModel } from '@shared/utils/anthropicLaunchModel';

import type {
  CliProviderModelCatalog,
  CliProviderModelCatalogItem,
  CliProviderRuntimeCapabilities,
  EffortLevel,
  TeamFastMode,
} from '@shared/types';

export interface AnthropicRuntimeProfileSource {
  modelCatalog?: CliProviderModelCatalog | null;
  runtimeCapabilities?: CliProviderRuntimeCapabilities | null;
}

export interface AnthropicRuntimeSelection {
  resolvedLaunchModel: string | null;
  catalogModel: CliProviderModelCatalogItem | null;
  displayName: string | null;
  catalogSource: CliProviderModelCatalog['source'] | 'unavailable';
  catalogStatus: CliProviderModelCatalog['status'] | 'unavailable';
  catalogFetchedAt: string | null;
  supportedEfforts: EffortLevel[];
  defaultEffort: EffortLevel | null;
  supportsFastMode: boolean;
  providerFastModeSupported: boolean;
  providerFastModeAvailable: boolean;
  providerFastModeReason: string | null;
}

export interface AnthropicFastModeResolution {
  selectedFastMode: TeamFastMode;
  requestedFastMode: boolean;
  resolvedFastMode: boolean;
  showFastModeControl: boolean;
  selectable: boolean;
  disabledReason: string | null;
}

export interface AnthropicRuntimeReconciliation {
  nextEffort: EffortLevel | '';
  effortResetReason: string | null;
  nextFastMode: TeamFastMode;
  fastModeResetReason: string | null;
}

export type AnthropicEffortSupportResolution =
  | { kind: 'supported'; source: 'catalog' | 'runtime-capability' | 'static-fallback' }
  | { kind: 'unsupported-by-catalog'; supportedEfforts: EffortLevel[] }
  | { kind: 'unsupported-by-runtime-capability'; supportedEfforts: EffortLevel[] }
  | { kind: 'unverified-catalog-missing' };

function getAnthropicCatalog(
  source: AnthropicRuntimeProfileSource
): CliProviderModelCatalog | null {
  return source.modelCatalog?.providerId === 'anthropic' ? source.modelCatalog : null;
}

function normalizeEffortLevel(value: string | null | undefined): EffortLevel | null {
  return value === 'none' ||
    value === 'minimal' ||
    value === 'low' ||
    value === 'medium' ||
    value === 'high' ||
    value === 'xhigh' ||
    value === 'max'
    ? value
    : null;
}

function normalizeEffortLevels(values: readonly string[] | undefined): EffortLevel[] {
  const normalized = new Set<EffortLevel>();
  for (const value of values ?? []) {
    const effort = normalizeEffortLevel(value);
    if (effort) {
      normalized.add(effort);
    }
  }
  return Array.from(normalized);
}

function hasCatalogTruth(selection: AnthropicRuntimeSelection): boolean {
  return selection.catalogSource !== 'unavailable' && selection.catalogStatus !== 'unavailable';
}

function stripOneMillionSuffix(model: string): string {
  return model
    .trim()
    .toLowerCase()
    .replace(/(?:\[1m\])+$/i, '');
}

function isKnownAnthropicReasoningModel(model: string | null | undefined): boolean {
  const normalized = stripOneMillionSuffix(model ?? '');
  return (
    normalized === 'opus' ||
    normalized === 'sonnet' ||
    normalized === 'claude-opus-4-7' ||
    normalized.startsWith('claude-opus-4-7-') ||
    normalized === 'claude-opus-4-6' ||
    normalized.startsWith('claude-opus-4-6-') ||
    normalized === 'claude-sonnet-4-6' ||
    normalized.startsWith('claude-sonnet-4-6-')
  );
}

function normalizeRuntimeReasoningEfforts(
  capabilities: CliProviderRuntimeCapabilities | null | undefined
): EffortLevel[] {
  return normalizeEffortLevels(capabilities?.reasoningEffort?.values);
}

export function resolveAnthropicEffortSupport(params: {
  selection: AnthropicRuntimeSelection;
  effort: EffortLevel;
  runtimeCapabilities?: CliProviderRuntimeCapabilities | null;
}): AnthropicEffortSupportResolution {
  if (params.selection.catalogModel) {
    return params.selection.supportedEfforts.includes(params.effort)
      ? { kind: 'supported', source: 'catalog' }
      : { kind: 'unsupported-by-catalog', supportedEfforts: params.selection.supportedEfforts };
  }

  const runtimeReasoning = params.runtimeCapabilities?.reasoningEffort;
  const runtimeEfforts = normalizeRuntimeReasoningEfforts(params.runtimeCapabilities);
  if (runtimeReasoning) {
    if (
      runtimeReasoning.supported !== true ||
      runtimeReasoning.configPassthrough !== true ||
      !runtimeEfforts.includes(params.effort)
    ) {
      return { kind: 'unsupported-by-runtime-capability', supportedEfforts: runtimeEfforts };
    }
    if (isKnownAnthropicReasoningModel(params.selection.resolvedLaunchModel)) {
      return { kind: 'supported', source: 'runtime-capability' };
    }
  }

  if (
    !runtimeReasoning &&
    isKnownAnthropicReasoningModel(params.selection.resolvedLaunchModel) &&
    (params.effort === 'low' ||
      params.effort === 'medium' ||
      params.effort === 'high' ||
      params.effort === 'max')
  ) {
    return { kind: 'supported', source: 'static-fallback' };
  }

  return { kind: 'unverified-catalog-missing' };
}

export function resolveAnthropicRuntimeSelection(params: {
  source: AnthropicRuntimeProfileSource;
  selectedModel?: string | null;
  limitContext: boolean;
  availableLaunchModels?: Iterable<string>;
}): AnthropicRuntimeSelection {
  const catalog = getAnthropicCatalog(params.source);
  const availableLaunchModels =
    catalog !== null
      ? catalog.models.map((model) => model.launchModel)
      : params.availableLaunchModels;
  const resolvedLaunchModel =
    resolveAnthropicLaunchModel({
      selectedModel: params.selectedModel,
      limitContext: params.limitContext,
      availableLaunchModels,
      defaultLaunchModel: catalog?.defaultLaunchModel ?? null,
    }) ?? null;

  const catalogModel =
    resolvedLaunchModel && catalog
      ? (catalog.models.find(
          (model) =>
            model.launchModel.trim() === resolvedLaunchModel ||
            model.id.trim() === resolvedLaunchModel
        ) ?? null)
      : null;

  return {
    resolvedLaunchModel,
    catalogModel,
    displayName: catalogModel?.displayName?.trim() ?? null,
    catalogSource: catalog?.source ?? 'unavailable',
    catalogStatus: catalog?.status ?? 'unavailable',
    catalogFetchedAt: catalog?.fetchedAt ?? null,
    supportedEfforts: normalizeEffortLevels(catalogModel?.supportedReasoningEfforts),
    defaultEffort: normalizeEffortLevel(catalogModel?.defaultReasoningEffort ?? null),
    supportsFastMode: catalogModel?.supportsFastMode === true,
    providerFastModeSupported: params.source.runtimeCapabilities?.fastMode?.supported === true,
    providerFastModeAvailable: params.source.runtimeCapabilities?.fastMode?.available === true,
    providerFastModeReason: params.source.runtimeCapabilities?.fastMode?.reason ?? null,
  };
}

export function resolveAnthropicFastMode(params: {
  selection: AnthropicRuntimeSelection;
  selectedFastMode?: TeamFastMode | null;
  providerFastModeDefault?: boolean;
}): AnthropicFastModeResolution {
  const selectedFastMode = params.selectedFastMode ?? 'inherit';
  const requestedFastMode =
    selectedFastMode === 'on'
      ? true
      : selectedFastMode === 'off'
        ? false
        : params.providerFastModeDefault === true;

  const selectable =
    params.selection.providerFastModeSupported &&
    params.selection.providerFastModeAvailable &&
    params.selection.supportsFastMode;

  let disabledReason: string | null = null;
  if (!hasCatalogTruth(params.selection) && !params.selection.providerFastModeSupported) {
    disabledReason = 'Anthropic runtime capability data is still loading.';
  } else if (!params.selection.providerFastModeSupported) {
    disabledReason =
      params.selection.providerFastModeReason ??
      'Fast mode is not supported by this Anthropic runtime.';
  } else if (!params.selection.supportsFastMode) {
    disabledReason = params.selection.displayName
      ? `Fast mode is available only for Opus 4.6. Selected model resolves to ${params.selection.displayName}.`
      : 'Fast mode is available only for Opus 4.6.';
  } else if (!params.selection.providerFastModeAvailable) {
    disabledReason =
      params.selection.providerFastModeReason ?? 'Fast mode is currently unavailable.';
  }

  return {
    selectedFastMode,
    requestedFastMode,
    resolvedFastMode: requestedFastMode && selectable,
    showFastModeControl:
      params.selection.providerFastModeSupported ||
      selectedFastMode !== 'inherit' ||
      params.providerFastModeDefault === true,
    selectable,
    disabledReason,
  };
}

export function reconcileAnthropicRuntimeSelections(params: {
  selection: AnthropicRuntimeSelection;
  selectedEffort?: string | null;
  selectedFastMode?: TeamFastMode | null;
  providerFastModeDefault?: boolean;
  runtimeCapabilities?: CliProviderRuntimeCapabilities | null;
}): AnthropicRuntimeReconciliation {
  const selectedEffort = normalizeEffortLevel(params.selectedEffort ?? null);
  if (!hasCatalogTruth(params.selection)) {
    return {
      nextEffort: selectedEffort ?? '',
      effortResetReason: null,
      nextFastMode: params.selectedFastMode ?? 'inherit',
      fastModeResetReason: null,
    };
  }

  let nextEffort: EffortLevel | '' = selectedEffort ?? '';
  let effortResetReason: string | null = null;
  if (selectedEffort) {
    const effortSupport = resolveAnthropicEffortSupport({
      selection: params.selection,
      effort: selectedEffort,
      runtimeCapabilities: params.runtimeCapabilities,
    });
    if (
      effortSupport.kind === 'unsupported-by-catalog' ||
      effortSupport.kind === 'unsupported-by-runtime-capability'
    ) {
      nextEffort = '';
      effortResetReason = `${selectedEffort} effort is not available for the currently selected Anthropic model. Reset to Default.`;
    }
  }

  const fastResolution = resolveAnthropicFastMode({
    selection: params.selection,
    selectedFastMode: params.selectedFastMode,
    providerFastModeDefault: params.providerFastModeDefault,
  });
  const nextFastMode =
    fastResolution.selectedFastMode === 'on' && !fastResolution.selectable
      ? 'inherit'
      : fastResolution.selectedFastMode;
  const fastModeResetReason =
    fastResolution.selectedFastMode === 'on' && nextFastMode !== 'on'
      ? (fastResolution.disabledReason ??
        'Fast mode is not available for the currently selected Anthropic model. Reset to Default.')
      : null;

  return {
    nextEffort,
    effortResetReason,
    nextFastMode,
    fastModeResetReason,
  };
}
