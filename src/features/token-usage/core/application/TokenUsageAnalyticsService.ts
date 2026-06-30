import { buildTokenUsageSnapshot } from '../domain';

import type {
  TokenUsageAnalyticsSnapshotDto,
  TokenUsageBudgetSettingsDto,
  TokenUsageEventDto,
  TokenUsageRunDto,
  TokenUsageSnapshotRequest,
} from '../../contracts';
import type {
  TokenUsageAnalyticsServicePort,
  TokenUsageBudgetNotificationEvaluatorPort,
  TokenUsageBudgetSettingsRepositoryPort,
  TokenUsageClockPort,
  TokenUsageImporterPort,
  TokenUsageLedgerRepositoryPort,
  TokenUsageLoggerPort,
  TokenUsageRealtimePublisherPort,
  TokenUsageRunSourceDiscoveryPort,
} from './ports';

export interface TokenUsageAnalyticsServiceDeps {
  ledger: TokenUsageLedgerRepositoryPort;
  discovery: TokenUsageRunSourceDiscoveryPort;
  importers: readonly TokenUsageImporterPort[];
  clock: TokenUsageClockPort;
  budgets?: TokenUsageBudgetSettingsRepositoryPort;
  budgetNotifications?: TokenUsageBudgetNotificationEvaluatorPort;
  publisher?: TokenUsageRealtimePublisherPort;
  logger?: TokenUsageLoggerPort;
}

export class TokenUsageAnalyticsService implements TokenUsageAnalyticsServicePort {
  constructor(private readonly deps: TokenUsageAnalyticsServiceDeps) {}

  async getSnapshot(request?: TokenUsageSnapshotRequest): Promise<TokenUsageAnalyticsSnapshotDto> {
    const [runs, events] = await Promise.all([
      this.deps.ledger.listRuns(),
      this.deps.ledger.listEvents(),
    ]);
    return buildTokenUsageSnapshot({
      runs,
      events,
      request,
      nowIso: this.deps.clock.now().toISOString(),
    });
  }

  async refreshSnapshot(
    request?: TokenUsageSnapshotRequest
  ): Promise<TokenUsageAnalyticsSnapshotDto> {
    let degraded = false;
    try {
      const discoveredRuns = await this.deps.discovery.discoverAppRuns();
      await this.deps.ledger.replaceRunsForSource('team_launch_state', discoveredRuns);
    } catch (error) {
      degraded = true;
      this.deps.logger?.warn('Failed to discover token usage app runs', error);
    }

    const runs = await this.deps.ledger.listRuns();
    for (const importer of this.deps.importers) {
      try {
        const events = await importer.importUsage(runs);
        await this.deps.ledger.upsertEvents(events);
      } catch (error) {
        degraded = true;
        this.deps.logger?.warn('Failed to import token usage events', error);
      }
    }

    const [nextRuns, nextEvents] = await Promise.all([
      this.deps.ledger.listRuns(),
      this.deps.ledger.listEvents(),
    ]);
    const canonicalSnapshot = buildTokenUsageSnapshot({
      runs: nextRuns,
      events: nextEvents,
      nowIso: this.deps.clock.now().toISOString(),
      degraded,
    });
    const snapshot = request
      ? buildTokenUsageSnapshot({
          runs: nextRuns,
          events: nextEvents,
          request,
          nowIso: canonicalSnapshot.updatedAt,
          degraded,
        })
      : canonicalSnapshot;
    this.deps.publisher?.publishSnapshot(canonicalSnapshot);
    this.evaluateBudgetNotifications(canonicalSnapshot, 'snapshot');
    return snapshot;
  }

  async recordRuns(runs: readonly TokenUsageRunDto[]): Promise<void> {
    await this.deps.ledger.upsertRuns(runs);
    await this.publishCurrentSnapshot();
  }

  async ingestEvents(events: readonly TokenUsageEventDto[]): Promise<void> {
    await this.deps.ledger.upsertEvents(events);
    await this.publishCurrentSnapshot();
  }

  async getBudgetSettings(): Promise<TokenUsageBudgetSettingsDto> {
    return this.deps.budgets?.getSettings() ?? {};
  }

  async updateBudgetSettings(
    settings: TokenUsageBudgetSettingsDto
  ): Promise<TokenUsageBudgetSettingsDto> {
    const nextSettings = (await this.deps.budgets?.updateSettings(settings)) ?? {};
    const snapshot = await this.getSnapshot();
    this.evaluateBudgetNotifications(snapshot, 'settings');
    return nextSettings;
  }

  private async publishCurrentSnapshot(): Promise<void> {
    if (!this.deps.publisher) return;
    const [runs, events] = await Promise.all([
      this.deps.ledger.listRuns(),
      this.deps.ledger.listEvents(),
    ]);
    const snapshot = buildTokenUsageSnapshot({
      runs,
      events,
      nowIso: this.deps.clock.now().toISOString(),
    });
    this.deps.publisher.publishSnapshot(snapshot);
    this.evaluateBudgetNotifications(snapshot, 'snapshot');
  }

  private evaluateBudgetNotifications(
    snapshot: TokenUsageAnalyticsSnapshotDto,
    reason: 'snapshot' | 'startup' | 'settings'
  ): void {
    if (!this.deps.budgetNotifications) return;
    void this.deps.budgetNotifications.evaluate(snapshot, reason).catch((error: unknown) => {
      this.deps.logger?.warn('Failed to evaluate token usage budget notifications', error);
    });
  }
}
