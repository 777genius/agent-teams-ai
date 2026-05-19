import { parseModelString } from '@shared/utils/modelParser';
import {
  filterVisibleProviderRuntimeModels,
  GPT_5_1_CODEX_MINI_UI_DISABLED_MODEL,
  GPT_5_2_CODEX_UI_DISABLED_MODEL,
  GPT_5_3_CODEX_SPARK_UI_DISABLED_MODEL,
} from '@shared/utils/providerModelVisibility';

import type { CliProviderId, CliProviderStatus, TeamProviderId } from '@shared/types';

export {
  GPT_5_1_CODEX_MINI_UI_DISABLED_MODEL,
  GPT_5_2_CODEX_UI_DISABLED_MODEL,
  GPT_5_3_CODEX_SPARK_UI_DISABLED_MODEL,
} from '@shared/utils/providerModelVisibility';

type SupportedProviderId = CliProviderId | TeamProviderId;
type RuntimeAwareProviderStatus = Pick<
  CliProviderStatus,
  'providerId' | 'authMethod' | 'backend' | 'modelCatalog' | 'runtimeCapabilities'
>;

export interface TeamProviderModelOption {
  value: string;
  label: string;
  badgeLabel?: string;
  uiDisabledReason?: string;
}

export const TEAM_MODEL_UI_DISABLED_BADGE_LABEL = 'Disabled';
export const GPT_5_1_CODEX_MINI_UI_DISABLED_REASON =
  'Temporarily disabled for team agents - this model has been less reliable with task and reply tool contracts.';
export const GPT_5_1_CODEX_MAX_CHATGPT_UI_DISABLED_REASON =
  'Temporarily disabled for team agents - this model is not currently available on the Codex native runtime.';
export const GPT_5_2_CODEX_UI_DISABLED_REASON =
  'Temporarily disabled for team agents - this model is not currently available on the Codex native runtime.';
export const GPT_5_3_CODEX_SPARK_UI_DISABLED_REASON =
  'Temporarily disabled for team agents - this model has been less reliable with bootstrap, task, and reply tool contracts.';
export const CODEX_DYNAMIC_MODEL_REQUIRES_RUNTIME_SUPPORT_REASON =
  'Available in Codex, waiting for Agent Teams runtime support.';

const TEAM_PROVIDER_LABELS: Record<SupportedProviderId, string> = {
  anthropic: 'Anthropic',
  codex: 'Codex',
  gemini: 'Gemini',
};

const ANTHROPIC_ALIAS_LABELS = {
  opus: 'Opus 4.7',
  sonnet: 'Sonnet 4.6',
  haiku: 'Haiku 4.5',
} as const;

const ANTHROPIC_VISIBLE_MODEL_FALLBACKS = ['claude-opus-4-7', 'claude-opus-4-7[1m]'] as const;

const ANTHROPIC_MODEL_ORDER = [
  'haiku',
  'claude-haiku-4-5-20251001',
  'claude-haiku-4-5',
  'opus',
  'opus[1m]',
  'claude-opus-4-7',
  'claude-opus-4-7[1m]',
  'claude-opus-4-6',
  'claude-opus-4-6[1m]',
  'sonnet',
  'sonnet[1m]',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6[1m]',
] as const;

const TEAM_MODEL_LABEL_OVERRIDES: Record<string, string> = {
  default: 'Default',
  ...ANTHROPIC_ALIAS_LABELS,
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-7[1m]': 'Opus 4.7 (1M)',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-6[1m]': 'Sonnet 4.6 (1M)',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-6[1m]': 'Opus 4.6 (1M)',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.4-mini': 'GPT-5.4 Mini',
  'gpt-5.3-codex': 'GPT-5.3 Codex',
  'gpt-5.3-codex-spark': 'GPT-5.3 Codex Spark',
  'gpt-5.2': 'GPT-5.2',
  'gpt-5.2-codex': 'GPT-5.2 Codex',
  'gpt-5.1-codex-mini': 'GPT-5.1 Codex Mini',
  'gpt-5.1-codex-max': 'GPT-5.1 Codex Max',
  'gemini-2.5-pro': 'Gemini 2.5 Pro',
  'gemini-2.5-flash': 'Gemini 2.5 Flash',
  'gemini-2.5-flash-lite': 'Gemini 2.5 Flash Lite',
};

