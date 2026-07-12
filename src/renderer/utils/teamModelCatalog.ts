import { inferContextWindowTokens } from '@shared/utils/contextMetrics';
import { parseModelString } from '@shared/utils/modelParser';
import {
  getOpenCodeQualifiedModelSourceLabel,
  parseOpenCodeQualifiedModelRef,
} from '@shared/utils/opencodeModelRef';
import { filterVisibleProviderRuntimeModels } from '@shared/utils/providerModelVisibility';

import type { CliProviderId, CliProviderStatus, TeamProviderId } from '@shared/types';

export {
  GPT_5_1_CODEX_MINI_UI_DISABLED_MODEL,
  GPT_5_2_CODEX_UI_DISABLED_MODEL,
  GPT_5_3_CODEX_SPARK_UI_DISABLED_MODEL,
} from '@shared/utils/providerModelVisibility';

type SupportedProviderId = CliProviderId | TeamProviderId;
type RuntimeAwareProviderStatus = Pick<
  CliProviderStatus,
  'providerId' | 'authMethod' | 'backend' | 'modelCatalog'
>;
type RuntimeModelCatalog = NonNullable<RuntimeAwareProviderStatus['modelCatalog']>;
type RuntimeCatalogModel = RuntimeModelCatalog['models'][number];
interface VisibleTeamProviderModelsOptions {
  expandOpenCodeSummaryCatalog?: boolean;
}

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

const TEAM_PROVIDER_LABELS: Record<SupportedProviderId, string> = {
  anthropic: 'Anthropic',
  codex: 'Codex',
  gemini: 'Gemini',
  opencode: 'OpenCode',
};

const ANTHROPIC_ALIAS_LABELS = {
  fable: 'Fable 5',
  opus: 'Opus 4.8',
  sonnet: 'Sonnet 4.6',
  haiku: 'Haiku 4.5',
} as const;

const ANTHROPIC_VISIBLE_MODEL_FALLBACKS = [
  'fable',
  'claude-fable-5',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-opus-4-8[1m]',
  'claude-opus-4-7',
  'claude-opus-4-7[1m]',
] as const;

const ANTHROPIC_MODEL_ORDER = [
  'fable',
  'claude-fable-5',
  'claude-mythos-5',
  'haiku',
  'claude-haiku-4-5-20251001',
  'claude-haiku-4-5',
  'opus',
  'opus[1m]',
  'claude-opus-4-8',
  'claude-opus-4-8[1m]',
  'claude-opus-4-7',
  'claude-opus-4-7[1m]',
  'claude-opus-4-6',
  'claude-opus-4-6[1m]',
  'claude-sonnet-5',
  'sonnet',
  'sonnet[1m]',
  'claude-sonnet-4-6',
  'claude-sonnet-4-6[1m]',
] as const;

const TEAM_MODEL_LABEL_OVERRIDES: Record<string, string> = {
  default: 'Default',
  ...ANTHROPIC_ALIAS_LABELS,
  'claude-fable-5': 'Fable 5',
  'claude-mythos-5': 'Mythos 5',
  'claude-sonnet-5': 'Sonnet 5',
  'opus[1m]': 'Opus 4.8 (1M)',
  'sonnet[1m]': 'Sonnet 4.6 (1M)',
  'claude-opus-4-8': 'Opus 4.8',
  'claude-opus-4-8[1m]': 'Opus 4.8 (1M)',
  'claude-opus-4-7': 'Opus 4.7',
  'claude-opus-4-7[1m]': 'Opus 4.7 (1M)',
  'claude-sonnet-4-6': 'Sonnet 4.6',
  'claude-sonnet-4-6[1m]': 'Sonnet 4.6 (1M)',
  'claude-opus-4-6': 'Opus 4.6',
  'claude-opus-4-6[1m]': 'Opus 4.6 (1M)',
  'claude-haiku-4-5': 'Haiku 4.5',
  'claude-haiku-4-5-20251001': 'Haiku 4.5',
  'gpt-5.4': 'GPT-5.4',
  'gpt-5.5': 'GPT-5.5',
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
      { value: 'fable', label: 'Fable 5', badgeLabel: 'Fable 5' },
      { value: 'opus', label: 'Opus 4.8', badgeLabel: 'Opus 4.8' },
      { value: 'claude-sonnet-5', label: 'Sonnet 5', badgeLabel: 'Sonnet 5' },
      { value: 'claude-opus-4-7', label: 'Opus 4.7', badgeLabel: 'Opus 4.7' },
      { value: 'claude-opus-4-6', label: 'Opus 4.6', badgeLabel: 'Opus 4.6' },
      { value: 'sonnet', label: 'Sonnet 4.6', badgeLabel: 'Sonnet 4.6' },
      { value: 'haiku', label: 'Haiku 4.5', badgeLabel: 'Haiku 4.5' },
    ],
    codex: [
      { value: '', label: 'Default', badgeLabel: 'Default' },
      { value: 'gpt-5.5', label: 'GPT-5.5', badgeLabel: '5.5' },
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
    opencode: [{ value: '', label: 'Default', badgeLabel: 'Default' }],
  };

