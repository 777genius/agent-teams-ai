import type {
  TokenUsageAnalyticsSnapshotDto,
  TokenUsageBudgetSettingsDto,
  TokenUsageEventDto,
  TokenUsageRunDto,
  TokenUsageSnapshotRequest,
} from '../../contracts';

export interface TokenUsageLedgerRepositoryPort {
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
  publishSnapshot(snapshot: TokenUsageAnalyticsSnapshotDto): void;
}

export interface TokenUsageClockPort {
  now(): Date;
}

export interface TokenUsageLoggerPort {
  info?(message: string, meta?: unknown): void;
  warn(message: string, meta?: unknown): void;
  error(message: string, error?: unknown): void;
}

export type TokenUsageBudgetNotificationReason = 'snapshot' | 'startup' | 'settings';
export type TokenUsageBudgetNotificationScope = 'global' | 'team' | 'project';
export type TokenUsageBudgetNotificationMetric = 'tokens' | 'apiEquivalentCostUsd';
export type TokenUsageBudgetNotificationThreshold = 80 | 100;

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
  threshold: TokenUsageBudgetNotificationThreshold;
  value: number;
  limit: number;
  percent: number;
}

export interface TokenUsageBudgetNotificationEvent extends TokenUsageBudgetNotificationRecord {
  label: string;
  severity: 'warning' | 'critical';
  suppressToast: boolean;
}

export interface TokenUsageBudgetSettingsRepositoryPort {
  getSettings(): Promise<TokenUsageBudgetSettingsDto>;
  updateSettings(settings: TokenUsageBudgetSettingsDto): Promise<TokenUsageBudgetSettingsDto>;
}

export interface TokenUsageBudgetNotificationStateRepositoryPort {
  hasSent(dedupeKey: string): Promise<boolean>;
  markSent(record: TokenUsageBudgetNotificationRecord): Promise<void>;
  pruneBeforePeriod(periodKey: string): Promise<void>;
}

export interface TokenUsageBudgetNotificationSinkPort {
  notifyBudgetThreshold(event: TokenUsageBudgetNotificationEvent): Promise<void>;
}

export interface TokenUsageBudgetNotificationSettingsPort {
  getSettings(): TokenUsageBudgetNotificationSettings;
}

export interface TokenUsageBudgetNotificationEvaluatorPort {
  evaluate(
    snapshot: TokenUsageAnalyticsSnapshotDto,
    reason: TokenUsageBudgetNotificationReason
  ): Promise<void>;
}

export interface TokenUsageAnalyticsServicePort {
  getSnapshot(request?: TokenUsageSnapshotRequest): Promise<TokenUsageAnalyticsSnapshotDto>;
  refreshSnapshot(request?: TokenUsageSnapshotRequest): Promise<TokenUsageAnalyticsSnapshotDto>;
  recordRuns(runs: readonly TokenUsageRunDto[]): Promise<void>;
  ingestEvents(events: readonly TokenUsageEventDto[]): Promise<void>;
  getBudgetSettings(): Promise<TokenUsageBudgetSettingsDto>;
  updateBudgetSettings(settings: TokenUsageBudgetSettingsDto): Promise<TokenUsageBudgetSettingsDto>;
}