const TEAM_PROVIDER_MODEL_OPTIONS: Record<SupportedProviderId, readonly TeamProviderModelOption[]> =
  {
    anthropic: [
      { value: '', label: 'Default', badgeLabel: 'Default' },
      { value: 'opus', label: 'Opus 4.7', badgeLabel: 'Opus 4.7' },
      { value: 'claude-opus-4-6', label: 'Opus 4.6', badgeLabel: 'Opus 4.6' },
      { value: 'sonnet', label: 'Sonnet 4.6', badgeLabel: 'Sonnet 4.6' },
      { value: 'haiku', label: 'Haiku 4.5', badgeLabel: 'Haiku 4.5' },
    ],
    codex: [
      { value: '', label: 'Default', badgeLabel: 'Default' },
      { value: 'gpt-5.4', label: 'GPT-5.4', badgeLabel: '5.4' },
      { value: 'gpt-5.4-mini', label: 'GPT-5.4 Mini', badgeLabel: '5.4-mini' },
      { value: 'gpt-5.3-codex', label: 'GPT-5.3 Codex', badgeLabel: '5.3-codex' },
      {
        value: 'gpt-5.3-codex-spark',
        label: 'GPT-5.3 Codex Spark',
        badgeLabel: '5.3-codex-spark',
        uiDisabledReason: GPT_5_3_CODEX_SPARK_UI_DISABLED_REASON,
      },
      { value: 'gpt-5.2', label: 'GPT-5.2', badgeLabel: '5.2' },
      {
        value: 'gpt-5.2-codex',
        label: 'GPT-5.2 Codex',
        badgeLabel: '5.2-codex',
        uiDisabledReason: GPT_5_2_CODEX_UI_DISABLED_REASON,
      },
      {
        value: 'gpt-5.1-codex-mini',
        label: 'GPT-5.1 Codex Mini',
        badgeLabel: '5.1-codex-mini',
        uiDisabledReason: GPT_5_1_CODEX_MINI_UI_DISABLED_REASON,
      },
      { value: 'gpt-5.1-codex-max', label: 'GPT-5.1 Codex Max', badgeLabel: '5.1-codex-max' },
    ],
    gemini: [
      { value: '', label: 'Default', badgeLabel: 'Default' },
      { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro', badgeLabel: '2.5-pro' },
      { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash', badgeLabel: '2.5-flash' },
      {
        value: 'gemini-2.5-flash-lite',
        label: 'Gemini 2.5 Flash Lite',
        badgeLabel: '2.5-flash-lite',
      },
    ],
  };

const TEAM_PROVIDER_MODEL_ORDER: Record<SupportedProviderId, Map<string, number>> = {
  anthropic: new Map(ANTHROPIC_MODEL_ORDER.map((model, index) => [model, index])),
  codex: new Map(TEAM_PROVIDER_MODEL_OPTIONS.codex.map((option, index) => [option.value, index])),
  gemini: new Map(TEAM_PROVIDER_MODEL_OPTIONS.gemini.map((option, index) => [option.value, index])),
};

function getKnownTeamProviderModelOption(
  providerId: SupportedProviderId | undefined,
  model: string | undefined
): TeamProviderModelOption | undefined {
  const trimmed = model?.trim();
  if (!providerId || !trimmed) {
    return undefined;
  }
  return TEAM_PROVIDER_MODEL_OPTIONS[providerId].find((option) => option.value === trimmed);
}

function isKnownTeamProviderModel(
  providerId: SupportedProviderId | undefined,
  model: string | undefined
): boolean {
  return Boolean(getKnownTeamProviderModelOption(providerId, model));
}

export function getTeamProviderModelOptions(
  providerId: SupportedProviderId
): readonly TeamProviderModelOption[] {
  return TEAM_PROVIDER_MODEL_OPTIONS[providerId];
}

function splitOneMillionContextSuffix(model: string): {
  baseModel: string;
  hasOneMillion: boolean;
} {
  const hasOneMillion = /\[1m\]$/i.test(model);
  return {
    baseModel: model.replace(/\[1m\]$/i, ''),
    hasOneMillion,
  };
}

function formatParsedClaudeModelLabel(model: string): string | null {
  const trimmed = model.trim();
  if (!trimmed) {
    return null;
  }

  const { baseModel, hasOneMillion } = splitOneMillionContextSuffix(trimmed);
  const parsedModel = parseModelString(baseModel);
  if (!parsedModel) {
    return null;
  }

  const familyLabel = parsedModel.family.charAt(0).toUpperCase() + parsedModel.family.slice(1);
  const versionLabel =
    parsedModel.minorVersion == null
      ? `${parsedModel.majorVersion}`
      : `${parsedModel.majorVersion}.${parsedModel.minorVersion}`;

  return `${familyLabel} ${versionLabel}${hasOneMillion ? ' (1M)' : ''}`;
}

const SUPPORTED_ANTHROPIC_TEAM_MODELS = new Set<string>([
  'opus',
  'opus[1m]',
  'sonnet',
  'sonnet[1m]',
  'haiku',
  'claude-opus-4-7',
  'claude-opus-4-7[1m]',
  'claude-opus-4-6',
  'claude-opus-4-6[1m]',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6[1m]',
  'claude-haiku-4-5',
  'claude-haiku-4-5-20251001',
]);

export function isSupportedAnthropicTeamModel(model: string | undefined): boolean {
  const trimmed = model?.trim();
  if (!trimmed) {
    return false;
  }

  return SUPPORTED_ANTHROPIC_TEAM_MODELS.has(trimmed);
}

export function isAnthropicHaikuTeamModel(model: string | undefined): boolean {
  const trimmed = model?.trim();
  if (!trimmed) {
    return false;
  }

  const { baseModel } = splitOneMillionContextSuffix(trimmed);
  return baseModel === 'haiku' || baseModel.startsWith('claude-haiku-');
}

export function getTeamProviderLabel(
  providerId: SupportedProviderId | undefined
): string | undefined {
  if (!providerId) {
    return undefined;
  }
  return TEAM_PROVIDER_LABELS[providerId];
}

export function getTeamModelLabel(model: string | undefined): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) {
    return undefined;
  }

  const overrideLabel = TEAM_MODEL_LABEL_OVERRIDES[trimmed];
  if (overrideLabel) {
    return overrideLabel;
  }

  return formatParsedClaudeModelLabel(trimmed) ?? trimmed;
}