type AnthropicAliasFamily = keyof typeof ANTHROPIC_ALIAS_LABELS;

const TEAM_PROVIDER_MODEL_ORDER: Record<SupportedProviderId, Map<string, number>> = {
  anthropic: new Map(ANTHROPIC_MODEL_ORDER.map((model, index) => [model, index])),
  codex: new Map(TEAM_PROVIDER_MODEL_OPTIONS.codex.map((option, index) => [option.value, index])),
  gemini: new Map(TEAM_PROVIDER_MODEL_OPTIONS.gemini.map((option, index) => [option.value, index])),
  opencode: new Map(
    TEAM_PROVIDER_MODEL_OPTIONS.opencode.map((option, index) => [option.value, index])
  ),
};

function extractComparableModelVersion(model: string): number[] | null {
  const match = /(?:^|[^0-9])(\d+(?:[.-]\d+)*)(?:[^0-9]|$)/.exec(model);
  if (!match?.[1]) {
    return null;
  }

  const parts = match[1]
    .split(/[.-]/)
    .map(Number)
    .filter((part) => Number.isFinite(part));
  return parts.length > 0 ? parts : null;
}

/** Sorts dotted/dashed model versions newest-first without treating 5.10 as 5.1. */
export function compareTeamModelVersionsDescending(left: string, right: string): number {
  const leftVersion = extractComparableModelVersion(left);
  const rightVersion = extractComparableModelVersion(right);
  if (!leftVersion || !rightVersion) {
    if (leftVersion) return -1;
    if (rightVersion) return 1;
    return 0;
  }

  const partCount = Math.max(leftVersion.length, rightVersion.length);
  for (let index = 0; index < partCount; index += 1) {
    const difference = (rightVersion[index] ?? 0) - (leftVersion[index] ?? 0);
    if (difference !== 0) {
      return difference;
    }
  }
  return 0;
}

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
  'fable',
  'claude-fable-5',
  'opus',
  'opus[1m]',
  'sonnet',
  'sonnet[1m]',
  'haiku',
  'claude-sonnet-5',
  'claude-opus-4-8',
  'claude-opus-4-8[1m]',
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

export function isAnthropicSonnetTeamModel(model: string | undefined): boolean {
  const trimmed = model?.trim();
  if (!trimmed) {
    return false;
  }

  const { baseModel } = splitOneMillionContextSuffix(trimmed);
  return baseModel === 'sonnet' || baseModel.startsWith('claude-sonnet-');
}

export function isAnthropicOneMillionContextTeamModel(model: string | undefined): boolean {
  const trimmed = model?.trim();
  if (!trimmed) {
    return false;
  }

  return (
    inferContextWindowTokens({
      providerId: 'anthropic',
      modelName: trimmed,
      limitContext: false,
    }) === 1_000_000
  );
}

export function isAnthropicSonnetOneMillionContextTeamModel(model: string | undefined): boolean {
  return isAnthropicSonnetTeamModel(model) && isAnthropicOneMillionContextTeamModel(model);
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

  const parsedOpenCodeModel = parseOpenCodeQualifiedModelRef(trimmed);
  const labelTarget = parsedOpenCodeModel?.modelId ?? trimmed;

  const overrideLabel = TEAM_MODEL_LABEL_OVERRIDES[labelTarget];
  if (overrideLabel) {
    return overrideLabel;
  }

  return formatParsedClaudeModelLabel(labelTarget) ?? labelTarget;
}

