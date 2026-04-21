import {
  getProviderScopedTeamModelLabel,
  getRuntimeAwareTeamModelUiDisabledReason,
  getTeamProviderLabel,
  getTeamProviderModelOptions,
  getVisibleTeamProviderModels,
  CODEX_DYNAMIC_MODEL_REQUIRES_RUNTIME_SUPPORT_REASON,
  GPT_5_1_CODEX_MAX_CHATGPT_UI_DISABLED_REASON,
  GPT_5_1_CODEX_MINI_UI_DISABLED_MODEL,
  GPT_5_1_CODEX_MINI_UI_DISABLED_REASON,
  GPT_5_2_CODEX_UI_DISABLED_MODEL,
  GPT_5_2_CODEX_UI_DISABLED_REASON,
  GPT_5_3_CODEX_SPARK_UI_DISABLED_MODEL,
  GPT_5_3_CODEX_SPARK_UI_DISABLED_REASON,
  isSupportedAnthropicTeamModel,
  normalizeTeamModelForUi as normalizeCatalogTeamModelForUi,
  sortTeamProviderModels,
  TEAM_MODEL_UI_DISABLED_BADGE_LABEL,
  type TeamProviderModelOption,
} from './teamModelCatalog';
import { extractProviderScopedBaseModel } from './teamModelContext';

import type {
  CliProviderId,
  CliProviderModelAvailability,
  CliProviderModelAvailabilityStatus,
  CliProviderStatus,
  TeamProviderId,
} from '@shared/types';

export {
  CODEX_DYNAMIC_MODEL_REQUIRES_RUNTIME_SUPPORT_REASON,
  GPT_5_1_CODEX_MAX_CHATGPT_UI_DISABLED_REASON,
  GPT_5_1_CODEX_MINI_UI_DISABLED_MODEL,
  GPT_5_1_CODEX_MINI_UI_DISABLED_REASON,
  GPT_5_2_CODEX_UI_DISABLED_MODEL,
  GPT_5_2_CODEX_UI_DISABLED_REASON,
  GPT_5_3_CODEX_SPARK_UI_DISABLED_MODEL,
  GPT_5_3_CODEX_SPARK_UI_DISABLED_REASON,
  TEAM_MODEL_UI_DISABLED_BADGE_LABEL,
} from './teamModelCatalog';

type SupportedProviderId = CliProviderId | TeamProviderId;

export type TeamModelRuntimeProviderStatus = Pick<
  CliProviderStatus,
  | 'providerId'
  | 'models'
  | 'modelCatalog'
  | 'modelAvailability'
  | 'modelVerificationState'
  | 'runtimeCapabilities'
  | 'authMethod'
  | 'backend'
  | 'authenticated'
  | 'supported'
>;

export type TeamRuntimeModelOption = TeamProviderModelOption & {
  availabilityStatus?: CliProviderModelAvailabilityStatus | null;
  availabilityReason?: string | null;
};

export interface TeamProviderModelVerificationCounts {
  checkedCount: number;
  totalCount: number;
  verifying: boolean;
}

export function getTeamModelUiDisabledReason(
  providerId: SupportedProviderId | undefined,
  model: string | undefined,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): string | null {
  return getRuntimeAwareTeamModelUiDisabledReason(providerId, model, providerStatus);
}

export function isTeamModelUiDisabled(
  providerId: SupportedProviderId | undefined,
  model: string | undefined,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): boolean {
  return getTeamModelUiDisabledReason(providerId, model, providerStatus) !== null;
}

function getFallbackTeamProviderModels(providerId: SupportedProviderId): string[] {
  return getVisibleTeamProviderModels(
    providerId,
    getTeamProviderModelOptions(providerId)
      .map((option) => option.value)
      .filter((value) => value.trim().length > 0)
  );
}

function getFallbackTeamProviderModelOptions(
  providerId: SupportedProviderId
): TeamRuntimeModelOption[] {
  return getTeamProviderModelOptions(providerId).map((option) => ({
    ...option,
    label:
      option.value === ''
        ? option.label
        : (getProviderScopedTeamModelLabel(providerId, option.value) ?? option.value),
  }));
}

