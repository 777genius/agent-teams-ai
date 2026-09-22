import type {
  TokenUsageAnalyticsSnapshotDto,
  TokenUsageBillingMode,
  TokenUsageBreakdownItemDto,
  TokenUsageBudgetLimitDto,
  TokenUsageBudgetSettingsDto,
  TokenUsageCommandRunDto,
  TokenUsageRecentRunDto,
  TokenUsageRunSourceDto,
  TokenUsageRunStatus,
  TokenUsageRuntimeKind,
  TokenUsageSessionRunDto,
  TokenUsageSummaryDto,
  TokenUsageTaskBreakdownItemDto,
  TokenUsageTimeSeriesPointDto,
  TokenUsageTokenBreakdownDto,
} from './dto';

const SOURCE_KIND_KEYS = [
  'sdk_exact',
  'gateway_exact',
  'log_parsed',
  'tokenizer_estimated',
  'cost_estimated',
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function readNumber(value: unknown, fallback = 0): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function readPositiveNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function readRuntimeKind(value: unknown): TokenUsageRuntimeKind {
  return value === 'anthropic' || value === 'codex' || value === 'gemini' || value === 'opencode'
    ? value
    : 'unknown';
}

function readBillingMode(value: unknown): TokenUsageBillingMode {
  return value === 'api' || value === 'subscription' || value === 'free' ? value : 'unknown';
}

function readRunStatus(value: unknown): TokenUsageRunStatus {
  return value === 'running' || value === 'completed' || value === 'failed' ? value : 'unknown';
}

export function normalizeTokenBreakdown(value: unknown): TokenUsageTokenBreakdownDto {
  const record = isRecord(value) ? value : {};
  return {
    inputTokens: readNumber(record.inputTokens),
    outputTokens: readNumber(record.outputTokens),
    cacheCreationTokens: readNumber(record.cacheCreationTokens),
    cacheReadTokens: readNumber(record.cacheReadTokens),
    reasoningTokens: readNumber(record.reasoningTokens),
    audioTokens: readNumber(record.audioTokens),
    imageTokens: readNumber(record.imageTokens),
    totalTokens: readNumber(record.totalTokens),
  };
}

export function normalizeTokenUsageSummary(value: unknown): TokenUsageSummaryDto {
  const record = isRecord(value) ? value : {};
  return {
    requestCount: readNumber(record.requestCount),
    runCount: readNumber(record.runCount),
    runningRunCount: readNumber(record.runningRunCount),
    totalTokens: readNumber(record.totalTokens),
    inputTokens: readNumber(record.inputTokens),
    outputTokens: readNumber(record.outputTokens),
    cacheCreationTokens: readNumber(record.cacheCreationTokens),
    cacheReadTokens: readNumber(record.cacheReadTokens),
    reasoningTokens: readNumber(record.reasoningTokens),
    estimatedCostUsd: readNumber(record.estimatedCostUsd),
    billableCostUsd: readNumber(record.billableCostUsd),
    apiEquivalentCostUsd: readNumber(record.apiEquivalentCostUsd ?? record.estimatedCostUsd),
    costKnownEventCount: readNumber(record.costKnownEventCount),
    billableEventCount: readNumber(record.billableEventCount),
    apiBillingRequestCount: readNumber(record.apiBillingRequestCount),
    subscriptionRequestCount: readNumber(record.subscriptionRequestCount),
    freeRequestCount: readNumber(record.freeRequestCount),
    unknownBillingRequestCount: readNumber(record.unknownBillingRequestCount),
    apiBillingTokens: readNumber(record.apiBillingTokens),
    subscriptionTokens: readNumber(record.subscriptionTokens),
    freeTokens: readNumber(record.freeTokens),
    unknownBillingTokens: readNumber(record.unknownBillingTokens),
    exactEventCount: readNumber(record.exactEventCount),
    estimatedEventCount: readNumber(record.estimatedEventCount),
    kiroCredits: readNumber(record.kiroCredits),
    kiroCreditEventCount: readNumber(record.kiroCreditEventCount),
    lastKiroCredits:
      typeof record.lastKiroCredits === 'number' && Number.isFinite(record.lastKiroCredits)
        ? Math.max(0, record.lastKiroCredits)
        : undefined,
    lastKiroCreditsAt: readString(record.lastKiroCreditsAt),
    kiroCreditsUnit: readString(record.kiroCreditsUnit),
  };
}

function normalizeBreakdownItem(value: unknown): TokenUsageBreakdownItemDto | null {
  const record = isRecord(value) ? value : null;
  const id = readString(record?.id);
  const label = readString(record?.label);
  if (!id || !label) return null;
  return {
    id,
    label,
    teamName: readString(record?.teamName),
    agentName: readString(record?.agentName),
    summary: normalizeTokenUsageSummary(record?.summary),
    lastActivityAt: readString(record?.lastActivityAt),
  };
}

function normalizeTaskBreakdownItem(value: unknown): TokenUsageTaskBreakdownItemDto | null {
  const item = normalizeBreakdownItem(value);
  const record = isRecord(value) ? value : null;
  const taskId = readString(record?.taskId);
  const subject = readString(record?.subject);
  if (!item || !taskId || !subject) return null;
  return {
    ...item,
    taskId,
    displayId: readString(record?.displayId),
    subject,
    owner: readString(record?.owner),
    status: readString(record?.status),
  };
}

function normalizeRunSource(value: unknown): TokenUsageRunSourceDto | null {
  const record = isRecord(value) ? value : null;
  const id = readString(record?.id);
  const appRunId = readString(record?.appRunId);
  const discoveredAt = readString(record?.discoveredAt);
  if (!id || !appRunId || !discoveredAt) return null;
  return {
    id,
    appRunId,
    sourceType:
      record?.sourceType === 'runtime_trace' ||
      record?.sourceType === 'gateway' ||
      record?.sourceType === 'sdk' ||
      record?.sourceType === 'manual_import'
        ? record.sourceType
        : 'cli_log',
    nativeSessionId: readString(record?.nativeSessionId),
    nativeLogPath: readString(record?.nativeLogPath),
    nativeProjectKey: readString(record?.nativeProjectKey),
    parserName: readString(record?.parserName),
    parserVersion: readString(record?.parserVersion),
    discoveredAt,
  };
}

function normalizeRecentRun(value: unknown): TokenUsageRecentRunDto | null {
  const record = isRecord(value) ? value : null;
  const appRunId = readString(record?.appRunId);
  const startedAt = readString(record?.startedAt);
  if (!appRunId || !startedAt) return null;
  const rawSources = Array.isArray(record?.sources) ? record.sources : [];
  return {
    appRunId,
    teamName: readString(record?.teamName),
    agentName: readString(record?.agentName),
    runtimeKind: readRuntimeKind(record?.runtimeKind),
    providerId: readString(record?.providerId),
    providerBackendId: readString(record?.providerBackendId),
    billingMode: readBillingMode(record?.billingMode),
    model: readString(record?.model),
    status: readRunStatus(record?.status),
    startedAt,
    endedAt: readString(record?.endedAt),
    summary: normalizeTokenUsageSummary(record?.summary),
    sources: rawSources
      .map((source) => normalizeRunSource(source))
      .filter((source): source is TokenUsageRunSourceDto => source !== null),
  };
}

function normalizeSessionRun(value: unknown): TokenUsageSessionRunDto | null {
  const record = isRecord(value) ? value : null;
  const id = readString(record?.id);
  const label = readString(record?.label);
  const appRunId = readString(record?.appRunId);
  const startedAt = readString(record?.startedAt);
  if (!id || !label || !appRunId || !startedAt) return null;
  const rawSources = Array.isArray(record?.sources) ? record.sources : [];
  const durationMs = readNumber(record?.durationMs, Number.NaN);

  return {
    id,
    label,
    appRunId,
    teamName: readString(record?.teamName),
    agentId: readString(record?.agentId),
    agentName: readString(record?.agentName),
    runtimeKind: readRuntimeKind(record?.runtimeKind),
    providerId: readString(record?.providerId),
    providerBackendId: readString(record?.providerBackendId),
    billingMode: readBillingMode(record?.billingMode),
    model: readString(record?.model),
    nativeSessionId: readString(record?.nativeSessionId),
    nativeLogPath: readString(record?.nativeLogPath),
    startedAt,
    endedAt: readString(record?.endedAt),
    durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
    status: readRunStatus(record?.status),
    summary: normalizeTokenUsageSummary(record?.summary),
    sources: rawSources
      .map((source) => normalizeRunSource(source))
      .filter((source): source is TokenUsageRunSourceDto => source !== null),
  };
}

function normalizeCommandRun(value: unknown): TokenUsageCommandRunDto | null {
  const record = isRecord(value) ? value : null;
  const id = readString(record?.id);
  const label = readString(record?.label);
  const startedAt = readString(record?.startedAt);
  if (!id || !label || !startedAt) return null;
  const durationMs = readNumber(record?.durationMs, Number.NaN);
  return {
    id,
    label,
    commandId: readString(record?.commandId),
    commandInvocationId: readString(record?.commandInvocationId),
    teamName: readString(record?.teamName),
    agentNames: readStringArray(record?.agentNames),
    runtimeKinds: readStringArray(record?.runtimeKinds).map(readRuntimeKind),
    models: readStringArray(record?.models),
    runCount: readNumber(record?.runCount),
    startedAt,
    endedAt: readString(record?.endedAt),
    durationMs: Number.isFinite(durationMs) ? durationMs : undefined,
    status: readRunStatus(record?.status),
    summary: normalizeTokenUsageSummary(record?.summary),
  };
}

function normalizeTimeSeriesPoint(value: unknown): TokenUsageTimeSeriesPointDto | null {
  const record = isRecord(value) ? value : null;
  const id = readString(record?.id);
  const label = readString(record?.label);
  const startedAt = readString(record?.startedAt);
  const endedAt = readString(record?.endedAt);
  if (!id || !label || !startedAt || !endedAt) return null;
  return {
    id,
    label,
    startedAt,
    endedAt,
    summary: normalizeTokenUsageSummary(record?.summary),
  };
}

export function normalizeTokenUsageSnapshot(value: unknown): TokenUsageAnalyticsSnapshotDto | null {
  const record = isRecord(value) ? value : null;
  const updatedAt = readString(record?.updatedAt);
  if (!updatedAt) return null;

  const normalizeItems = (items: unknown): TokenUsageBreakdownItemDto[] =>
    (Array.isArray(items) ? items : [])
      .map((item) => normalizeBreakdownItem(item))
      .filter((item): item is TokenUsageBreakdownItemDto => item !== null);
  const normalizeTaskItems = (items: unknown): TokenUsageTaskBreakdownItemDto[] =>
    (Array.isArray(items) ? items : [])
      .map((item) => normalizeTaskBreakdownItem(item))
      .filter((item): item is TokenUsageTaskBreakdownItemDto => item !== null);
  const normalizeRuns = (items: unknown): TokenUsageRecentRunDto[] =>
    (Array.isArray(items) ? items : [])
      .map((item) => normalizeRecentRun(item))
      .filter((item): item is TokenUsageRecentRunDto => item !== null);
  const normalizeSessionRuns = (items: unknown): TokenUsageSessionRunDto[] =>
    (Array.isArray(items) ? items : [])
      .map((item) => normalizeSessionRun(item))
      .filter((item): item is TokenUsageSessionRunDto => item !== null);
  const normalizeCommandRuns = (items: unknown): TokenUsageCommandRunDto[] =>
    (Array.isArray(items) ? items : [])
      .map((item) => normalizeCommandRun(item))
      .filter((item): item is TokenUsageCommandRunDto => item !== null);
  const normalizeTrend = (items: unknown): TokenUsageTimeSeriesPointDto[] =>
    (Array.isArray(items) ? items : [])
      .map((item) => normalizeTimeSeriesPoint(item))
      .filter((item): item is TokenUsageTimeSeriesPointDto => item !== null);

  const rawSourceCounts = isRecord(record?.sourceCounts) ? record.sourceCounts : {};
  const sourceCounts = SOURCE_KIND_KEYS.reduce<Record<(typeof SOURCE_KIND_KEYS)[number], number>>(
    (acc, key) => {
      acc[key] = readNumber(rawSourceCounts[key]);
      return acc;
    },
    {
      sdk_exact: 0,
      gateway_exact: 0,
      log_parsed: 0,
      tokenizer_estimated: 0,
      cost_estimated: 0,
    }
  );

  return {
    updatedAt,
    stale: record?.stale === true,
    degraded: record?.degraded === true,
    summary: normalizeTokenUsageSummary(record?.summary),
    byTeam: normalizeItems(record?.byTeam),
    byAgent: normalizeItems(record?.byAgent),
    byCommand: normalizeItems(record?.byCommand),
    bySession: normalizeItems(record?.bySession),
    byProject: normalizeItems(record?.byProject),
    byRuntime: normalizeItems(record?.byRuntime),
    byModel: normalizeItems(record?.byModel),
    byTask: normalizeTaskItems(record?.byTask),
    commandRuns: normalizeCommandRuns(record?.commandRuns),
    sessionRuns: normalizeSessionRuns(record?.sessionRuns),
    tokenTrend: normalizeTrend(record?.tokenTrend),
    usageHeatmap: normalizeTrend(record?.usageHeatmap),
    recentRuns: normalizeRuns(record?.recentRuns),
    expensiveRuns: normalizeRuns(record?.expensiveRuns),
    unmappedEventCount: readNumber(record?.unmappedEventCount),
    sourceCounts,
  };
}

export function normalizeTokenUsageBudgetLimit(
  value: unknown
): TokenUsageBudgetLimitDto | undefined {
  const record = isRecord(value) ? value : {};
  const limit: TokenUsageBudgetLimitDto = {};
  const monthlyTokenLimit = readPositiveNumber(record.monthlyTokenLimit);
  const monthlyApiEquivalentCostLimitUsd = readPositiveNumber(
    record.monthlyApiEquivalentCostLimitUsd
  );
  if (monthlyTokenLimit !== undefined) limit.monthlyTokenLimit = monthlyTokenLimit;
  if (monthlyApiEquivalentCostLimitUsd !== undefined) {
    limit.monthlyApiEquivalentCostLimitUsd = monthlyApiEquivalentCostLimitUsd;
  }
  return Object.keys(limit).length > 0 ? limit : undefined;
}

export function normalizeTokenUsageBudgetSettings(
  value: unknown,
  updatedAt?: string
): TokenUsageBudgetSettingsDto {
  const record = isRecord(value) ? value : {};
  const global = normalizeTokenUsageBudgetLimit(record.global);
  const teams = normalizeBudgetLimitRecord(record.teams);
  const projects = normalizeBudgetLimitRecord(record.projects);
  return {
    ...(global ? { global } : {}),
    ...(Object.keys(teams).length > 0 ? { teams } : {}),
    ...(Object.keys(projects).length > 0 ? { projects } : {}),
    updatedAt: readString(record.updatedAt) ?? updatedAt,
  };
}

function normalizeBudgetLimitRecord(value: unknown): Record<string, TokenUsageBudgetLimitDto> {
  const record = isRecord(value) ? value : {};
  const result: Record<string, TokenUsageBudgetLimitDto> = {};
  for (const [key, limit] of Object.entries(record)) {
    const id = key.trim();
    const normalized = normalizeTokenUsageBudgetLimit(limit);
    if (id && normalized) result[id] = normalized;
  }
  return result;
}

export const EMPTY_TOKEN_USAGE_TOKENS: TokenUsageTokenBreakdownDto = {
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  reasoningTokens: 0,
  audioTokens: 0,
  imageTokens: 0,
  totalTokens: 0,
};
