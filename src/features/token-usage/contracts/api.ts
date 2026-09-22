import type {
  TokenUsageAnalyticsSnapshotDto,
  TokenUsageBudgetSettingsDto,
  TokenUsageSnapshotRequest,
} from './dto';

export interface TokenUsageElectronApi {
  tokenUsage: {
    getSnapshot(request?: TokenUsageSnapshotRequest): Promise<TokenUsageAnalyticsSnapshotDto>;
    refreshSnapshot(request?: TokenUsageSnapshotRequest): Promise<TokenUsageAnalyticsSnapshotDto>;
    getBudgetSettings(): Promise<TokenUsageBudgetSettingsDto>;
    updateBudgetSettings(
      settings: TokenUsageBudgetSettingsDto
    ): Promise<TokenUsageBudgetSettingsDto>;
    onSnapshotChanged(callback: (snapshot: TokenUsageAnalyticsSnapshotDto) => void): () => void;
  };
}