function getRuntimeCatalogModels(
  providerId: SupportedProviderId,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): string[] | null {
  if (providerId !== 'codex' || providerStatus?.modelCatalog?.providerId !== 'codex') {
    return null;
  }

  const models = providerStatus.modelCatalog.models
    .filter((model) => !model.hidden)
    .map((model) => model.launchModel.trim())
    .filter(Boolean);
  return models.length > 0 ? models : null;
}

function getRuntimeCatalogModelOption(
  providerId: SupportedProviderId,
  model: string,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): TeamRuntimeModelOption | null {
  if (providerId !== 'codex' || providerStatus?.modelCatalog?.providerId !== 'codex') {
    return null;
  }

  const catalogModel = providerStatus.modelCatalog.models.find(
    (item) => item.launchModel === model || item.id === model
  );
  if (!catalogModel) {
    return null;
  }

  return {
    value: catalogModel.launchModel,
    label:
      getProviderScopedTeamModelLabel(providerId, catalogModel.displayName) ??
      catalogModel.displayName,
    badgeLabel:
      catalogModel.badgeLabel ??
      (getTeamProviderModelOptions(providerId).some((option) => option.value === model)
        ? undefined
        : 'New'),
    availabilityStatus: getRuntimeModelAvailability(
      providerId,
      catalogModel.launchModel,
      providerStatus
    ),
    availabilityReason: getRuntimeModelAvailabilityReason(catalogModel.launchModel, providerStatus),
  };
}

function getRuntimeSelectorModels(
  providerId: SupportedProviderId,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): string[] {
  if (!providerStatus) {
    return [];
  }

  const catalogModels = getRuntimeCatalogModels(providerId, providerStatus);
  if (catalogModels) {
    return getVisibleTeamProviderModels(providerId, catalogModels, providerStatus);
  }

  return sortTeamProviderModels(providerId, providerStatus.models);
}

function getVisibleRuntimeModels(
  providerId: SupportedProviderId,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): string[] {
  return getRuntimeSelectorModels(providerId, providerStatus).filter(
    (model) => getTeamModelUiDisabledReason(providerId, model, providerStatus) == null
  );
}

function getModelAvailabilityMap(
  providerStatus?: TeamModelRuntimeProviderStatus | null
): Map<string, CliProviderModelAvailability> {
  return new Map(
    (providerStatus?.modelAvailability ?? []).map((item) => [item.modelId.trim(), item])
  );
}

function getRuntimeModelAvailability(
  providerId: SupportedProviderId,
  model: string,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): CliProviderModelAvailabilityStatus | null {
  if (providerId === 'anthropic') {
    return 'available';
  }

  if (!providerStatus) {
    return null;
  }

  const visibleModels = getVisibleRuntimeModels(providerId, providerStatus);
  if (!visibleModels.includes(model)) {
    return null;
  }
  return 'available';
}

function getRuntimeModelAvailabilityReason(
  model: string,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): string | null {
  return getModelAvailabilityMap(providerStatus).get(model)?.reason ?? null;
}

export function getTeamProviderModelVerificationCounts(
  providerId: SupportedProviderId,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): TeamProviderModelVerificationCounts {
  if (providerId === 'anthropic') {
    return {
      checkedCount: getFallbackTeamProviderModels(providerId).length,
      totalCount: getFallbackTeamProviderModels(providerId).length,
      verifying: false,
    };
  }

  const totalCount = getRuntimeSelectorModels(providerId, providerStatus).length;

  return {
    checkedCount: totalCount,
    totalCount,
    verifying: false,
  };
}

export function getAvailableTeamProviderModels(
  providerId: SupportedProviderId,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): string[] {
  if (providerId === 'anthropic') {
    return getFallbackTeamProviderModels(providerId);
  }

  if (!providerStatus) {
    return [];
  }

  return getVisibleRuntimeModels(providerId, providerStatus).filter(
    (model) => getRuntimeModelAvailability(providerId, model, providerStatus) === 'available'
  );
}

