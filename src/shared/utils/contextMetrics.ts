import { inferTeamProviderIdFromModel } from './teamProvider';

import type { TeamProviderId } from '@shared/types/team';

const ANTHROPIC_DEFAULT_CONTEXT_WINDOW = 200_000;
const ANTHROPIC_EXTENDED_CONTEXT_WINDOW = 1_000_000;
const OPENAI_COMPACT_CONTEXT_WINDOW = 200_000;
const OPENAI_DEFAULT_CONTEXT_WINDOW = 400_000;
const OPENAI_LONG_CONTEXT_WINDOW = 1_050_000;

export interface ContextUsageLike {
  input_tokens?: number;
  output_tokens?: number;
  cache_read_input_tokens?: number;
  cache_creation_input_tokens?: number;
  prompt_tokens?: number;
  completion_tokens?: number;
  total_tokens?: number;
  input_tokens_details?: {
    cached_tokens?: number;
  };
  prompt_tokens_details?: {
    cached_tokens?: number;
  };
  output_tokens_details?: {
    reasoning_tokens?: number;
  };
  completion_tokens_details?: {
    reasoning_tokens?: number;
  };
}

export type PromptInputSource =
  | 'anthropic_usage'
  | 'openai_responses_usage'
  | 'openai_chat_usage'
  | 'unavailable';

export interface DerivedContextMetrics {
  providerId: TeamProviderId | undefined;
  modelName: string | undefined;
  contextWindowTokens: number | null;
  promptInputTokens: number | null;
  outputTokens: number | null;
  contextUsedTokens: number | null;
  visibleContextTokens: number;
  promptInputSource: PromptInputSource;
  contextUsedSource: PromptInputSource | 'unavailable';
  promptInputPercentOfContextWindow: number | null;
  contextUsedPercentOfContextWindow: number | null;
  visibleContextPercentOfPromptInput: number | null;
}

interface InferContextWindowTokensParams {
  providerId?: TeamProviderId;
  modelName?: string;
  limitContext?: boolean;
}

interface DeriveContextMetricsParams extends InferContextWindowTokensParams {
  usage?: ContextUsageLike | null;
  contextWindowTokens?: number | null;
  visibleContextTokens?: number;
}

function readFiniteNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function readPositiveNumber(value: unknown): number | null {
  const num = readFiniteNumber(value);
  return num !== null && num > 0 ? num : null;
}

function computePercent(tokens: number | null, totalTokens: number | null): number | null {
  if (tokens === null || totalTokens === null || totalTokens <= 0) {
    return null;
  }
  if (!Number.isFinite(tokens) || tokens <= 0) {
    return 0;
  }
  return Math.min((tokens / totalTokens) * 100, 100);
}

function isOpenAiLongContextModel(modelName: string | undefined): boolean {
  const normalized = modelName?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return (
    normalized === 'gpt-5.4' ||
    normalized.startsWith('gpt-5.4-202') ||
    normalized === 'gpt-5.4-pro' ||
    normalized.startsWith('gpt-5.4-pro-202')
  );
}

function isOpenAiCompactContextModel(modelName: string | undefined): boolean {
  const normalized = modelName?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  return normalized === 'codex-mini-latest' || normalized.startsWith('codex-mini-latest-');
}

function isAnthropicNativeLongContextModel(modelName: string | undefined): boolean {
  const normalized = modelName?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }

  if (normalized.startsWith('claude-mythos')) {
    return true;
  }

  const claude4MinorMatch = /^claude-(opus|sonnet)-4-(\d{1,2})(?:-|$)/.exec(normalized);
  if (!claude4MinorMatch) {
    return false;
  }

  const minorVersion = Number.parseInt(claude4MinorMatch[2], 10);
  return Number.isFinite(minorVersion) && minorVersion >= 6;
}

function hasOpenAiPromptDetails(usage: ContextUsageLike): boolean {
  return (
    readFiniteNumber(usage.input_tokens_details?.cached_tokens) !== null ||
    readFiniteNumber(usage.prompt_tokens_details?.cached_tokens) !== null
  );
}

