import { budgetPeriod, buildBudgetStatus, buildTokenUsageSnapshot } from '../domain';

import { SerialQueue } from './SerialQueue';

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
import type {
  TokenUsageAnalyticsServicePort,
  TokenUsageBudgetNotificationEvaluatorPort,
  TokenUsageBudgetNotificationSettingsPort,
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
  readonly statusEpoch?: string;
  budgets?: TokenUsageBudgetSettingsRepositoryPort;
  budgetNotifications?: TokenUsageBudgetNotificationEvaluatorPort;
  budgetNotificationSettings?: TokenUsageBudgetNotificationSettingsPort;
  publisher?: TokenUsageRealtimePublisherPort;
  taskAttributionSource?: TokenUsageTaskAttributionSourcePort;
  logger?: TokenUsageLoggerPort;
}

interface Ledger {
  runs: TokenUsageRunDto[];
  events: TokenUsageEventDto[];
}
export class TokenUsageAnalyticsService implements TokenUsageAnalyticsServicePort {
  private readonly queue = new SerialQueue();
  private refreshInFlight: Promise<TokenUsageAnalyticsSnapshotDto> | null = null;
  private lastLedger: Ledger | null = null;
  private lastLedgerPeriod?: string;
  private usageUpdatedAt?: string;
  private refreshDegraded = false;
  private lastRefreshAttempt = -Infinity;
  private statusSequence = 0;
  private periodKey: string;
  constructor(private readonly deps: TokenUsageAnalyticsServiceDeps) {
    this.periodKey = budgetPeriod(deps.clock.now()).key;
  }

  getSnapshot(request?: TokenUsageSnapshotRequest): Promise<TokenUsageAnalyticsSnapshotDto> {
    return this.queue.run(async () => {
      const ledger = await this.deps.ledger.readSnapshot();
      return this.analytics(ledger, await this.listTaskAttributions(), request);
    });
  }