export function getTeamModelBadgeLabel(
  providerId: SupportedProviderId,
  model: string | undefined
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) {
    return undefined;
  }

  const knownOption = getKnownTeamProviderModelOption(providerId, trimmed);
  if (knownOption?.badgeLabel) {
    return knownOption.badgeLabel;
  }

  if (providerId === 'anthropic') {
    const anthropicLabel = getTeamModelLabel(trimmed);
    if (anthropicLabel && anthropicLabel !== trimmed) {
      return anthropicLabel;
    }
    return trimmed.replace(/^claude-/, '');
  }
  if (providerId === 'codex') {
    return trimmed.replace(/^gpt-/, '');
  }
  if (providerId === 'gemini') {
    return trimmed.replace(/^gemini-/, '');
  }
  return trimmed;
}

export function getProviderScopedTeamModelLabel(
  providerId: SupportedProviderId,
  model: string | undefined
): string | undefined {
  const trimmed = model?.trim();
  if (!trimmed) {
    return undefined;
  }

  const baseLabel = getTeamModelLabel(trimmed) ?? trimmed;
  if (providerId !== 'codex') {
    return baseLabel;
  }

  return baseLabel.replace(/^GPT-/i, '');
}

export function sortTeamProviderModels(
  providerId: SupportedProviderId,
  models: readonly string[]
): string[] {
  const seen = new Set<string>();
  const deduped = models.filter((model) => {
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed)) {
      return false;
    }
    seen.add(trimmed);
    return true;
  });
  const order = TEAM_PROVIDER_MODEL_ORDER[providerId];

  return [...deduped].sort((left, right) => {
    const leftRank = order.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = order.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return left.localeCompare(right);
  });
}

