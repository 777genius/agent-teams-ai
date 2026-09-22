import { buildTokenUsageSnapshot } from '../domain';

import type {
  TokenUsageAnalyticsSnapshotDto,
  TokenUsageBudgetSettingsDto,
  TokenUsageEventDto,
  TokenUsageRunDto,
  TokenUsageSnapshotRequest,
  TokenUsageTaskAttributionDto,
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
  TokenUsageTaskAttributionSourcePort,
} from './ports';

export interface TokenUsageAnalyticsServiceDeps {
  ledger: TokenUsageLedgerRepositoryPort;
  discovery: TokenUsageRunSourceDiscoveryPort;
  importers: readonly TokenUsageImporterPort[];
  clock: TokenUsageClockPort;
  budgets?: TokenUsageBudgetSettingsRepositoryPort;
  budgetNotifications?: TokenUsageBudgetNotificationEvaluatorPort;
  publisher?: TokenUsageRealtimePublisherPort;
  taskAttributionSource?: TokenUsageTaskAttributionSourcePort;
  logger?: TokenUsageLoggerPort;
}

export class TokenUsageAnalyticsService implements TokenUsageAnalyticsServicePort {
  constructor(private readonly deps: TokenUsageAnalyticsServiceDeps) {}

  async getSnapshot(request?: TokenUsageSnapshotRequest): Promise<TokenUsageAnalyticsSnapshotDto> {
    const [runs, events, tasks] = await Promise.all([
      this.deps.ledger.listRuns(),
      this.deps.ledger.listEvents(),
      this.listTaskAttributions(false),
    ]);
    return buildTokenUsageSnapshot({
      runs,
      events,
      tasks,
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

    const [nextRuns, nextEvents, taskAttributionResult] = await Promise.all([
      this.deps.ledger.listRuns(),
      this.deps.ledger.listEvents(),
      this.listTaskAttributions(true),
    ]);
    if (taskAttributionResult.degraded) {
      degraded = true;
    }
    const canonicalSnapshot = buildTokenUsageSnapshot({
      runs: nextRuns,
      events: nextEvents,
      tasks: taskAttributionResult.tasks,
      nowIso: this.deps.clock.now().toISOString(),
      degraded,
    });
    const snapshot = request
      ? buildTokenUsageSnapshot({
          runs: nextRuns,
          events: nextEvents,
          tasks: taskAttributionResult.tasks,
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
    const [runs, events, tasks] = await Promise.all([
      this.deps.ledger.listRuns(),
      this.deps.ledger.listEvents(),
      this.listTaskAttributions(false),
    ]);
    const snapshot = buildTokenUsageSnapshot({
      runs,
      events,
      tasks,
      nowIso: this.deps.clock.now().toISOString(),
    });
    this.deps.publisher.publishSnapshot(snapshot);
    this.evaluateBudgetNotifications(snapshot, 'snapshot');
  }

  private async listTaskAttributions(
    withDegradedFlag: true
  ): Promise<{ tasks: TokenUsageTaskAttributionDto[]; degraded: boolean }>;
  private async listTaskAttributions(
    withDegradedFlag: false
  ): Promise<TokenUsageTaskAttributionDto[]>;
  private async listTaskAttributions(withDegradedFlag: boolean): Promise<
    | TokenUsageTaskAttributionDto[]
    | {
        tasks: TokenUsageTaskAttributionDto[];
        degraded: boolean;
      }
  > {
    if (!this.deps.taskAttributionSource) {
      return withDegradedFlag ? { tasks: [], degraded: false } : [];
    }
    try {
      const tasks = await this.deps.taskAttributionSource.listTaskAttributions();
      return withDegradedFlag ? { tasks, degraded: false } : tasks;
    } catch (error) {
      this.deps.logger?.warn('Failed to list token usage task attribution refs', error);
      return withDegradedFlag ? { tasks: [], degraded: true } : [];
    }
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
