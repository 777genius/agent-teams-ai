import type { CliProviderId, TeamProviderId } from '@shared/types';

type SupportedProviderId = CliProviderId | TeamProviderId;

export interface TeamProviderModelOption {
  value: string;
  label: string;
  badgeLabel?: string;
  uiDisabledReason?: string;
}

export const TEAM_MODEL_UI_DISABLED_BADGE_LABEL = 'Disabled';
export const GPT_5_1_CODEX_MINI_UI_DISABLED_MODEL = 'gpt-5.1-codex-mini';
export const GPT_5_3_CODEX_SPARK_UI_DISABLED_MODEL = 'gpt-5.3-codex-spark';
export const GPT_5_1_CODEX_MINI_UI_DISABLED_REASON =
  'Temporarily disabled for team agents - this model has been less reliable with task and reply tool contracts.';
export const GPT_5_3_CODEX_SPARK_UI_DISABLED_REASON =
  'Temporarily disabled for team agents - this model has been less reliable with bootstrap, task, and reply tool contracts.';

const TEAM_PROVIDER_LABELS: Record<SupportedProviderId, string> = {
  anthropic: 'Anthropic',
  codex: 'Codex',
  gemini: 'Gemini',
};

const TEAM_MODEL_LABEL_OVERRIDES: Record<string, string> = {
  default: 'Default',
  opus: 'Opus 4.6',
  sonnet: 'Sonnet 4.6',
  haiku: 'Haiku 4.5',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-6[1m]': 'Sonnet 4.6 (1M)',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-6[1m]': 'Opus 4.6 (1M)',
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
      { value: 'opus', label: 'Opus 4.6', badgeLabel: 'Opus 4.6' },
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
      { value: 'gpt-5.2-codex', label: 'GPT-5.2 Codex', badgeLabel: '5.2-codex' },
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
  anthropic: new Map(
    TEAM_PROVIDER_MODEL_OPTIONS.anthropic.map((option, index) => [option.value, index])
  ),
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

export function getTeamProviderModelOptions(
  providerId: SupportedProviderId
): readonly TeamProviderModelOption[] {
  return TEAM_PROVIDER_MODEL_OPTIONS[providerId];
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
  return TEAM_MODEL_LABEL_OVERRIDES[trimmed] ?? trimmed;
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

export function getVisibleTeamProviderModels(
  providerId: SupportedProviderId,
  models: readonly string[]
): string[] {
  return sortTeamProviderModels(providerId, models).filter(
    (model) => !isTeamModelUiDisabled(providerId, model)
  );
}

export function getTeamModelUiDisabledReason(
  providerId: SupportedProviderId | undefined,
  model: string | undefined
): string | null {
  return getKnownTeamProviderModelOption(providerId, model)?.uiDisabledReason ?? null;
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