export function getAvailableTeamProviderModelOptions(
  providerId: SupportedProviderId,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): TeamRuntimeModelOption[] {
  if (providerId === 'anthropic') {
    return getFallbackTeamProviderModelOptions(providerId);
  }

  if (!providerStatus) {
    return [{ value: '', label: 'Default', badgeLabel: 'Default' }];
  }

  const visibleModels = getRuntimeSelectorModels(providerId, providerStatus);
  return [
    { value: '', label: 'Default', badgeLabel: 'Default' },
    ...visibleModels.map((model) => {
      const catalogOption = getRuntimeCatalogModelOption(providerId, model, providerStatus);
      if (catalogOption) {
        return catalogOption;
      }
      return {
        value: model,
        label: getProviderScopedTeamModelLabel(providerId, model) ?? model,
        availabilityStatus: getRuntimeModelAvailability(providerId, model, providerStatus),
        availabilityReason: getRuntimeModelAvailabilityReason(model, providerStatus),
      };
    }),
  ];
}

export function isTeamModelAvailableForUi(
  providerId: SupportedProviderId | undefined,
  model: string | undefined,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): boolean {
  const trimmed = model?.trim();
  if (!providerId || !trimmed) {
    return true;
  }

  if (getTeamModelUiDisabledReason(providerId, trimmed, providerStatus)) {
    return false;
  }

  if (providerId === 'anthropic') {
    return isSupportedAnthropicTeamModel(trimmed);
  }

  return getRuntimeModelAvailability(providerId, trimmed, providerStatus) === 'available';
}

export function normalizeExplicitTeamModelForUi(
  providerId: SupportedProviderId | undefined,
  model: string | undefined
): string {
  const normalized = extractProviderScopedBaseModel(model, providerId) ?? '';
  return normalizeCatalogTeamModelForUi(providerId, normalized).trim();
}

export function normalizeTeamModelForUi(
  providerId: SupportedProviderId | undefined,
  model: string | undefined,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): string {
  const normalized = normalizeCatalogTeamModelForUi(providerId, model);
  const trimmed = normalized.trim();
  if (!providerId || !trimmed) {
    return normalized;
  }

  if (getTeamModelUiDisabledReason(providerId, trimmed, providerStatus)) {
    return '';
  }

  if (providerId === 'anthropic') {
    return isTeamModelAvailableForUi(providerId, trimmed, providerStatus) ? normalized : '';
  }

  if (!providerStatus) {
    return '';
  }

  const visibleModels = getVisibleRuntimeModels(providerId, providerStatus);
  if (!visibleModels.includes(trimmed)) {
    return '';
  }

  const availability = getRuntimeModelAvailability(providerId, trimmed, providerStatus);
  return availability === 'available' ? normalized : '';
}

export function getTeamModelSelectionError(
  providerId: SupportedProviderId | undefined,
  model: string | undefined,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): string | null {
  const trimmed = model?.trim();
  if (!providerId || !trimmed) {
    return null;
  }

  const disabledReason = getTeamModelUiDisabledReason(providerId, trimmed, providerStatus);
  if (disabledReason) {
    return `Model "${trimmed}" is disabled. ${disabledReason}`;
  }

  if (providerId === 'anthropic') {
    return isTeamModelAvailableForUi(providerId, trimmed, providerStatus)
      ? null
      : `Model "${trimmed}" is not available for the current ${getTeamProviderLabel(providerId) ?? providerId} runtime. Pick one of the listed models or use Default.`;
  }

  if (!providerStatus) {
    return `Model "${trimmed}" is waiting for ${getTeamProviderLabel(providerId) ?? providerId} runtime verification. Wait for the model list to load or use Default.`;
  }

  const visibleModels = getVisibleRuntimeModels(providerId, providerStatus);
  if (!visibleModels.includes(trimmed)) {
    return `Model "${trimmed}" is not available for the current ${getTeamProviderLabel(providerId) ?? providerId} runtime. Pick one of the listed models or use Default.`;
  }

  return null;
}