const runtimeCatalogModelIndexCache = new WeakMap<
  RuntimeModelCatalog,
  Map<string, RuntimeCatalogModel>
>();

function getRuntimeCatalogModelIndex(
  catalog: RuntimeModelCatalog
): Map<string, RuntimeCatalogModel> {
  const cached = runtimeCatalogModelIndexCache.get(catalog);
  if (cached) {
    return cached;
  }

  const index = new Map<string, RuntimeCatalogModel>();
  for (const item of catalog.models) {
    if (item.launchModel && !index.has(item.launchModel)) {
      index.set(item.launchModel, item);
    }
    if (item.id && !index.has(item.id)) {
      index.set(item.id, item);
    }
  }
  runtimeCatalogModelIndexCache.set(catalog, index);
  return index;
}

function getRuntimeCatalogModel(
  providerId: SupportedProviderId | undefined,
  model: string | undefined,
  providerStatus?: RuntimeAwareProviderStatus | null
): RuntimeCatalogModel | null {
  const trimmed = model?.trim();
  if (!providerId || !trimmed || providerStatus?.modelCatalog?.providerId !== providerId) {
    return null;
  }

  return getRuntimeCatalogModelIndex(providerStatus.modelCatalog).get(trimmed) ?? null;
}

function getAnthropicAliasFamily(model: string | undefined): AnthropicAliasFamily | null {
  const baseModel =
    model
      ?.trim()
      .toLowerCase()
      .replace(/\[1m\]$/i, '') ?? '';
  if (
    baseModel === 'fable' ||
    baseModel === 'opus' ||
    baseModel === 'sonnet' ||
    baseModel === 'haiku'
  ) {
    return baseModel;
  }
  return null;
}

function readAnthropicDisplayVersion(
  label: string | undefined,
  family: AnthropicAliasFamily
): { major: number; minor: number | null } | null {
  const pattern = new RegExp(`\\b${family}\\s+(\\d+)(?:\\.(\\d+))?\\b`, 'i');
  const match = pattern.exec(label ?? '');
  if (!match) {
    return null;
  }

  const major = Number.parseInt(match[1], 10);
  const minor = match[2] == null ? null : Number.parseInt(match[2], 10);
  if (!Number.isFinite(major) || (minor !== null && !Number.isFinite(minor))) {
    return null;
  }

  return { major, minor };
}

function compareAnthropicDisplayVersions(
  left: { major: number; minor: number | null },
  right: { major: number; minor: number | null }
): number {
  if (left.major !== right.major) {
    return left.major - right.major;
  }
  return (left.minor ?? 0) - (right.minor ?? 0);
}

function getRuntimeSafeAnthropicAliasLabel(params: {
  model: string | undefined;
  runtimeLabel?: string | null;
  fallbackLabel?: string;
}): string | null {
  const family = getAnthropicAliasFamily(params.model);
  if (!family) {
    return null;
  }

  const fallbackLabel =
    params.fallbackLabel ?? getProviderScopedTeamModelLabel('anthropic', params.model);
  if (!fallbackLabel) {
    return null;
  }

  const runtimeLabel = params.runtimeLabel?.trim();
  if (!runtimeLabel) {
    return fallbackLabel;
  }

  const runtimeVersion = readAnthropicDisplayVersion(runtimeLabel, family);
  const fallbackVersion = readAnthropicDisplayVersion(fallbackLabel, family);
  if (
    runtimeVersion &&
    fallbackVersion &&
    compareAnthropicDisplayVersions(runtimeVersion, fallbackVersion) >= 0
  ) {
    return getProviderScopedTeamModelLabel('anthropic', runtimeLabel) ?? runtimeLabel;
  }

  return fallbackLabel;
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
  if (providerId === 'opencode') {
    return getTeamModelLabel(trimmed) ?? trimmed;
  }
  return trimmed;
}

