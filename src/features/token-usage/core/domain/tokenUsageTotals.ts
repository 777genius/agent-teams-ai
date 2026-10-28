import type {
  TokenUsageBillingMode,
  TokenUsageCostBreakdownDto,
  TokenUsageEventDto,
  TokenUsageSourceKind,
  TokenUsageSummaryDto,
  TokenUsageTokenBreakdownDto,
} from '../../contracts';

export const ZERO_TOKEN_USAGE_SUMMARY: TokenUsageSummaryDto = {
  requestCount: 0,
  runCount: 0,
  runningRunCount: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  reasoningTokens: 0,
  estimatedCostUsd: 0,
  billableCostUsd: 0,
  apiEquivalentCostUsd: 0,
  costKnownEventCount: 0,
  billableEventCount: 0,
  apiBillingRequestCount: 0,
  subscriptionRequestCount: 0,
  freeRequestCount: 0,
  unknownBillingRequestCount: 0,
  apiBillingTokens: 0,
  subscriptionTokens: 0,
  freeTokens: 0,
  unknownBillingTokens: 0,
  exactEventCount: 0,
  estimatedEventCount: 0,
  kiroCredits: 0,
  kiroCreditEventCount: 0,
};

export function normalizeTokenBreakdown(
  tokens: Partial<TokenUsageTokenBreakdownDto>
): TokenUsageTokenBreakdownDto {
  const inputTokens = positive(tokens.inputTokens);
  const outputTokens = positive(tokens.outputTokens);
  const cacheCreationTokens = positive(tokens.cacheCreationTokens);
  const cacheReadTokens = positive(tokens.cacheReadTokens);
  const reasoningTokens = positive(tokens.reasoningTokens);
  const audioTokens = positive(tokens.audioTokens);
  const imageTokens = positive(tokens.imageTokens);
  const explicitTotal = positive(tokens.totalTokens);
  const computedTotal =
    inputTokens +
    outputTokens +
    cacheCreationTokens +
    cacheReadTokens +
    reasoningTokens +
    audioTokens +
    imageTokens;

  return {
    inputTokens,
    outputTokens,
    cacheCreationTokens,
    cacheReadTokens,
    reasoningTokens,
    audioTokens,
    imageTokens,
    totalTokens: explicitTotal > 0 ? explicitTotal : computedTotal,
  };
}

export function normalizeCostBreakdown(
  cost: Partial<TokenUsageCostBreakdownDto> | undefined
): TokenUsageCostBreakdownDto {
  const source = cost?.source ?? 'unknown';
  const apiEquivalentUsd = positive(cost?.apiEquivalentUsd ?? cost?.estimatedUsd);
  const explicitBillable =
    typeof cost?.billableUsd === 'number' &&
    Number.isFinite(cost.billableUsd) &&
    cost.billableUsd >= 0;
  const billableUsd = explicitBillable
    ? cost.billableUsd!
    : source === 'provider' || source === 'gateway'
      ? positive(cost?.estimatedUsd)
      : 0;
  return {
    estimatedUsd: apiEquivalentUsd,
    billableUsd,
    apiEquivalentUsd,
    source,
    billingMode: normalizeBillingMode(cost?.billingMode),
  };
}

export function isExactUsageSource(sourceKind: TokenUsageSourceKind): boolean {
  return sourceKind === 'sdk_exact' || sourceKind === 'gateway_exact';
}

