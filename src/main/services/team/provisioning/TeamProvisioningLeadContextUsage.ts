import { getAnthropicDefaultTeamModel } from '@shared/utils/anthropicModelDefaults';
import { inferContextWindowTokens } from '@shared/utils/contextMetrics';
import { normalizeOptionalTeamProviderId } from '@shared/utils/teamProvider';

import type { LeadContextUsage } from '@shared/types';

export interface LeadContextUsageRequestLike {
  providerId?: string;
  model?: string;
  limitContext?: boolean;
}

export interface LeadContextUsageState {
  promptInputTokens: number | null;
  outputTokens: number | null;
  contextUsedTokens: number | null;
  contextWindowTokens: number | null;
  promptInputSource: LeadContextUsage['promptInputSource'];
}

export function getInitialLeadContextWindowTokensForRequest(
  request: LeadContextUsageRequestLike
): number | null {
  const providerId = normalizeOptionalTeamProviderId(request.providerId);
  const modelName =
    typeof request.model === 'string' && request.model.trim().length > 0
      ? request.model.trim()
      : providerId === 'anthropic'
        ? getAnthropicDefaultTeamModel(request.limitContext === true)
        : undefined;

  return inferContextWindowTokens({
    providerId,
    modelName,
    limitContext: request.limitContext === true,
  });
}

export function buildLeadContextUsagePayloadFromState(
  usage: LeadContextUsageState | null | undefined,
  updatedAt: string
): LeadContextUsage {
  if (!usage) {
    return {
      promptInputTokens: null,
      outputTokens: null,
      contextUsedTokens: null,
      contextWindowTokens: null,
      contextUsedPercent: null,
      promptInputSource: 'unavailable',
      updatedAt,
    };
  }

  const { contextUsedTokens, contextWindowTokens } = usage;
  const percentRaw =
    contextUsedTokens !== null && contextWindowTokens !== null && contextWindowTokens > 0
      ? Math.round((contextUsedTokens / contextWindowTokens) * 100)
      : null;

  return {
    promptInputTokens: usage.promptInputTokens,
    outputTokens: usage.outputTokens,
    contextUsedTokens: usage.contextUsedTokens,
    contextWindowTokens: usage.contextWindowTokens,
    contextUsedPercent: percentRaw === null ? null : Math.max(0, Math.min(100, percentRaw)),
    promptInputSource: usage.promptInputSource,
    updatedAt,
  };
}
