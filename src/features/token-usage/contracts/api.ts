import type {
  TokenUsageAnalyticsSnapshotDto,
  TokenUsageBudgetSettingsDto,
  TokenUsageBudgetSettingsUpdateRequestDto,
  TokenUsageBudgetStatusDto,
  TokenUsageSnapshotRequest,
} from './dto';

export interface TokenUsageElectronApi {
  tokenUsage: {
    getSnapshot(request?: TokenUsageSnapshotRequest): Promise<TokenUsageAnalyticsSnapshotDto>;
    refreshSnapshot(request?: TokenUsageSnapshotRequest): Promise<TokenUsageAnalyticsSnapshotDto>;
    getBudgetStatus(): Promise<TokenUsageBudgetStatusDto>;
    onBudgetStatusChanged(callback: (status: TokenUsageBudgetStatusDto) => void): () => void;
    getBudgetSettings(): Promise<TokenUsageBudgetSettingsDto>;
    updateBudgetSettings(
      settings: TokenUsageBudgetSettingsUpdateRequestDto
    ): Promise<TokenUsageBudgetSettingsDto>;
    onSnapshotChanged(callback: (snapshot: TokenUsageAnalyticsSnapshotDto) => void): () => void;
  };
}
