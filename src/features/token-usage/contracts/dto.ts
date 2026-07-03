export type TokenUsageRuntimeKind = 'anthropic' | 'codex' | 'gemini' | 'opencode' | 'unknown';

export type TokenUsageSourceKind =
  | 'sdk_exact'
  | 'gateway_exact'
  | 'log_parsed'
  | 'tokenizer_estimated'
  | 'cost_estimated';

export type TokenUsageCostSource = 'provider' | 'gateway' | 'pricing_table' | 'unknown';
export type TokenUsageBillingMode = 'api' | 'subscription' | 'free' | 'unknown';

export type TokenUsageRunStatus = 'running' | 'completed' | 'failed' | 'unknown';

export interface TokenUsageSnapshotRequest {
  teamName?: string;
  teamNames?: string[];
  agentId?: string;
  commandId?: string;
  commandInvocationId?: string;
  nativeSessionId?: string;
  from?: string;
  to?: string;
}

export interface TokenUsageBudgetLimitDto {
  monthlyTokenLimit?: number;
  monthlyApiEquivalentCostLimitUsd?: number;
}

export interface TokenUsageBudgetSettingsDto {
  global?: TokenUsageBudgetLimitDto;
  teams?: Record<string, TokenUsageBudgetLimitDto>;
  projects?: Record<string, TokenUsageBudgetLimitDto>;
  updatedAt?: string;
}

export interface TokenUsageTokenBreakdownDto {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  audioTokens: number;
  imageTokens: number;
  totalTokens: number;
}

export interface TokenUsageCostBreakdownDto {
  /**
   * Backward-compatible API-equivalent cost field.
   * This is not necessarily a provider invoice amount.
   */
  estimatedUsd: number;
  /** Actual billable provider/gateway cost when the source reports it. */
  billableUsd: number;
  /** Shadow API pricing estimate for subscription/free/unknown usage. */
  apiEquivalentUsd: number;
  source: TokenUsageCostSource;
  billingMode: TokenUsageBillingMode;
}

export interface TokenUsageRunSourceDto {
  id: string;
  appRunId: string;
  sourceType: 'cli_log' | 'runtime_trace' | 'gateway' | 'sdk' | 'manual_import';
  nativeSessionId?: string;
  nativeLogPath?: string;
  nativeProjectKey?: string;
  parserName?: string;
  parserVersion?: string;
  discoveredAt: string;
}

export interface TokenUsageRunDto {
  appRunId: string;
  parentAppRunId?: string;
  teamName?: string;
  agentId?: string;
  agentName?: string;
  commandId?: string;
  commandInvocationId?: string;
  runtimeKind: TokenUsageRuntimeKind;
  providerId?: string;
  providerBackendId?: string;
  billingMode?: TokenUsageBillingMode;
  model?: string;
  workspacePathHash?: string;
  workspaceLabel?: string;
  commandHash?: string;
  startedAt: string;
  endedAt?: string;
  status: TokenUsageRunStatus;
  source: 'app_launcher' | 'team_launch_state' | 'manual_import';
  sources: TokenUsageRunSourceDto[];
}

export interface TokenUsageEventDto {
  id: string;
  appRunId: string;
  requestId?: string;
  spanId?: string;
  stepIndex?: number;
  teamName?: string;
  agentId?: string;
  agentName?: string;
  commandId?: string;
  commandInvocationId?: string;
  runtimeKind: TokenUsageRuntimeKind;
  providerId?: string;
  providerBackendId?: string;
  billingMode?: TokenUsageBillingMode;
  model?: string;
  nativeSessionId?: string;
  nativeLogPath?: string;
  tokens: TokenUsageTokenBreakdownDto;
  cost: TokenUsageCostBreakdownDto;
  usageSourceKind: TokenUsageSourceKind;
  rawUsageJson?: unknown;
  occurredAt: string;
  createdAt: string;
}

export interface TokenUsageSummaryDto {
  requestCount: number;
  runCount: number;
  runningRunCount: number;
  totalTokens: number;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  reasoningTokens: number;
  estimatedCostUsd: number;
  billableCostUsd: number;
  apiEquivalentCostUsd: number;
  costKnownEventCount: number;
  billableEventCount: number;
  apiBillingRequestCount: number;
  subscriptionRequestCount: number;
  freeRequestCount: number;
  unknownBillingRequestCount: number;
  apiBillingTokens: number;
  subscriptionTokens: number;
  freeTokens: number;
  unknownBillingTokens: number;
  exactEventCount: number;
  estimatedEventCount: number;
}

export interface TokenUsageBreakdownItemDto {
  id: string;
  label: string;
  teamName?: string;
  agentName?: string;
  summary: TokenUsageSummaryDto;
  lastActivityAt?: string;
}

export interface TokenUsageRecentRunDto {
  appRunId: string;
  teamName?: string;
  agentName?: string;
  runtimeKind: TokenUsageRuntimeKind;
  providerId?: string;
  providerBackendId?: string;
  billingMode?: TokenUsageBillingMode;
  model?: string;
  status: TokenUsageRunStatus;
  startedAt: string;
  endedAt?: string;
  summary: TokenUsageSummaryDto;
  sources: TokenUsageRunSourceDto[];
}

export interface TokenUsageSessionRunDto {
  id: string;
  label: string;
  appRunId: string;
  teamName?: string;
  agentId?: string;
  agentName?: string;
  runtimeKind: TokenUsageRuntimeKind;
  providerId?: string;
  providerBackendId?: string;
  billingMode?: TokenUsageBillingMode;
  model?: string;
  nativeSessionId?: string;
  nativeLogPath?: string;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: TokenUsageRunStatus;
  summary: TokenUsageSummaryDto;
  sources: TokenUsageRunSourceDto[];
}

export interface TokenUsageCommandRunDto {
  id: string;
  label: string;
  commandId?: string;
  commandInvocationId?: string;
  teamName?: string;
  agentNames: string[];
  runtimeKinds: TokenUsageRuntimeKind[];
  models: string[];
  runCount: number;
  startedAt: string;
  endedAt?: string;
  durationMs?: number;
  status: TokenUsageRunStatus;
  summary: TokenUsageSummaryDto;
}

export interface TokenUsageTimeSeriesPointDto {
  id: string;
  label: string;
  startedAt: string;
  endedAt: string;
  summary: TokenUsageSummaryDto;
}

export interface TokenUsageAnalyticsSnapshotDto {
  updatedAt: string;
  stale: boolean;
  degraded: boolean;
  summary: TokenUsageSummaryDto;
  byTeam: TokenUsageBreakdownItemDto[];
  byAgent: TokenUsageBreakdownItemDto[];
  byCommand: TokenUsageBreakdownItemDto[];
  bySession: TokenUsageBreakdownItemDto[];
  byProject: TokenUsageBreakdownItemDto[];
  byRuntime: TokenUsageBreakdownItemDto[];
  byModel: TokenUsageBreakdownItemDto[];
  commandRuns: TokenUsageCommandRunDto[];
  sessionRuns: TokenUsageSessionRunDto[];
  tokenTrend: TokenUsageTimeSeriesPointDto[];
  usageHeatmap: TokenUsageTimeSeriesPointDto[];
  recentRuns: TokenUsageRecentRunDto[];
  expensiveRuns: TokenUsageRecentRunDto[];
  unmappedEventCount: number;
  sourceCounts: Record<TokenUsageSourceKind, number>;
}
