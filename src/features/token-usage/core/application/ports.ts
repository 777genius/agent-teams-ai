import type {
  TokenUsageAnalyticsSnapshotDto,
  TokenUsageBudgetSettingsDto,
  TokenUsageBudgetSettingsUpdateRequestDto,
  TokenUsageBudgetStatusDto,
  TokenUsageEventDto,
  TokenUsageRunDto,
  TokenUsageSnapshotRequest,
  TokenUsageTaskAttributionDto,
} from '../../contracts';

export interface TokenUsageLedgerRepositoryPort {
  readSnapshot(): Promise<{ runs: TokenUsageRunDto[]; events: TokenUsageEventDto[] }>;
  listRuns(): Promise<TokenUsageRunDto[]>;
  listEvents(): Promise<TokenUsageEventDto[]>;
  upsertRuns(runs: readonly TokenUsageRunDto[]): Promise<void>;
  replaceRunsForSource(
    source: TokenUsageRunDto['source'],
    runs: readonly TokenUsageRunDto[]
  ): Promise<void>;
  upsertEvents(events: readonly TokenUsageEventDto[]): Promise<void>;
}

export interface TokenUsageRunSourceDiscoveryPort {
  discoverAppRuns(): Promise<TokenUsageRunDto[]>;
}

export interface TokenUsageImporterPort {
  importUsage(runs: readonly TokenUsageRunDto[]): Promise<TokenUsageEventDto[]>;
}

export interface TokenUsageRealtimePublisherPort {
  publishBudgetStatus?(status: TokenUsageBudgetStatusDto): void;
  publishSnapshot(snapshot: TokenUsageAnalyticsSnapshotDto): void;
}

export interface TokenUsageTaskAttributionSourcePort {
  listTaskAttributions(): Promise<TokenUsageTaskAttributionDto[]>;
}

export interface TokenUsageClockPort {
  now(): Date;
}

export interface TokenUsageLoggerPort {
  info?(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, error?: unknown): void;
}

export type TokenUsageBudgetNotificationReason =
  | 'snapshot'
  | 'startup'
  | 'settings'
  | 'month'
  | 'tick';
export type TokenUsageBudgetNotificationScope = 'global' | 'team' | 'project';
export type TokenUsageBudgetNotificationMetric = 'tokens' | 'apiEquivalentCostUsd';

export interface TokenUsageBudgetNotificationSettings {
  enabled: boolean;
  notifyAtWarning: boolean;
  notifyAtCritical: boolean;
  nativeToasts: boolean;
}

export interface TokenUsageBudgetNotificationRecord {
  dedupeKey: string;
  sentAt: string;
  periodKey: string;
  scope: TokenUsageBudgetNotificationScope;
  id: string;
  metric: TokenUsageBudgetNotificationMetric;
  threshold: number;
  value: number;
  limit: number;
  percent: number;
}

export interface TokenUsageBudgetNotificationEvent {
  dedupeKey: string;
  sentAt: string;
  periodKey: string;
  scope: TokenUsageBudgetNotificationScope;
  id: string;
  reasons: TokenUsageBudgetNotificationRecord[];
  label: string;
  severity: 'warning' | 'critical';
  suppressToast: boolean;
}

export interface TokenUsageBudgetSettingsRepositoryPort {
  getSettings(): Promise<TokenUsageBudgetSettingsDto>;
  updateSettings(
    settings: TokenUsageBudgetSettingsUpdateRequestDto
  ): Promise<TokenUsageBudgetSettingsDto>;
}

export interface TokenUsageBudgetNotificationStateRepositoryPort {
  hasSent(dedupeKey: string): Promise<boolean>;
  markCovered(records: readonly TokenUsageBudgetNotificationRecord[]): Promise<void>;
  pruneBeforePeriod(periodKey: string): Promise<void>;
}

export interface TokenUsageBudgetNotificationSinkPort {
  notifyBudgetThreshold(event: TokenUsageBudgetNotificationEvent): Promise<void>;
}

export interface TokenUsageBudgetNotificationSettingsPort {
  getSettings(): TokenUsageBudgetNotificationSettings;
}

export interface TokenUsageBudgetNotificationEvaluatorPort {
  retryPending?(): Promise<void>;
  evaluate(
    snapshot: TokenUsageBudgetStatusDto,
    reason: TokenUsageBudgetNotificationReason
  ): Promise<void>;
}

export interface TokenUsageAnalyticsServicePort {
  getSnapshot(request?: TokenUsageSnapshotRequest): Promise<TokenUsageAnalyticsSnapshotDto>;
  refreshSnapshot(request?: TokenUsageSnapshotRequest): Promise<TokenUsageAnalyticsSnapshotDto>;
  recordRuns(runs: readonly TokenUsageRunDto[]): Promise<void>;
  ingestEvents(events: readonly TokenUsageEventDto[]): Promise<void>;
  getBudgetSettings(): Promise<TokenUsageBudgetSettingsDto>;
  getBudgetStatus(): Promise<TokenUsageBudgetStatusDto>;
  tick(): Promise<void>;
  updateBudgetSettings(
    settings: TokenUsageBudgetSettingsUpdateRequestDto
  ): Promise<TokenUsageBudgetSettingsDto>;
}
