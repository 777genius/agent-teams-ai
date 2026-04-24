import {
  getProviderScopedTeamModelLabel,
  getRuntimeAwareProviderScopedTeamModelLabel,
  getRuntimeAwareTeamModelBadgeLabel,
  getRuntimeAwareTeamModelUiDisabledReason,
  getTeamModelSourceBadgeLabel,
  getTeamProviderLabel,
  getTeamProviderModelOptions,
  getVisibleTeamProviderModels,
  isSupportedAnthropicTeamModel,
  normalizeTeamModelForUi as normalizeCatalogTeamModelForUi,
  sortTeamProviderModels,
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
> &
  Partial<Pick<CliProviderStatus, 'verificationState' | 'statusMessage'>>;

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

export function isTeamProviderModelVerificationPending(
  providerId: SupportedProviderId | undefined,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): boolean {
  if (!providerId || providerId === 'anthropic' || !providerStatus) {
    return false;
  }

  if (providerStatus.modelVerificationState === 'verifying') {
    return true;
  }

  const hasRuntimeModelTruth =
    providerStatus.models.length > 0 ||
    (providerStatus.modelCatalog?.models.length ?? 0) > 0 ||
    (providerStatus.modelAvailability?.length ?? 0) > 0;
  if (!hasRuntimeModelTruth) {
    if (
      providerId === 'codex' &&
      providerStatus.backend?.kind === 'codex-native' &&
      providerStatus.supported
    ) {
      return true;
    }

    if (
      providerId === 'opencode' &&
      providerStatus.backend?.kind === 'opencode-cli' &&
      providerStatus.supported
    ) {
      return true;
    }
  }

  if (providerStatus.verificationState !== 'unknown') {
    return false;
  }

  if (hasRuntimeModelTruth) {
    return false;
  }

  const statusMessage = providerStatus.statusMessage?.trim().toLowerCase() ?? '';
  return statusMessage.length === 0 || statusMessage === 'checking...';
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
  providerId: SupportedProviderId,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): TeamRuntimeModelOption[] {
  return getTeamProviderModelOptions(providerId).map((option) => ({
    ...option,
    label:
      option.value === ''
        ? option.label
        : (getRuntimeAwareProviderScopedTeamModelLabel(providerId, option.value, providerStatus) ??
          option.value),
    badgeLabel:
      option.value === ''
        ? option.badgeLabel
        : (getRuntimeAwareTeamModelBadgeLabel(providerId, option.value, providerStatus) ??
          option.badgeLabel),
  }));
}

function hasAnthropicRuntimeCatalog(
  providerStatus?: TeamModelRuntimeProviderStatus | null
): boolean {
  return providerStatus?.modelCatalog?.providerId === 'anthropic';
}

function getAnthropicCatalogModel(
  model: string,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): NonNullable<TeamModelRuntimeProviderStatus['modelCatalog']>['models'][number] | null {
  const catalog = hasAnthropicRuntimeCatalog(providerStatus) ? providerStatus?.modelCatalog : null;
  if (!catalog) {
    return null;
  }

  return catalog.models.find((item) => item.launchModel === model || item.id === model) ?? null;
}

function getRuntimeCatalogModels(
  providerId: SupportedProviderId,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): string[] | null {
  if (providerId === 'anthropic') {
    return null;
  }

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
    if (!providerStatus || !hasAnthropicRuntimeCatalog(providerStatus)) {
      return isSupportedAnthropicTeamModel(model) ? 'available' : null;
    }

    return getAnthropicCatalogModel(model, providerStatus) ? 'available' : null;
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
    const visibleAnthropicModels = getFallbackTeamProviderModels(providerId);
    return {
      checkedCount: visibleAnthropicModels.length,
      totalCount: visibleAnthropicModels.length,
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
    return getFallbackTeamProviderModels(providerId).filter(
      (model) => getRuntimeModelAvailability(providerId, model, providerStatus) === 'available'
    );
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
    return getFallbackTeamProviderModelOptions(providerId, providerStatus).map((option) => ({
      ...option,
      availabilityStatus:
        option.value.trim().length > 0
          ? getRuntimeModelAvailability(providerId, option.value, providerStatus)
          : undefined,
      availabilityReason:
        option.value.trim().length > 0
          ? getRuntimeModelAvailabilityReason(option.value, providerStatus)
          : undefined,
    }));
  }

  if (!providerStatus) {
    return [{ value: '', label: 'Default', badgeLabel: 'Default' }];
  }

  if (isTeamProviderModelVerificationPending(providerId, providerStatus)) {
    return getFallbackTeamProviderModelOptions(providerId, providerStatus);
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
        badgeLabel:
          providerId === 'opencode'
            ? (getTeamModelSourceBadgeLabel(providerId, model) ?? undefined)
            : undefined,
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
    if (!isSupportedAnthropicTeamModel(trimmed)) {
      return false;
    }

    return getRuntimeModelAvailability(providerId, trimmed, providerStatus) === 'available';
  }

  if (isTeamProviderModelVerificationPending(providerId, providerStatus)) {
    return true;
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

  if (isTeamProviderModelVerificationPending(providerId, providerStatus)) {
    return normalized;
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
    return null;
  }

  if (isTeamProviderModelVerificationPending(providerId, providerStatus)) {
    return null;
  }

  const visibleModels = getVisibleRuntimeModels(providerId, providerStatus);
  if (!visibleModels.includes(trimmed)) {
    return `Model "${trimmed}" is not available for the current ${getTeamProviderLabel(providerId) ?? providerId} runtime. Pick one of the listed models or use Default.`;
  }

  return null;
}
