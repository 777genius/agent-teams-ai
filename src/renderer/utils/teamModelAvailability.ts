import { CLI_PROVIDER_STATUS_DEFERRED_MESSAGE } from '@shared/types/cliInstaller';
import { isAnthropicClaudeCodeRemovedModel } from '@shared/utils/providerModelVisibility';

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

export const OPENCODE_OPENAI_AUTH_UNAVAILABLE_REASON =
  'OpenCode OpenAI provider authentication failed. Reconnect OpenAI in provider settings, then refresh runtime status.';

export type TeamModelRuntimeProviderStatus = Pick<
  CliProviderStatus,
  | 'providerId'
  | 'models'
  | 'modelCatalog'
  | 'modelCatalogRefreshState'
  | 'modelAvailability'
  | 'modelVerificationState'
  | 'runtimeCapabilities'
  | 'authMethod'
  | 'backend'
  | 'authenticated'
  | 'supported'
  | 'detailMessage'
  | 'availableBackends'
  | 'externalRuntimeDiagnostics'
  | 'connection'
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

export function getOpenCodeOpenAiRouteAuthUnavailableReason(
  providerId: SupportedProviderId | undefined,
  model: string | undefined,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): string | null {
  if (
    providerId !== 'opencode' ||
    !model?.trim().toLowerCase().startsWith('openai/') ||
    !providerStatus
  ) {
    return null;
  }

  const openAiBackends = (providerStatus.availableBackends ?? []).filter((backend) =>
    [backend.id, backend.label, backend.description].some((value) => /\bopenai\b/i.test(value))
  );
  const backendRequiresAuth = openAiBackends.some(
    (backend) =>
      backend.state === 'authentication-required' ||
      (!backend.available &&
        [backend.statusMessage, backend.detailMessage].some((value) =>
          /auth|token|api key|401|403/i.test(value ?? '')
        ))
  );
  if (backendRequiresAuth) {
    return OPENCODE_OPENAI_AUTH_UNAVAILABLE_REASON;
  }

  const diagnosticText = [
    providerStatus.statusMessage,
    providerStatus.detailMessage,
    ...openAiBackends.flatMap((backend) => [backend.statusMessage, backend.detailMessage]),
    ...(providerStatus.externalRuntimeDiagnostics ?? [])
      .filter((diagnostic) => /\bopenai\b/i.test(diagnostic.label))
      .flatMap((diagnostic) => [diagnostic.statusMessage, diagnostic.detailMessage]),
  ]
    .map((value) => value?.trim() ?? '')
    .filter(Boolean)
    .join('\n');

  if (
    /\bopenai\b/i.test(diagnosticText) &&
    /token refresh failed|token.*invalid|invalid.*token|not[_\s-]?authenticated|not authenticated|unauthorized|forbidden|\b401\b|\b403\b|invalid api key|api key.*invalid|authentication required/i.test(
      diagnosticText
    )
  ) {
    return OPENCODE_OPENAI_AUTH_UNAVAILABLE_REASON;
  }

  return null;
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

function hasTeamProviderRuntimeModelTruth(
  providerStatus?: TeamModelRuntimeProviderStatus | null
): boolean {
  if (!providerStatus) {
    return false;
  }

  if ((providerStatus.modelAvailability?.length ?? 0) > 0) {
    return true;
  }

  // A static fallback only keeps the picker populated while the real Codex
  // catalog loads. It must not make verification look complete.
  if (providerStatus.modelCatalog?.source === 'static-fallback') {
    return false;
  }

  return providerStatus.models.length > 0 || (providerStatus.modelCatalog?.models.length ?? 0) > 0;
}

export function isTeamProviderModelCatalogFresh(
  providerId: SupportedProviderId | undefined,
  providerStatus?: TeamModelRuntimeProviderStatus | null,
  nowMs = Date.now()
): boolean {
  const catalog = providerStatus?.modelCatalog;
  if (
    !providerId ||
    catalog?.providerId !== providerId ||
    catalog.status !== 'ready' ||
    providerStatus?.modelCatalogRefreshState !== 'ready'
  ) {
    return false;
  }

  const staleAtMs = Date.parse(catalog.staleAt);
  return Number.isFinite(staleAtMs) && staleAtMs > nowMs;
}

export function isTeamProviderModelCatalogSettled(
  providerId: SupportedProviderId | undefined,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): boolean {
  return Boolean(
    providerId &&
    providerStatus?.modelCatalog?.providerId === providerId &&
    providerStatus.modelCatalogRefreshState === 'ready'
  );
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

  const verificationState = providerStatus.verificationState;
  if (verificationState === 'error' || providerStatus.modelCatalogRefreshState === 'error') {
    return false;
  }

  const statusMessage = providerStatus.statusMessage?.trim().toLowerCase() ?? '';
  const statusMessagePending =
    statusMessage === 'checking...' ||
    statusMessage === CLI_PROVIDER_STATUS_DEFERRED_MESSAGE.toLowerCase();
  if (statusMessagePending && providerId !== 'opencode') {
    return true;
  }

  // A ready catalog is authoritative even when it is stale, degraded, or
  // unavailable. Callers may retry it in the background, but must not present
  // a terminal catalog result as an endless initial load.
  if (isTeamProviderModelCatalogSettled(providerId, providerStatus)) {
    return false;
  }

  const hasRuntimeModelTruth = hasTeamProviderRuntimeModelTruth(providerStatus);
  if (statusMessagePending || providerStatus.modelCatalogRefreshState === 'loading') {
    return !hasRuntimeModelTruth;
  }

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

  return statusMessage.length === 0 || statusMessage === 'checking...';
}

export function isTeamProviderRuntimeStatusLoading(
  providerId: SupportedProviderId | undefined,
  providerStatus?: TeamModelRuntimeProviderStatus | null,
  providerLoading = false
): boolean {
  if (!providerId) {
    return false;
  }

  if (isTeamProviderModelVerificationPending(providerId, providerStatus)) {
    return true;
  }

  // `providerLoading` is reserved for an explicit, non-silent provider/auth
  // refresh. Cached model truth may keep a background catalog refresh usable,
  // but it must not make a real connection check look settled.
  return providerLoading;
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

function hasAnthropicCompatibleRuntimeCatalog(
  providerStatus?: TeamModelRuntimeProviderStatus | null
): boolean {
  return (
    providerStatus?.modelCatalog?.providerId === 'anthropic' &&
    providerStatus.modelCatalog.source === 'anthropic-compatible-api'
  );
}

function hasAnthropicFirstPartyRuntimeCatalog(
  providerStatus?: TeamModelRuntimeProviderStatus | null
): boolean {
  return (
    providerStatus?.modelCatalog?.providerId === 'anthropic' &&
    providerStatus.modelCatalog.source === 'anthropic-models-api' &&
    providerStatus.modelCatalog.status !== 'unavailable'
  );
}

export function isAnthropicCompatibleRuntime(
  providerStatus?: TeamModelRuntimeProviderStatus | null
): boolean {
  return (
    hasAnthropicCompatibleRuntimeCatalog(providerStatus) ||
    providerStatus?.runtimeCapabilities?.modelCatalog?.source === 'anthropic-compatible-api' ||
    providerStatus?.connection?.compatibleEndpoint?.enabled === true
  );
}

function hasVisibleAnthropicCompatibleCatalogModels(
  providerStatus?: TeamModelRuntimeProviderStatus | null
): boolean {
  const catalog = hasAnthropicCompatibleRuntimeCatalog(providerStatus)
    ? providerStatus?.modelCatalog
    : null;
  return Boolean(
    catalog?.models.some((model) => {
      const launchModel = model.launchModel.trim() || model.id.trim();
      return !model.hidden && launchModel.length > 0;
    })
  );
}

export function canUseCustomAnthropicCompatibleModel(
  providerStatus?: TeamModelRuntimeProviderStatus | null
): boolean {
  if (!isAnthropicCompatibleRuntime(providerStatus)) {
    return false;
  }

  const catalog = providerStatus?.modelCatalog;
  if (!catalog || catalog.providerId !== 'anthropic') {
    return true;
  }

  if (catalog.source !== 'anthropic-compatible-api') {
    return true;
  }

  return catalog.status !== 'ready' || !hasVisibleAnthropicCompatibleCatalogModels(providerStatus);
}

function getVisibleRuntimeCatalogModels(
  providerStatus?: TeamModelRuntimeProviderStatus | null
): string[] | null {
  if (!providerStatus?.modelCatalog) {
    return null;
  }

  const models = providerStatus.modelCatalog.models
    .filter((model) => {
      if (model.hidden) {
        return false;
      }
      if (providerStatus.modelCatalog?.source !== 'anthropic-models-api') {
        return true;
      }
      return (
        !isAnthropicClaudeCodeRemovedModel(model.launchModel) &&
        !isAnthropicClaudeCodeRemovedModel(model.id)
      );
    })
    .map((model) => model.launchModel.trim() || model.id.trim())
    .filter(Boolean);
  return models.length > 0 ? models : null;
}

function getAnthropicFirstPartyRuntimeModels(
  providerStatus?: TeamModelRuntimeProviderStatus | null
): string[] | null {
  if (!hasAnthropicFirstPartyRuntimeCatalog(providerStatus)) {
    return null;
  }

  return getVisibleRuntimeCatalogModels(providerStatus);
}

function getAnthropicFirstPartySelectorModels(
  providerStatus?: TeamModelRuntimeProviderStatus | null
): string[] | null {
  const catalogModels = getAnthropicFirstPartyRuntimeModels(providerStatus);
  if (!catalogModels) {
    return null;
  }

  const seenModels = new Set<string>();
  const seenLabels = new Set<string>();
  const merged: string[] = [];

  const appendModel = (model: string): void => {
    const trimmed = model.trim();
    if (!trimmed || seenModels.has(trimmed)) {
      return;
    }

    const label =
      getRuntimeAwareProviderScopedTeamModelLabel('anthropic', trimmed, providerStatus) ?? trimmed;
    const labelKey = label.trim().toLowerCase();
    if (labelKey && seenLabels.has(labelKey)) {
      return;
    }

    seenModels.add(trimmed);
    if (labelKey) {
      seenLabels.add(labelKey);
    }
    merged.push(trimmed);
  };

  for (const model of catalogModels) {
    appendModel(model);
  }

  return merged;
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
    if (!hasAnthropicCompatibleRuntimeCatalog(providerStatus)) {
      return null;
    }
  } else if (
    (providerId !== 'codex' && providerId !== 'opencode') ||
    providerStatus?.modelCatalog?.providerId !== providerId
  ) {
    return null;
  }

  return getVisibleRuntimeCatalogModels(providerStatus);
}

function getRuntimeCatalogModelOption(
  providerId: SupportedProviderId,
  model: string,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): TeamRuntimeModelOption | null {
  const canUseCatalog =
    (providerId === 'codex' && providerStatus?.modelCatalog?.providerId === 'codex') ||
    (providerId === 'anthropic' && hasAnthropicRuntimeCatalog(providerStatus));
  if (!canUseCatalog || !providerStatus?.modelCatalog) {
    return null;
  }

  const catalogModel = providerStatus.modelCatalog.models.find(
    (item) => item.launchModel === model || item.id === model
  );
  if (!catalogModel) {
    return null;
  }

  const launchModel = catalogModel.launchModel.trim() || catalogModel.id.trim();
  return {
    value: launchModel,
    label:
      getRuntimeAwareProviderScopedTeamModelLabel(providerId, launchModel, providerStatus) ??
      getProviderScopedTeamModelLabel(providerId, catalogModel.displayName) ??
      catalogModel.displayName,
    badgeLabel:
      getRuntimeAwareTeamModelBadgeLabel(providerId, launchModel, providerStatus) ??
      (getTeamProviderModelOptions(providerId).some((option) => option.value === model)
        ? undefined
        : 'New'),
    availabilityStatus: getRuntimeModelAvailability(providerId, launchModel, providerStatus),
    availabilityReason: getRuntimeModelAvailabilityReason(launchModel, providerStatus),
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
    if (providerId === 'anthropic') {
      return sortTeamProviderModels(providerId, catalogModels, providerStatus);
    }

    const sourceModels =
      providerId === 'opencode'
        ? providerStatus.models.length > 0
          ? providerStatus.models
          : catalogModels
        : catalogModels;
    return getVisibleTeamProviderModels(providerId, sourceModels, providerStatus, {
      expandOpenCodeSummaryCatalog: false,
    });
  }

  if (providerId === 'anthropic' && isAnthropicCompatibleRuntime(providerStatus)) {
    return sortTeamProviderModels(providerId, providerStatus.models, providerStatus);
  }

  return sortTeamProviderModels(providerId, providerStatus.models, providerStatus);
}

function getVisibleRuntimeModels(
  providerId: SupportedProviderId,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): string[] {
  return getRuntimeSelectorModels(providerId, providerStatus).filter(
    (model) => getTeamModelUiDisabledReason(providerId, model, providerStatus) == null
  );
}

function withSupplementalDisabledRuntimeModels(
  providerId: SupportedProviderId,
  models: readonly string[],
  providerStatus?: TeamModelRuntimeProviderStatus | null
): string[] {
  if (providerId !== 'codex') {
    return [...models];
  }

  const modelSet = new Set(models);
  const supplementalDisabledModels = getTeamProviderModelOptions(providerId)
    .map((option) => option.value.trim())
    .filter(
      (model) =>
        model.length > 0 &&
        !modelSet.has(model) &&
        getTeamModelUiDisabledReason(providerId, model, providerStatus) !== null
    );

  return sortTeamProviderModels(
    providerId,
    [...models, ...supplementalDisabledModels],
    providerStatus
  );
}

function getModelAvailabilityMap(
  providerStatus?: TeamModelRuntimeProviderStatus | null
): Map<string, CliProviderModelAvailability> {
  return new Map(
    (providerStatus?.modelAvailability ?? []).map((item) => [item.modelId.trim(), item])
  );
}

function getRuntimeModelAvailabilityFromLookup(
  model: string,
  visibleModelSet: ReadonlySet<string>,
  modelAvailabilityById: ReadonlyMap<string, CliProviderModelAvailability>
): CliProviderModelAvailabilityStatus | null {
  if (!visibleModelSet.has(model)) {
    return null;
  }

  const runtimeAvailability = modelAvailabilityById.get(model)?.status ?? null;
  if (runtimeAvailability === 'unavailable') {
    return 'unavailable';
  }
  return 'available';
}

function getRuntimeModelAvailability(
  providerId: SupportedProviderId,
  model: string,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): CliProviderModelAvailabilityStatus | null {
  if (providerId === 'anthropic') {
    if (isAnthropicCompatibleRuntime(providerStatus)) {
      const visibleModels = getVisibleRuntimeModels(providerId, providerStatus);
      if (visibleModels.includes(model)) {
        const runtimeAvailability = getModelAvailabilityMap(providerStatus).get(model)?.status;
        return runtimeAvailability === 'unavailable' ? 'unavailable' : 'available';
      }

      return canUseCustomAnthropicCompatibleModel(providerStatus) && model.trim()
        ? 'available'
        : null;
    }

    if (!providerStatus || !hasAnthropicRuntimeCatalog(providerStatus)) {
      return isSupportedAnthropicTeamModel(model) ? 'available' : null;
    }

    const firstPartyCatalogModels = getAnthropicFirstPartyRuntimeModels(providerStatus);
    if (firstPartyCatalogModels) {
      if (!firstPartyCatalogModels.includes(model)) {
        return null;
      }
      const catalogModel = getAnthropicCatalogModel(model, providerStatus);
      if (!catalogModel || catalogModel.hidden) {
        return null;
      }
      const runtimeAvailability = getModelAvailabilityMap(providerStatus).get(model)?.status;
      return runtimeAvailability === 'unavailable' ? 'unavailable' : 'available';
    }

    return isSupportedAnthropicTeamModel(model) ? 'available' : null;
  }

  if (!providerStatus) {
    return null;
  }

  const visibleModels = getVisibleRuntimeModels(providerId, providerStatus);
  if (!visibleModels.includes(model)) {
    return null;
  }
  const runtimeAvailability = getModelAvailabilityMap(providerStatus).get(model)?.status ?? null;
  if (runtimeAvailability === 'unavailable') {
    return 'unavailable';
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
    const visibleAnthropicModels = isAnthropicCompatibleRuntime(providerStatus)
      ? getRuntimeSelectorModels(providerId, providerStatus)
      : (getAnthropicFirstPartySelectorModels(providerStatus) ??
        getFallbackTeamProviderModels(providerId));
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
    if (isAnthropicCompatibleRuntime(providerStatus)) {
      return getVisibleRuntimeModels(providerId, providerStatus).filter(
        (model) => getRuntimeModelAvailability(providerId, model, providerStatus) === 'available'
      );
    }

    const firstPartyModels = getAnthropicFirstPartySelectorModels(providerStatus);
    const visibleAnthropicModels = firstPartyModels ?? getFallbackTeamProviderModels(providerId);
    const availableModels = visibleAnthropicModels.filter(
      (model) => getRuntimeModelAvailability(providerId, model, providerStatus) === 'available'
    );

    if (firstPartyModels) {
      return availableModels;
    }

    return sortTeamProviderModels(providerId, availableModels, providerStatus);
  }

  if (!providerStatus) {
    return [];
  }

  const visibleModels = getVisibleRuntimeModels(providerId, providerStatus);
  const modelAvailabilityById = getModelAvailabilityMap(providerStatus);
  return visibleModels.filter(
    (model) => modelAvailabilityById.get(model)?.status !== 'unavailable'
  );
}

export function getAvailableTeamProviderModelOptions(
  providerId: SupportedProviderId,
  providerStatus?: TeamModelRuntimeProviderStatus | null
): TeamRuntimeModelOption[] {
  if (providerId === 'anthropic') {
    if (isAnthropicCompatibleRuntime(providerStatus)) {
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
            badgeLabel: getRuntimeAwareTeamModelBadgeLabel(providerId, model, providerStatus),
            availabilityStatus: getRuntimeModelAvailability(providerId, model, providerStatus),
            availabilityReason: getRuntimeModelAvailabilityReason(model, providerStatus),
          };
        }),
      ];
    }

    const firstPartyModels = getAnthropicFirstPartySelectorModels(providerStatus);
    if (firstPartyModels) {
      const fallbackOptions = getFallbackTeamProviderModelOptions(providerId, providerStatus);
      const fallbackOptionByValue = new Map(
        fallbackOptions.map((option) => [option.value, option])
      );

      return [
        fallbackOptionByValue.get('') ?? { value: '', label: 'Default', badgeLabel: 'Default' },
        ...firstPartyModels.map((model) => {
          const catalogOption = getRuntimeCatalogModelOption(providerId, model, providerStatus);
          const fallbackOption = fallbackOptionByValue.get(model);
          const option = catalogOption ??
            fallbackOption ?? {
              value: model,
              label: getProviderScopedTeamModelLabel(providerId, model) ?? model,
              badgeLabel: getRuntimeAwareTeamModelBadgeLabel(providerId, model, providerStatus),
            };

          return {
            ...option,
            availabilityStatus: getRuntimeModelAvailability(providerId, model, providerStatus),
            availabilityReason: getRuntimeModelAvailabilityReason(model, providerStatus),
          };
        }),
      ];
    }

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

  const visibleModels = withSupplementalDisabledRuntimeModels(
    providerId,
    getRuntimeSelectorModels(providerId, providerStatus),
    providerStatus
  );
  const runtimeVisibleModelSet = new Set(
    visibleModels.filter(
      (model) => getTeamModelUiDisabledReason(providerId, model, providerStatus) == null
    )
  );
  const modelAvailabilityById = getModelAvailabilityMap(providerStatus);
  const getPrecomputedAvailability = (model: string): CliProviderModelAvailabilityStatus | null =>
    getRuntimeModelAvailabilityFromLookup(model, runtimeVisibleModelSet, modelAvailabilityById);
  const getPrecomputedAvailabilityReason = (model: string): string | null =>
    modelAvailabilityById.get(model)?.reason ?? null;

  return [
    { value: '', label: 'Default', badgeLabel: 'Default' },
    ...visibleModels.map((model) => {
      const catalogOption = getRuntimeCatalogModelOption(providerId, model, providerStatus);
      if (catalogOption) {
        return {
          ...catalogOption,
          availabilityStatus: getPrecomputedAvailability(model),
          availabilityReason: getPrecomputedAvailabilityReason(model),
        };
      }
      return {
        value: model,
        label: getProviderScopedTeamModelLabel(providerId, model) ?? model,
        badgeLabel:
          providerId === 'opencode'
            ? (getTeamModelSourceBadgeLabel(providerId, model) ?? undefined)
            : undefined,
        availabilityStatus: getPrecomputedAvailability(model),
        availabilityReason: getPrecomputedAvailabilityReason(model),
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
    if (isAnthropicCompatibleRuntime(providerStatus)) {
      return (
        getRuntimeModelAvailability(providerId, trimmed, providerStatus) === 'available' ||
        canUseCustomAnthropicCompatibleModel(providerStatus)
      );
    }

    if (
      !isSupportedAnthropicTeamModel(trimmed) &&
      !getAnthropicCatalogModel(trimmed, providerStatus)
    ) {
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
  const staticNormalized = normalizeCatalogTeamModelForUi(providerId, model);
  const normalized = staticNormalized.trim() ? staticNormalized : (model ?? '');
  const trimmed = normalized.trim();
  if (!providerId || !trimmed) {
    return normalized;
  }

  if (getTeamModelUiDisabledReason(providerId, trimmed, providerStatus)) {
    return '';
  }

  if (providerId === 'anthropic') {
    if (isAnthropicCompatibleRuntime(providerStatus)) {
      return isTeamModelAvailableForUi(providerId, trimmed, providerStatus) ? normalized : '';
    }

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

  const dynamicUnavailableReason = getOpenCodeOpenAiRouteAuthUnavailableReason(
    providerId,
    trimmed,
    providerStatus
  );
  if (dynamicUnavailableReason) {
    return `Model "${trimmed}" is not available for the current ${getTeamProviderLabel(providerId) ?? providerId} runtime. ${dynamicUnavailableReason}`;
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
  if (providerId === 'opencode' && visibleModels.length === 0) {
    return null;
  }
  if (!visibleModels.includes(trimmed)) {
    return `Model "${trimmed}" is not available for the current ${getTeamProviderLabel(providerId) ?? providerId} runtime. Pick one of the listed models or use Default.`;
  }

  const availability = getRuntimeModelAvailability(providerId, trimmed, providerStatus);
  if (availability !== 'available') {
    const reason = getRuntimeModelAvailabilityReason(trimmed, providerStatus);
    const reasonSuffix = reason ? ` ${reason}` : '';
    return `Model "${trimmed}" is not available for the current ${getTeamProviderLabel(providerId) ?? providerId} runtime.${reasonSuffix} Pick one of the listed models or use Default.`;
  }

  return null;
}