  async refreshSnapshot(
    request?: TokenUsageSnapshotRequest
  ): Promise<TokenUsageAnalyticsSnapshotDto> {
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.queue.run(() => this.refresh());
      const inFlight = this.refreshInFlight;
      void inFlight
        .finally(() => {
          if (this.refreshInFlight === inFlight) this.refreshInFlight = null;
        })
        .catch(() => undefined);
    }
    const canonical = await this.refreshInFlight;
    return request ? this.getSnapshot(request) : canonical;
  }

  private async refresh(): Promise<TokenUsageAnalyticsSnapshotDto> {
    this.lastRefreshAttempt = this.deps.clock.now().getTime();
    let degraded = false;
    try {
      try {
        const discovered = await this.deps.discovery.discoverAppRuns();
        await this.deps.ledger.replaceRunsForSource('team_launch_state', discovered);
      } catch (error) {
        degraded = true;
        this.deps.logger?.warn('Failed to discover token usage app runs', error);
      }
      const { runs } = await this.deps.ledger.readSnapshot();
      for (const importer of this.deps.importers) {
        try {
          await this.deps.ledger.upsertEvents(await importer.importUsage(runs));
        } catch (error) {
          degraded = true;
          this.deps.logger?.warn('Failed to import token usage events', error);
        }
      }
      const ledger = await this.deps.ledger.readSnapshot();
      let tasks: TokenUsageTaskAttributionDto[] = [];
      try {
        tasks = await this.listTaskAttributions(true);
      } catch (error) {
        degraded = true;
        this.deps.logger?.warn('Failed to list token usage tasks', error);
      }
      this.refreshDegraded = degraded;
      if (!degraded) this.usageUpdatedAt = this.deps.clock.now().toISOString();
      this.remember(ledger);
      const snapshot = this.analytics(ledger, tasks);
      this.deps.publisher?.publishSnapshot(snapshot);
      await this.publishBudgetSafely();
      return snapshot;
    } catch (error) {
      this.refreshDegraded = true;
      await this.publishBudgetSafely();
      throw error;
    }
  }

  recordRuns(runs: readonly TokenUsageRunDto[]): Promise<void> {
    return this.queue.run(async () => {
      await this.deps.ledger.upsertRuns(runs);
      await this.publishCurrentSnapshot();
    });
  }
  ingestEvents(events: readonly TokenUsageEventDto[]): Promise<void> {
    return this.queue.run(async () => {
      await this.deps.ledger.upsertEvents(events);
      await this.publishCurrentSnapshot();
    });
  }
  getBudgetSettings(): Promise<TokenUsageBudgetSettingsDto> {
    return this.queue.run(() => this.deps.budgets?.getSettings() ?? Promise.resolve({}));
  }
  getBudgetStatus(): Promise<TokenUsageBudgetStatusDto> {
    return this.queue.run(() => this.budgetStatus());
  }

  updateBudgetSettings(
    request: TokenUsageBudgetSettingsUpdateRequestDto
  ): Promise<TokenUsageBudgetSettingsDto> {
    return this.queue.run(async () => {
      if (!this.deps.budgets) throw new Error('Budget storage unavailable');
      const saved = await this.deps.budgets.updateSettings(request);
      // Delivery/read failure never changes an already durable successful Save.
      try {
        await this.publishBudget('settings');
      } catch (error) {
        this.deps.logger?.warn('Failed to update budget status after Save', error);
      }
      return saved;
    });
  }

  async tick(): Promise<void> {
    const refreshNeeded = await this.queue.run(async () => {
      const now = this.deps.clock.now();
      const currentMonth = budgetPeriod(now).key;
      const rollover = currentMonth !== this.periodKey;
      if (rollover) {
        this.periodKey = currentMonth;
        this.usageUpdatedAt = undefined;
      }
      // Publish the new month before discovery starts; old totals cannot be renamed.
      let status: TokenUsageBudgetStatusDto;
      try {
        status = await this.publishBudget(rollover ? 'month' : 'tick', rollover);
      } catch (error) {
        await this.deps.budgetNotifications?.retryPending?.();
        throw error;
      }
      const active =
        status.notificationPolicy.enabled &&
        status.targets.some(
          (target) =>
            target.notificationsEnabled && target.thresholds.length > 0 && target.metrics.length > 0
        );
      const refreshAge = now.getTime() - Date.parse(this.usageUpdatedAt ?? '');
      const recentlyRefreshed = refreshAge >= 0 && refreshAge < 120_000;
      const attemptAge = now.getTime() - this.lastRefreshAttempt;
      return (
        rollover || (active && !recentlyRefreshed && (attemptAge < 0 || attemptAge >= 120_000))
      );
    });
    if (refreshNeeded) await this.refreshSnapshot();
  }

  private remember(ledger: Ledger): void {
    this.lastLedger = ledger;
    this.lastLedgerPeriod = budgetPeriod(this.deps.clock.now()).key;
  }
  private async budgetStatus(rollover = false): Promise<TokenUsageBudgetStatusDto> {
    const now = this.deps.clock.now();
    const settings = (await this.deps.budgets?.getSettings()) ?? {};
    let ledger: Ledger | null = null;
    let readFailed = false;
    if (!rollover) {
      try {
        ledger = await this.deps.ledger.readSnapshot();
        this.remember(ledger);
      } catch (error) {
        readFailed = true;
        this.refreshDegraded = true;
        this.deps.logger?.warn('Failed to read token usage budget ledger', error);
        if (this.lastLedgerPeriod === budgetPeriod(now).key) ledger = this.lastLedger;
      }
    }
    const policy = this.deps.budgetNotificationSettings?.getSettings();
    const status = buildBudgetStatus({
      now,
      settings,
      ledger,
      usageUpdatedAt: this.usageUpdatedAt,
      degraded: this.refreshDegraded || readFailed,
      policy: { enabled: policy?.enabled ?? false, nativeToasts: policy?.nativeToasts ?? false },
    });
    if (readFailed || rollover) status.stale = true;
    if (this.deps.statusEpoch !== undefined) {
      status.statusOrder = { epoch: this.deps.statusEpoch, sequence: ++this.statusSequence };
    }
    return status;
  }

  private async publishBudgetSafely(): Promise<void> {
    try {
      await this.publishBudget('snapshot');
    } catch (error) {
      this.deps.logger?.warn('Failed to publish budget status', error);
    }
  }
  private async publishBudget(
    reason: 'snapshot' | 'settings' | 'month' | 'tick',
    rollover = false
  ): Promise<TokenUsageBudgetStatusDto> {
    const status = await this.budgetStatus(rollover);
    this.deps.publisher?.publishBudgetStatus?.(status);
    try {
      await this.deps.budgetNotifications?.evaluate(status, reason);
    } catch (error) {
      this.deps.logger?.warn('Failed to evaluate budget notifications', error);
    }
    return status;
  }
  private analytics(
    ledger: Ledger,
    tasks: TokenUsageTaskAttributionDto[],
    request?: TokenUsageSnapshotRequest
  ): TokenUsageAnalyticsSnapshotDto {
    return buildTokenUsageSnapshot({
      ...ledger,
      tasks,
      request,
      nowIso: this.deps.clock.now().toISOString(),
      degraded: this.refreshDegraded,
    });
  }
  private async publishCurrentSnapshot(): Promise<void> {
    const ledger = await this.deps.ledger.readSnapshot();
    this.remember(ledger);
    this.deps.publisher?.publishSnapshot(this.analytics(ledger, await this.listTaskAttributions()));
    await this.publishBudgetSafely();
  }
  private async listTaskAttributions(strict = false): Promise<TokenUsageTaskAttributionDto[]> {
    try {
      return (await this.deps.taskAttributionSource?.listTaskAttributions()) ?? [];
    } catch (error) {
      if (strict) throw error;
      this.deps.logger?.warn('Failed to list token usage tasks', error);
      return [];
    }
  }
}