export function addEventToSummary(
  summary: TokenUsageSummaryDto,
  event: TokenUsageEventDto
): TokenUsageSummaryDto {
  const exact = isExactUsageSource(event.usageSourceKind);
  const cost = normalizeCostBreakdown(event.cost);
  const billingMode = normalizeBillingMode(event.billingMode ?? cost.billingMode);
  const requestCount = normalizeRequestCount(event.requestCount);
  const billingCounts = billingSummaryDelta(billingMode, event.tokens.totalTokens, requestCount);
  const kiroUsage = event.providerUsage?.kiro;
  const previousKiroOccurredAt = summary.lastKiroCreditsAt;
  const hasNewerKiroUsage = Boolean(
    kiroUsage &&
    (!previousKiroOccurredAt || event.occurredAt.localeCompare(previousKiroOccurredAt) >= 0)
  );
  return {
    requestCount: summary.requestCount + requestCount,
    runCount: summary.runCount,
    runningRunCount: summary.runningRunCount,
    totalTokens: summary.totalTokens + event.tokens.totalTokens,
    inputTokens: summary.inputTokens + event.tokens.inputTokens,
    outputTokens: summary.outputTokens + event.tokens.outputTokens,
    cacheCreationTokens: summary.cacheCreationTokens + event.tokens.cacheCreationTokens,
    cacheReadTokens: summary.cacheReadTokens + event.tokens.cacheReadTokens,
    reasoningTokens: summary.reasoningTokens + event.tokens.reasoningTokens,
    estimatedCostUsd: summary.estimatedCostUsd + cost.apiEquivalentUsd,
    billableCostUsd: summary.billableCostUsd + cost.billableUsd,
    apiEquivalentCostUsd: summary.apiEquivalentCostUsd + cost.apiEquivalentUsd,
    costKnownEventCount: summary.costKnownEventCount + (cost.source === 'unknown' ? 0 : 1),
    billableEventCount: summary.billableEventCount + (cost.billableUsd > 0 ? 1 : 0),
    apiBillingRequestCount: summary.apiBillingRequestCount + billingCounts.apiRequestCount,
    subscriptionRequestCount:
      summary.subscriptionRequestCount + billingCounts.subscriptionRequestCount,
    freeRequestCount: summary.freeRequestCount + billingCounts.freeRequestCount,
    unknownBillingRequestCount:
      summary.unknownBillingRequestCount + billingCounts.unknownRequestCount,
    apiBillingTokens: summary.apiBillingTokens + billingCounts.apiTokens,
    subscriptionTokens: summary.subscriptionTokens + billingCounts.subscriptionTokens,
    freeTokens: summary.freeTokens + billingCounts.freeTokens,
    unknownBillingTokens: summary.unknownBillingTokens + billingCounts.unknownTokens,
    exactEventCount: summary.exactEventCount + (exact ? 1 : 0),
    estimatedEventCount: summary.estimatedEventCount + (exact ? 0 : 1),
    kiroCredits: (summary.kiroCredits ?? 0) + (kiroUsage?.credits ?? 0),
    kiroCreditEventCount: (summary.kiroCreditEventCount ?? 0) + (kiroUsage ? 1 : 0),
    lastKiroCredits: hasNewerKiroUsage ? kiroUsage?.credits : summary.lastKiroCredits,
    lastKiroCreditsAt: hasNewerKiroUsage ? event.occurredAt : summary.lastKiroCreditsAt,
    kiroCreditsUnit: hasNewerKiroUsage ? kiroUsage?.creditsUnit : summary.kiroCreditsUnit,
  };
}

export function normalizeBillingMode(value: unknown): TokenUsageBillingMode {
  return value === 'api' || value === 'subscription' || value === 'free' ? value : 'unknown';
}

export function normalizeRequestCount(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 ? value : 1;
}

function billingSummaryDelta(
  billingMode: TokenUsageBillingMode,
  totalTokens: number,
  requestCount: number
): {
  apiRequestCount: number;
  subscriptionRequestCount: number;
  freeRequestCount: number;
  unknownRequestCount: number;
  apiTokens: number;
  subscriptionTokens: number;
  freeTokens: number;
  unknownTokens: number;
} {
  return {
    apiRequestCount: billingMode === 'api' ? requestCount : 0,
    subscriptionRequestCount: billingMode === 'subscription' ? requestCount : 0,
    freeRequestCount: billingMode === 'free' ? requestCount : 0,
    unknownRequestCount: billingMode === 'unknown' ? requestCount : 0,
    apiTokens: billingMode === 'api' ? totalTokens : 0,
    subscriptionTokens: billingMode === 'subscription' ? totalTokens : 0,
    freeTokens: billingMode === 'free' ? totalTokens : 0,
    unknownTokens: billingMode === 'unknown' ? totalTokens : 0,
  };
}

export function buildSourceCounts(
  events: readonly TokenUsageEventDto[]
): Record<TokenUsageSourceKind, number> {
  const counts: Record<TokenUsageSourceKind, number> = {
    sdk_exact: 0,
    gateway_exact: 0,
    log_parsed: 0,
    tokenizer_estimated: 0,
    cost_estimated: 0,
  };
  for (const event of events) {
    counts[event.usageSourceKind] += 1;
  }
  return counts;
}

export function addRunToSummary(
  summary: TokenUsageSummaryDto,
  running: boolean
): TokenUsageSummaryDto {
  return {
    ...summary,
    runCount: summary.runCount + 1,
    runningRunCount: summary.runningRunCount + (running ? 1 : 0),
  };
}

function positive(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}