export function inferContextWindowTokens({
  providerId,
  modelName,
  limitContext,
}: InferContextWindowTokensParams): number | null {
  const resolvedProviderId = providerId ?? inferTeamProviderIdFromModel(modelName);
  const normalizedModel = modelName?.trim().toLowerCase();

  if (resolvedProviderId === 'anthropic') {
    if (limitContext) {
      return ANTHROPIC_DEFAULT_CONTEXT_WINDOW;
    }
    if (normalizedModel?.includes('[1m]') || isAnthropicNativeLongContextModel(normalizedModel)) {
      return ANTHROPIC_EXTENDED_CONTEXT_WINDOW;
    }
    return ANTHROPIC_DEFAULT_CONTEXT_WINDOW;
  }

  if (resolvedProviderId === 'codex') {
    if (isOpenAiCompactContextModel(normalizedModel)) {
      return OPENAI_COMPACT_CONTEXT_WINDOW;
    }
    return isOpenAiLongContextModel(normalizedModel)
      ? OPENAI_LONG_CONTEXT_WINDOW
      : OPENAI_DEFAULT_CONTEXT_WINDOW;
  }

  return null;
}

export function deriveContextMetrics({
  usage,
  providerId,
  modelName,
  contextWindowTokens,
  visibleContextTokens = 0,
  limitContext,
}: DeriveContextMetricsParams): DerivedContextMetrics {
  const resolvedProviderId = providerId ?? inferTeamProviderIdFromModel(modelName);
  const resolvedContextWindowTokens =
    readPositiveNumber(contextWindowTokens) ??
    inferContextWindowTokens({
      providerId: resolvedProviderId,
      modelName,
      limitContext,
    });
  const safeVisibleContextTokens =
    Number.isFinite(visibleContextTokens) && visibleContextTokens > 0 ? visibleContextTokens : 0;
  const safeUsage = usage ?? {};
  const outputTokens =
    readFiniteNumber(safeUsage.output_tokens) ?? readFiniteNumber(safeUsage.completion_tokens);
  const promptTokens = readFiniteNumber(safeUsage.prompt_tokens);
  const inputTokens = readFiniteNumber(safeUsage.input_tokens);
  const cacheReadTokens = readFiniteNumber(safeUsage.cache_read_input_tokens) ?? 0;
  const cacheCreationTokens = readFiniteNumber(safeUsage.cache_creation_input_tokens) ?? 0;

  let promptInputTokens: number | null = null;
  let promptInputSource: PromptInputSource = 'unavailable';

  if (promptTokens !== null) {
    promptInputTokens = promptTokens;
    promptInputSource = 'openai_chat_usage';
  } else if (inputTokens !== null) {
    const shouldUseAnthropicFormula =
      resolvedProviderId === 'anthropic' || cacheReadTokens > 0 || cacheCreationTokens > 0;

    if (shouldUseAnthropicFormula) {
      promptInputTokens = inputTokens + cacheReadTokens + cacheCreationTokens;
      promptInputSource = 'anthropic_usage';
    } else {
      const missingOpenAiPromptTelemetry =
        resolvedProviderId === 'codex' &&
        inputTokens === 0 &&
        cacheReadTokens === 0 &&
        cacheCreationTokens === 0 &&
        !hasOpenAiPromptDetails(safeUsage);

      if (!missingOpenAiPromptTelemetry) {
        promptInputTokens = inputTokens;
        promptInputSource = 'openai_responses_usage';
      }
    }
  }

  const contextUsedTokens =
    promptInputTokens !== null && outputTokens !== null ? promptInputTokens + outputTokens : null;

  return {
    providerId: resolvedProviderId,
    modelName,
    contextWindowTokens: resolvedContextWindowTokens,
    promptInputTokens,
    outputTokens,
    contextUsedTokens,
    visibleContextTokens: safeVisibleContextTokens,
    promptInputSource,
    contextUsedSource: contextUsedTokens !== null ? promptInputSource : 'unavailable',
    promptInputPercentOfContextWindow: computePercent(
      promptInputTokens,
      resolvedContextWindowTokens
    ),
    contextUsedPercentOfContextWindow: computePercent(
      contextUsedTokens,
      resolvedContextWindowTokens
    ),
    visibleContextPercentOfPromptInput: computePercent(safeVisibleContextTokens, promptInputTokens),
  };
}