export function isCodexChatGptSubscriptionProviderStatus(
  providerStatus?: RuntimeAwareProviderStatus | null
): boolean {
  if (providerStatus?.providerId !== 'codex') {
    return false;
  }

  return (
    providerStatus.authMethod === 'chatgpt' ||
    providerStatus.backend?.authMethodDetail === 'chatgpt'
  );
}

function isRuntimeHiddenTeamModel(
  providerId: SupportedProviderId,
  model: string,
  providerStatus?: RuntimeAwareProviderStatus | null
): boolean {
  return (
    providerId === 'codex' &&
    model === 'gpt-5.1-codex-max' &&
    isCodexChatGptSubscriptionProviderStatus(providerStatus)
  );
}

function getSupplementalVisibleModels(
  providerId: SupportedProviderId,
  models: readonly string[]
): readonly string[] {
  if (providerId !== 'anthropic') {
    return models;
  }

  return [...models, ...ANTHROPIC_VISIBLE_MODEL_FALLBACKS];
}

export function getVisibleTeamProviderModels(
  providerId: SupportedProviderId,
  models: readonly string[],
  providerStatus?: RuntimeAwareProviderStatus | null
): string[] {
  return sortTeamProviderModels(
    providerId,
    filterVisibleProviderRuntimeModels(providerId, getSupplementalVisibleModels(providerId, models))
  ).filter((model) => !isRuntimeHiddenTeamModel(providerId, model, providerStatus));
}

export function getTeamModelUiDisabledReason(
  providerId: SupportedProviderId | undefined,
  model: string | undefined
): string | null {
  return getKnownTeamProviderModelOption(providerId, model)?.uiDisabledReason ?? null;
}

export function getRuntimeAwareTeamModelUiDisabledReason(
  providerId: SupportedProviderId | undefined,
  model: string | undefined,
  providerStatus?: RuntimeAwareProviderStatus | null
): string | null {
  const staticReason = getTeamModelUiDisabledReason(providerId, model);
  if (staticReason) {
    return staticReason;
  }

  const trimmed = model?.trim();
  if (!providerId || !trimmed) {
    return null;
  }

  if (
    providerId === 'codex' &&
    providerStatus?.modelCatalog?.providerId === 'codex' &&
    providerStatus.modelCatalog.models.some(
      (item) => item.launchModel === trimmed || item.id === trimmed
    ) &&
    !isKnownTeamProviderModel(providerId, trimmed) &&
    providerStatus.runtimeCapabilities?.modelCatalog?.dynamic !== true
  ) {
    return CODEX_DYNAMIC_MODEL_REQUIRES_RUNTIME_SUPPORT_REASON;
  }

  return isRuntimeHiddenTeamModel(providerId, trimmed, providerStatus)
    ? GPT_5_1_CODEX_MAX_CHATGPT_UI_DISABLED_REASON
    : null;
}

export function isTeamModelUiDisabled(
  providerId: SupportedProviderId | undefined,
  model: string | undefined
): boolean {
  return getTeamModelUiDisabledReason(providerId, model) !== null;
}

export function normalizeTeamModelForUi(
  providerId: SupportedProviderId | undefined,
  model: string | undefined
): string {
  return isTeamModelUiDisabled(providerId, model) ? '' : (model ?? '');
}

export function doesTeamModelCarryProviderBrand(
  providerId: SupportedProviderId | undefined,
  modelLabel: string | undefined
): boolean {
  const providerLabel = getTeamProviderLabel(providerId);
  const normalizedProvider = providerLabel?.trim().toLowerCase();
  const normalizedModel = modelLabel?.trim().toLowerCase();
  if (!providerId || !normalizedProvider || !normalizedModel || modelLabel === 'Default') {
    return false;
  }

  return (
    normalizedModel.startsWith(normalizedProvider) ||
    (providerId === 'anthropic' && normalizedModel.startsWith('claude')) ||
    (providerId === 'codex' &&
      (normalizedModel.startsWith('codex') || normalizedModel.startsWith('gpt'))) ||
    (providerId === 'gemini' && normalizedModel.startsWith('gemini'))
  );
}
