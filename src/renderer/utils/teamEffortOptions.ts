import { resolveAnthropicRuntimeSelection } from '@features/anthropic-runtime-profile/renderer';

import type { CliProviderStatus, EffortLevel, TeamProviderId } from '@shared/types';

const BASE_EFFORT_OPTIONS = [{ value: '', label: 'Default' }] as const;
const SAFE_SHARED_EFFORTS = new Set<EffortLevel>(['low', 'medium', 'high']);

export const TEAM_EFFORT_LABELS: Record<EffortLevel, string> = {
  none: 'None',
  minimal: 'Minimal',
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  max: 'Max',
  xhigh: 'XHigh',
};

interface TeamEffortOption {
  value: string;
  label: string;
}

interface TeamEffortSelectorPresentation {
  options: readonly TeamEffortOption[];
  disabled: boolean;
  helperText: string;
  unavailableText: string | null;
  canValidateValue: boolean;
}

function getCatalogModel(
  providerId: TeamProviderId | undefined,
  providerStatus: CliProviderStatus | null | undefined,
  model: string | undefined
): NonNullable<CliProviderStatus['modelCatalog']>['models'][number] | null {
  const catalog = providerStatus?.modelCatalog;
  if (!providerId || catalog?.providerId !== providerId) {
    return null;
  }

  const explicitModel = model?.trim();
  if (explicitModel) {
    return (
      catalog.models.find(
        (item) => item.launchModel === explicitModel || item.id === explicitModel
      ) ?? null
    );
  }

  return (
    catalog.models.find((item) => item.id === catalog.defaultModelId) ??
    catalog.models.find((item) => item.launchModel === catalog.defaultLaunchModel) ??
    catalog.models.find((item) => item.isDefault) ??
    null
  );
}

function normalizeEfforts(
  providerId: TeamProviderId,
  candidateEfforts: readonly EffortLevel[],
  configPassthrough: boolean
): EffortLevel[] {
  if (providerId === 'codex' && configPassthrough) {
    return [...candidateEfforts];
  }

  return candidateEfforts.filter((effort) => SAFE_SHARED_EFFORTS.has(effort));
}

export function getTeamEffortOptions(params: {
  providerId?: TeamProviderId;
  model?: string;
  limitContext?: boolean;
  providerStatus?: CliProviderStatus | null;
}): readonly TeamEffortOption[] {
  const providerId = params.providerId;
  if (!providerId) {
    return BASE_EFFORT_OPTIONS;
  }

  if (providerId === 'anthropic') {
    const selection = resolveAnthropicRuntimeSelection({
      source: {
        modelCatalog: params.providerStatus?.modelCatalog,
        runtimeCapabilities: params.providerStatus?.runtimeCapabilities,
      },
      selectedModel: params.model,
      limitContext: params.limitContext === true,
    });
    const defaultLabel = selection.defaultEffort
      ? `Default (${TEAM_EFFORT_LABELS[selection.defaultEffort]})`
      : 'Default';
    return [
      { value: '', label: defaultLabel },
      ...selection.supportedEfforts.map((effort) => ({
        value: effort,
        label: TEAM_EFFORT_LABELS[effort],
      })),
    ];
  }

  const runtimeCapability = params.providerStatus?.runtimeCapabilities?.reasoningEffort;
  const catalogModel = getCatalogModel(providerId, params.providerStatus, params.model);
  const catalogEfforts = catalogModel?.supportedReasoningEfforts ?? [];
  const candidateEfforts =
    catalogEfforts.length > 0
      ? catalogEfforts
      : ((runtimeCapability?.values ?? []) as EffortLevel[]);
  const efforts = normalizeEfforts(
    providerId,
    candidateEfforts,
    runtimeCapability?.configPassthrough === true
  );
  const defaultLabel = catalogModel?.defaultReasoningEffort
    ? `Default (${TEAM_EFFORT_LABELS[catalogModel.defaultReasoningEffort]})`
    : 'Default';

  if (providerId === 'codex') {
    const fallbackEfforts =
      efforts.length > 0 ? efforts : (['low', 'medium', 'high'] as EffortLevel[]);
    return [
      { value: '', label: defaultLabel },
      ...fallbackEfforts.map((effort) => ({
        value: effort,
        label: TEAM_EFFORT_LABELS[effort],
      })),
    ];
  }

  return [
    { value: '', label: defaultLabel },
    { value: 'low', label: TEAM_EFFORT_LABELS.low },
    { value: 'medium', label: TEAM_EFFORT_LABELS.medium },
    { value: 'high', label: TEAM_EFFORT_LABELS.high },
  ];
}

export function getTeamEffortSelectorPresentation(params: {
  providerId?: TeamProviderId;
  model?: string;
  limitContext?: boolean;
  providerStatus?: CliProviderStatus | null;
}): TeamEffortSelectorPresentation {
  const options = getTeamEffortOptions(params);
  const defaultHelperText =
    "Controls how much reasoning the selected provider invests before responding. Higher levels can use more tokens. Default uses the provider's standard behavior for the selected model.";

  if (params.providerId !== 'anthropic') {
    return {
      options,
      disabled: false,
      helperText: defaultHelperText,
      unavailableText: null,
      canValidateValue: false,
    };
  }

  const selection = resolveAnthropicRuntimeSelection({
    source: {
      modelCatalog: params.providerStatus?.modelCatalog,
      runtimeCapabilities: params.providerStatus?.runtimeCapabilities,
    },
    selectedModel: params.model,
    limitContext: params.limitContext === true,
  });
  const hasCatalogTruth =
    selection.catalogSource !== 'unavailable' && selection.catalogStatus !== 'unavailable';
  const supportsConfigurableEffort = selection.supportedEfforts.length > 0;

  if (!hasCatalogTruth || supportsConfigurableEffort) {
    return {
      options,
      disabled: false,
      helperText: defaultHelperText,
      unavailableText: null,
      canValidateValue: hasCatalogTruth,
    };
  }

  const modelLabel =
    selection.displayName ?? selection.resolvedLaunchModel ?? params.model?.trim() ?? 'This model';

  return {
    options: [{ value: '', label: 'Not supported' }],
    disabled: true,
    helperText: `${modelLabel} does not support configurable reasoning effort. The app will omit --effort and use the provider default.`,
    unavailableText: 'Effort is unavailable for this model.',
    canValidateValue: true,
  };
}
