import { calculateMessageCost, getPricing } from '@shared/utils/pricing';

import { normalizeBillingMode, normalizeCostBreakdown } from './tokenUsageTotals';

import type {
  TokenUsageBillingMode,
  TokenUsageCostBreakdownDto,
  TokenUsageEventDto,
  TokenUsageRunDto,
} from '../../contracts';

export interface AttributionResult {
  attributed: TokenUsageEventDto[];
  unmappedEventCount: number;
}

export function keepOnlyMappedUsageEvents(params: {
  runs: readonly TokenUsageRunDto[];
  events: readonly TokenUsageEventDto[];
}): AttributionResult {
  const runById = new Map(params.runs.map((run) => [run.appRunId, run]));
  const attributed: TokenUsageEventDto[] = [];
  let unmappedEventCount = 0;

  for (const event of params.events) {
    if (runById.has(event.appRunId)) {
      attributed.push(event);
    } else {
      unmappedEventCount += 1;
    }
  }

  return {
    attributed: dropSupersededUnmodeledEvents(attributed).map((event) =>
      enrichEventFromRun(event, runById.get(event.appRunId))
    ),
    unmappedEventCount,
  };
}

function enrichEventFromRun(
  event: TokenUsageEventDto,
  run: TokenUsageRunDto | undefined
): TokenUsageEventDto {
  if (!run) return event;
  const model = event.model ?? run.model;
  const billingMode = normalizeBillingMode(event.billingMode ?? run.billingMode);
  return {
    ...event,
    runtimeKind: run.runtimeKind,
    providerId: event.providerId ?? run.providerId,
    providerBackendId: event.providerBackendId ?? run.providerBackendId,
    billingMode,
    model,
    cost: enrichCostFromModel(event, model, billingMode),
  };
}

function enrichCostFromModel(
  event: TokenUsageEventDto,
  model: string | undefined,
  billingMode: TokenUsageBillingMode
): TokenUsageCostBreakdownDto {
  const currentCost = normalizeCostBreakdown({
    ...event.cost,
    billingMode: event.cost.billingMode ?? billingMode,
  });
  if (currentCost.apiEquivalentUsd > 0 || event.model) return currentCost;
  if (!model || !getPricing(model)) {
    return normalizeCostBreakdown({ estimatedUsd: 0, source: 'unknown', billingMode });
  }

  return normalizeCostBreakdown({
    estimatedUsd: calculateMessageCost(
      model,
      event.tokens.inputTokens,
      event.tokens.outputTokens,
      event.tokens.cacheReadTokens,
      event.tokens.cacheCreationTokens
    ),
    source: 'pricing_table',
    billingMode,
  });
}

function dropSupersededUnmodeledEvents(
  events: readonly TokenUsageEventDto[]
): TokenUsageEventDto[] {
  const modeledKeys = new Set<string>();
  for (const event of events) {
    if (!event.model) continue;
    const key = dedupeKey(event);
    if (key) modeledKeys.add(key);
  }

  if (modeledKeys.size === 0) return [...events];
  return events.filter((event) => {
    if (event.model) return true;
    const key = dedupeKey(event);
    return !key || !modeledKeys.has(key);
  });
}

function dedupeKey(event: TokenUsageEventDto): string | undefined {
  if (!event.nativeSessionId) return undefined;
  return [event.appRunId, event.nativeSessionId, rawSourceName(event)].join('\0');
}

function rawSourceName(event: TokenUsageEventDto): string {
  const rawUsageJson = event.rawUsageJson;
  if (rawUsageJson === null || typeof rawUsageJson !== 'object' || Array.isArray(rawUsageJson)) {
    return 'unknown-source';
  }
  const sourceName = (rawUsageJson as { sourceName?: unknown }).sourceName;
  return typeof sourceName === 'string' && sourceName.trim().length > 0
    ? sourceName.trim()
    : 'unknown-source';
}
