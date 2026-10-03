import { budgetCoverageKey, budgetPeriod } from '../domain';

import type { TokenUsageBudgetStatusDto, TokenUsageBudgetTargetStatusDto } from '../../contracts';
import type {
  TokenUsageBudgetNotificationEvaluatorPort,
  TokenUsageBudgetNotificationReason,
  TokenUsageBudgetNotificationRecord,
  TokenUsageBudgetNotificationSettingsPort,
  TokenUsageBudgetNotificationSinkPort,
  TokenUsageBudgetNotificationStateRepositoryPort,
  TokenUsageClockPort,
  TokenUsageLoggerPort,
} from './ports';

export interface TokenUsageBudgetNotificationEvaluatorDeps {
  state: TokenUsageBudgetNotificationStateRepositoryPort;
  sink: TokenUsageBudgetNotificationSinkPort;
  settings: TokenUsageBudgetNotificationSettingsPort;
  clock: TokenUsageClockPort;
  logger?: TokenUsageLoggerPort;
  minEvaluationIntervalMs?: number;
}

export class TokenUsageBudgetNotificationEvaluator implements TokenUsageBudgetNotificationEvaluatorPort {
  private running: Promise<void> | null = null;
  private queued: {
    status: TokenUsageBudgetStatusDto;
    reason: TokenUsageBudgetNotificationReason;
  } | null = null;
  private lastEvaluationAt = -Infinity;
  private readonly pending = new Map<string, TokenUsageBudgetNotificationRecord[]>();
  private readonly retryAt = new Map<string, number>();
  constructor(private readonly deps: TokenUsageBudgetNotificationEvaluatorDeps) {}

  async evaluate(
    status: TokenUsageBudgetStatusDto,
    reason: TokenUsageBudgetNotificationReason
  ): Promise<void> {
    this.queued = { status, reason };
    if (this.running) return this.running;
    this.running = this.drain();
    try {
      await this.running;
    } finally {
      this.running = null;
    }
  }

  async retryPending(): Promise<void> {
    // Pending accepted batches outlive stale data, pause and month rollover.
    for (const [key, batch] of this.pending) {
      try {
        await this.deps.state.markCovered(batch);
        this.pending.delete(key);
      } catch (error) {
        this.deps.logger?.warn('Failed to persist accepted budget coverage', error);
      }
    }
  }

  private async drain(): Promise<void> {
    const current = this.queued;
    this.queued = null;
    if (!current) return;
    await this.retryPending();
    const now = this.deps.clock.now();
    const { status, reason } = current;
    const period = budgetPeriod(now);
    if (
      status.period.key !== period.key ||
      status.period.from !== period.from ||
      status.period.to !== period.to ||
      status.period.timeZone !== 'UTC' ||
      status.stale ||
      status.degraded ||
      !status.notificationPolicy.enabled ||
      !this.deps.settings.getSettings().enabled
    )
      return;
    const interval = this.deps.minEvaluationIntervalMs ?? 30_000;
    if (reason === 'snapshot' && now.getTime() - this.lastEvaluationAt < interval) {
      // A cheap main tick supplies the latest status and performs trailing evaluation.
      this.queued ??= current;
      return;
    }
    this.lastEvaluationAt = now.getTime();
    const previous = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1))
      .toISOString()
      .slice(0, 7);
    await this.deps.state.pruneBeforePeriod(previous);
    for (const target of status.targets) {
      try {
        await this.evaluateTarget(target, status, now, interval);
      } catch (error) {
        this.deps.logger?.warn('Failed to evaluate budget target', error);
      }
    }
    if (this.queued && this.queued !== current) await this.drain();
  }

  private async evaluateTarget(
    target: TokenUsageBudgetTargetStatusDto,
    status: TokenUsageBudgetStatusDto,
    now: Date,
    interval: number
  ): Promise<void> {
    if (!target.notificationsEnabled || target.thresholds.length === 0) return;
    const reasons: TokenUsageBudgetNotificationRecord[] = [];
    const coverage: TokenUsageBudgetNotificationRecord[] = [];
    for (const metric of target.metrics) {
      if (
        metric.incomplete ||
        metric.value === null ||
        metric.percent === null ||
        ![metric.value, metric.limit, metric.percent].every(Number.isFinite) ||
        metric.limit <= 0 ||
        metric.value < 0
      )
        continue;
      const reached: TokenUsageBudgetNotificationRecord[] = [];
      for (const threshold of target.thresholds) {
        if (
          !Number.isInteger(threshold) ||
          threshold < 1 ||
          threshold > 100 ||
          metric.percent < threshold
        )
          continue;
        const record: TokenUsageBudgetNotificationRecord = {
          scope: target.scope,
          id: target.id,
          metric: metric.metric,
          threshold,
          periodKey: status.period.key,
          sentAt: now.toISOString(),
          value: metric.value,
          limit: metric.limit,
          percent: metric.percent,
          dedupeKey: '',
        };
        record.dedupeKey = budgetCoverageKey(record);
        const pending = [...this.pending.values()].some((batch) =>
          batch.some((item) => item.dedupeKey === record.dedupeKey)
        );
        if (!pending && !(await this.deps.state.hasSent(record.dedupeKey))) reached.push(record);
      }
      if (reached.length) {
        reasons.push(reached.reduce((a, b) => (a.threshold > b.threshold ? a : b)));
        coverage.push(...reached);
      }
    }
    if (!reasons.length) return;
    reasons.sort((a, b) => a.metric.localeCompare(b.metric));
    const dedupeKey = JSON.stringify([
      'token-budget-notification',
      status.period.key,
      target.scope,
      target.id,
      reasons.map(({ metric, threshold }) => [metric, threshold]),
    ]);
    const retryKey = JSON.stringify([status.period.key, target.scope, target.id]);
    if (this.pending.has(dedupeKey) || now.getTime() < (this.retryAt.get(retryKey) ?? -Infinity))
      return;
    const policy = this.deps.settings.getSettings();
    if (!policy.enabled) return;
    this.retryAt.set(retryKey, now.getTime() + interval);
    await this.deps.sink.notifyBudgetThreshold({
      dedupeKey,
      periodKey: status.period.key,
      scope: target.scope,
      id: target.id,
      label: target.label,
      sentAt: now.toISOString(),
      reasons,
      severity: reasons.some((item) => item.threshold === 100) ? 'critical' : 'warning',
      suppressToast: !policy.nativeToasts,
    });
    this.retryAt.delete(retryKey);
    // NotificationManager acceptance (including null/dedup) is not a durable OS ACK.
    this.pending.set(dedupeKey, coverage);
    try {
      await this.deps.state.markCovered(coverage);
      this.pending.delete(dedupeKey);
    } catch (error) {
      this.deps.logger?.warn('Failed to persist accepted budget coverage', error);
    }
  }
}