export function getTeamModelSourceBadgeLabel(
  providerId: SupportedProviderId,
  model: string | undefined
): string | undefined {
  if (providerId !== 'opencode') {
    return undefined;
  }

  return getOpenCodeQualifiedModelSourceLabel(model) ?? undefined;
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

export function getRuntimeAwareProviderScopedTeamModelLabel(
  providerId: SupportedProviderId,
  model: string | undefined,
  providerStatus?: RuntimeAwareProviderStatus | null
): string | undefined {
  const trimmed = model?.trim();
  const runtimeModel = getRuntimeCatalogModel(providerId, model, providerStatus);
  const runtimeLabel = runtimeModel?.displayName?.trim();
  const safeAnthropicAliasLabel =
    providerId === 'anthropic'
      ? getRuntimeSafeAnthropicAliasLabel({ model: trimmed, runtimeLabel })
      : null;
  if (safeAnthropicAliasLabel) {
    return safeAnthropicAliasLabel;
  }

  if (runtimeLabel) {
    return getProviderScopedTeamModelLabel(providerId, runtimeLabel) ?? runtimeLabel;
  }

  return getProviderScopedTeamModelLabel(providerId, model);
}

export function getRuntimeAwareTeamModelBadgeLabel(
  providerId: SupportedProviderId,
  model: string | undefined,
  providerStatus?: RuntimeAwareProviderStatus | null
): string | undefined {
  const trimmed = model?.trim();
  const runtimeModel = getRuntimeCatalogModel(providerId, model, providerStatus);
  const safeAnthropicAliasLabel =
    providerId === 'anthropic'
      ? getRuntimeSafeAnthropicAliasLabel({
          model: trimmed,
          runtimeLabel: runtimeModel?.badgeLabel?.trim() || runtimeModel?.displayName?.trim(),
          fallbackLabel: getTeamModelBadgeLabel(providerId, trimmed),
        })
      : null;
  if (safeAnthropicAliasLabel) {
    return safeAnthropicAliasLabel;
  }

  if (runtimeModel?.badgeLabel?.trim()) {
    return runtimeModel.badgeLabel.trim();
  }

  return getTeamModelBadgeLabel(providerId, model);
}

function hasExplicitFreeOpenCodeModelMarker(model: string): boolean {
  const normalized = model.trim().toLowerCase();
  return (
    normalized === 'opencode/big-pickle' ||
    normalized.includes(':free') ||
    normalized.endsWith('-free') ||
    normalized.endsWith('/free')
  );
}

function isFreeOpenCodeModelForOrdering(
  providerId: SupportedProviderId,
  model: string,
  providerStatus?: RuntimeAwareProviderStatus | null
): boolean {
  if (providerId !== 'opencode') {
    return false;
  }

  const runtimeModel = getRuntimeCatalogModel(providerId, model, providerStatus);
  if (runtimeModel?.metadata?.free === true) {
    return true;
  }

  const badgeLabel = runtimeModel?.badgeLabel?.trim().toLowerCase();
  if (badgeLabel) {
    return badgeLabel === 'free';
  }

  return hasExplicitFreeOpenCodeModelMarker(model);
}

export function sortTeamProviderModels(
  providerId: SupportedProviderId,
  models: readonly string[],
  providerStatus?: RuntimeAwareProviderStatus | null
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

  const sorted = [...deduped].sort((left, right) => {
    if (providerId === 'codex') {
      const versionOrder = compareTeamModelVersionsDescending(left, right);
      if (versionOrder !== 0) {
        return versionOrder;
      }
    }
    const leftRank = order.get(left) ?? Number.MAX_SAFE_INTEGER;
    const rightRank = order.get(right) ?? Number.MAX_SAFE_INTEGER;
    if (leftRank !== rightRank) {
      return leftRank - rightRank;
    }
    return left.localeCompare(right);
  });

  if (providerId !== 'opencode') {
    return sorted;
  }

  return sorted
    .map((model, index) => ({ model, index }))
    .sort((left, right) => {
      const leftFree = isFreeOpenCodeModelForOrdering(providerId, left.model, providerStatus);
      const rightFree = isFreeOpenCodeModelForOrdering(providerId, right.model, providerStatus);
      if (leftFree !== rightFree) {
        return leftFree ? -1 : 1;
      }
      return left.index - right.index;
    })
    .map((entry) => entry.model);
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

function getRuntimeCatalogLaunchModels(
  providerId: SupportedProviderId,
  providerStatus?: RuntimeAwareProviderStatus | null
): string[] | null {
  if (providerStatus?.modelCatalog?.providerId !== providerId) {
    return null;
  }

  const models = providerStatus.modelCatalog.models
    .filter((model) => !model.hidden)
    .map((model) => model.launchModel.trim() || model.id.trim())
    .filter(Boolean);
  return models.length > 0 ? models : null;
}

function isOpenCodeSummaryOnlyModelList(
  models: readonly string[],
  providerStatus?: RuntimeAwareProviderStatus | null
): boolean {
  if (providerStatus?.modelCatalog?.providerId !== 'opencode') {
    return false;
  }

  const trimmedModels = models.map((model) => model.trim()).filter(Boolean);
  if (trimmedModels.length !== 1) {
    return false;
  }

  const summaryModel = trimmedModels[0].toLowerCase();
  const catalogDefaultIds = [
    providerStatus.modelCatalog.defaultLaunchModel,
    providerStatus.modelCatalog.defaultModelId,
    providerStatus.modelCatalog.models.find((model) => model.isDefault)?.launchModel,
    providerStatus.modelCatalog.models.find((model) => model.isDefault)?.id,
  ]
    .map((model) => model?.trim().toLowerCase())
    .filter((model): model is string => Boolean(model));

  return summaryModel === 'opencode/big-pickle' || catalogDefaultIds.includes(summaryModel);
}

function mergeModelLists(primary: readonly string[], supplemental: readonly string[]): string[] {
  const merged = new Map<string, string>();
  for (const model of [...primary, ...supplemental]) {
    const trimmed = model.trim();
    if (!trimmed) {
      continue;
    }
    const key = trimmed.toLowerCase();
    if (!merged.has(key)) {
      merged.set(key, trimmed);
    }
  }
  return Array.from(merged.values());
}

function getSupplementalVisibleModels(
  providerId: SupportedProviderId,
  models: readonly string[]
): readonly string[] {
  if (providerId !== 'anthropic') {
    return models;
  }

  const existingLabels = new Set(
    models
      .map((model) => getTeamModelBadgeLabel(providerId, model)?.trim().toLowerCase())
      .filter((label): label is string => Boolean(label))
  );
  const supplementalModels: string[] = [];
  for (const model of ANTHROPIC_VISIBLE_MODEL_FALLBACKS) {
    const label = getTeamModelBadgeLabel(providerId, model)?.trim().toLowerCase();
    if (label && existingLabels.has(label)) {
      continue;
    }
    supplementalModels.push(model);
    if (label) {
      existingLabels.add(label);
    }
  }

  return [...models, ...supplementalModels];
}

export function getVisibleTeamProviderModels(
  providerId: SupportedProviderId,
  models: readonly string[],
  providerStatus?: RuntimeAwareProviderStatus | null,
  options: VisibleTeamProviderModelsOptions = {}
): string[] {
  const expandOpenCodeSummaryCatalog = options.expandOpenCodeSummaryCatalog ?? true;
  const hasExplicitModels = models.some((model) => model.trim().length > 0);
  const catalogModels =
    providerId === 'opencode' ? getRuntimeCatalogLaunchModels(providerId, providerStatus) : null;
  const sourceModels =
    providerId === 'opencode' &&
    catalogModels &&
    (!hasExplicitModels ||
      (expandOpenCodeSummaryCatalog && isOpenCodeSummaryOnlyModelList(models, providerStatus)))
      ? mergeModelLists(catalogModels, models)
      : models;

  return sortTeamProviderModels(
    providerId,
    filterVisibleProviderRuntimeModels(
      providerId,
      getSupplementalVisibleModels(providerId, sourceModels)
    ),
    providerStatus
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
    const runtimeModel = getRuntimeCatalogModel(providerId, model, providerStatus);
    if (
      providerId === 'anthropic' &&
      providerStatus?.modelCatalog?.status !== 'unavailable' &&
      runtimeModel &&
      !runtimeModel.hidden
    ) {
      return null;
    }
    return staticReason;
  }

  const trimmed = model?.trim();
  if (!providerId || !trimmed) {
    return null;
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
