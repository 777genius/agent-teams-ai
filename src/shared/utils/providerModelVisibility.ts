import { parseOpenCodeQualifiedModelRef } from './opencodeModelRef';

import type { CliProviderId, TeamProviderId } from '@shared/types';

type SupportedProviderId = CliProviderId | TeamProviderId;

export const GPT_5_1_CODEX_MINI_UI_DISABLED_MODEL = 'gpt-5.1-codex-mini';
export const GPT_5_2_CODEX_UI_DISABLED_MODEL = 'gpt-5.2-codex';
export const GPT_5_3_CODEX_SPARK_UI_DISABLED_MODEL = 'gpt-5.3-codex-spark';

const ANTHROPIC_CLAUDE_CODE_REMOVED_MODEL_PREFIXES = [
  'claude-opus-4-1',
  'claude-opus-4-20250514',
  'claude-sonnet-4-20250514',
] as const;

const UI_DISABLED_MODELS_BY_PROVIDER: Partial<Record<SupportedProviderId, readonly string[]>> = {
  codex: [
    GPT_5_3_CODEX_SPARK_UI_DISABLED_MODEL,
    GPT_5_2_CODEX_UI_DISABLED_MODEL,
    GPT_5_1_CODEX_MINI_UI_DISABLED_MODEL,
  ],
};

function modelIdMatchesPrefix(modelId: string, prefix: string): boolean {
  return modelId === prefix || modelId.startsWith(`${prefix}-`);
}

export function isAnthropicClaudeCodeRemovedModel(model: string | undefined): boolean {
  const normalized = model?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return ANTHROPIC_CLAUDE_CODE_REMOVED_MODEL_PREFIXES.some((prefix) =>
    modelIdMatchesPrefix(normalized, prefix)
  );
}

export function isCurrentMiniMaxCatalogModel(
  model: string,
  runtimeProviderId: SupportedProviderId = 'opencode'
): boolean {
  if (runtimeProviderId !== 'opencode') {
    return true;
  }
  const route = parseOpenCodeQualifiedModelRef(model);
  if (!route) {
    return true;
  }

  let modelId = route.modelId.toLowerCase();
  const isDirect = [
    'minimax',
    'minimax-cn',
    'minimax-coding-plan',
    'minimax-cn-coding-plan',
  ].includes(route.sourceId);
  const isOpenRouter = route.sourceId === 'openrouter' && modelId.startsWith('minimax/');
  const isZen = route.sourceId === 'opencode' && modelId.startsWith('minimax-');
  if (!isDirect && !isOpenRouter && !isZen) {
    return true;
  }
  if (isOpenRouter) {
    modelId = modelId.slice('minimax/'.length);
  }
  // Keep non-text models and arbitrary custom routes outside this picker policy.
  if (!/^(?:minimax-(?:m\d|text|vl|01)|abab)/.test(modelId)) {
    return true;
  }
  // Gateway aliases identify the underlying model, but never establish availability.
  // Direct MiniMax routes must use the exact official model ID without an alias.
  const underlyingModel = isDirect ? modelId : modelId.replace(/(?::free|-free)$/, '');
  return underlyingModel === 'minimax-m3' || underlyingModel === 'minimax-m3.1-flash';
}

export function isProviderRuntimeModelUiDisabled(
  providerId: SupportedProviderId | undefined,
  model: string | undefined
): boolean {
  const trimmed = model?.trim();
  if (!providerId || !trimmed) {
    return false;
  }

  return UI_DISABLED_MODELS_BY_PROVIDER[providerId]?.includes(trimmed) ?? false;
}

export function filterVisibleProviderRuntimeModels(
  providerId: SupportedProviderId,
  models: readonly string[]
): string[] {
  const seen = new Set<string>();
  const visible: string[] = [];

  for (const model of models) {
    const trimmed = model.trim();
    if (!trimmed || seen.has(trimmed) || isProviderRuntimeModelUiDisabled(providerId, trimmed)) {
      continue;
    }

    seen.add(trimmed);
    visible.push(trimmed);
  }

  return visible;
}
