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
