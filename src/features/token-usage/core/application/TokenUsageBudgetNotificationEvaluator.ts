import type {
  TokenUsageAnalyticsSnapshotDto,
  TokenUsageBudgetLimitDto,
  TokenUsageBudgetSettingsDto,
  TokenUsageSummaryDto,
} from '../../contracts';
import type {
  TokenUsageBudgetNotificationEvaluatorPort,
  TokenUsageBudgetNotificationMetric,
  TokenUsageBudgetNotificationReason,
  TokenUsageBudgetNotificationRecord,
  TokenUsageBudgetNotificationScope,
  TokenUsageBudgetNotificationSettingsPort,
  TokenUsageBudgetNotificationSinkPort,
  TokenUsageBudgetNotificationStateRepositoryPort,
  TokenUsageBudgetNotificationThreshold,
  TokenUsageBudgetSettingsRepositoryPort,
  TokenUsageClockPort,
  TokenUsageLoggerPort,
} from './ports';

interface BudgetTarget {
  scope: TokenUsageBudgetNotificationScope;
  id: string;
  label: string;
  summary: TokenUsageSummaryDto;
  limit: TokenUsageBudgetLimitDto;
}

export interface TokenUsageBudgetNotificationEvaluatorDeps {
  budgets: TokenUsageBudgetSettingsRepositoryPort;
  state: TokenUsageBudgetNotificationStateRepositoryPort;
  sink: TokenUsageBudgetNotificationSinkPort;
  settings: TokenUsageBudgetNotificationSettingsPort;
  clock: TokenUsageClockPort;
  logger?: TokenUsageLoggerPort;
  minEvaluationIntervalMs?: number;
}

const DEFAULT_MIN_EVALUATION_INTERVAL_MS = 30_000;

export class TokenUsageBudgetNotificationEvaluator implements TokenUsageBudgetNotificationEvaluatorPort {
  readonly #deps: TokenUsageBudgetNotificationEvaluatorDeps;
  #lastEvaluationAtMs = 0;
  #lastFingerprint: string | null = null;
  #running: Promise<void> | null = null;
  #queued: {
    snapshot: TokenUsageAnalyticsSnapshotDto;
    reason: TokenUsageBudgetNotificationReason;
  } | null = null;

  constructor(deps: TokenUsageBudgetNotificationEvaluatorDeps) {
    this.#deps = deps;
  }

  async evaluate(
    snapshot: TokenUsageAnalyticsSnapshotDto,
    reason: TokenUsageBudgetNotificationReason
  ): Promise<void> {
    if (this.#running) {
      this.#queued = { snapshot, reason };
      await this.#running;
      return;
    }
    this.#running = this.#drain(snapshot, reason);
    await this.#running;
  }

  async #drain(
    snapshot: TokenUsageAnalyticsSnapshotDto,
    reason: TokenUsageBudgetNotificationReason
  ): Promise<void> {
    try {
      let currentSnapshot = snapshot;
      let currentReason = reason;
      while (true) {
        await this.#evaluateNow(currentSnapshot, currentReason);
        const queued = this.#queued;
        if (!queued) return;
        this.#queued = null;
        currentSnapshot = queued.snapshot;
        currentReason = queued.reason;
      }
    } finally {
      this.#running = null;
    }
  }

  async #evaluateNow(
    snapshot: TokenUsageAnalyticsSnapshotDto,
    reason: TokenUsageBudgetNotificationReason
  ): Promise<void> {
    if (snapshot.degraded || snapshot.stale) {
      this.#deps.logger?.warn(
        'Skipping token budget notification check for stale/degraded snapshot'
      );
      return;
    }

    const now = this.#deps.clock.now();
    const settings = this.#deps.settings.getSettings();
    if (!settings.enabled) return;

    const budgets = await this.#deps.budgets.getSettings();
    const fingerprint = JSON.stringify({
      updatedAt: snapshot.updatedAt,
      budgets,
      settings,
    });
    if (fingerprint === this.#lastFingerprint) return;

    const minInterval = this.#deps.minEvaluationIntervalMs ?? DEFAULT_MIN_EVALUATION_INTERVAL_MS;
    const bypassThrottle = reason === 'settings' || reason === 'startup';
    if (!bypassThrottle && now.getTime() - this.#lastEvaluationAtMs < minInterval) return;

    this.#lastEvaluationAtMs = now.getTime();

    const periodKey = periodKeyFor(snapshot.updatedAt);
    await this.#deps.state.pruneBeforePeriod(monthKeyOffset(periodKey, -2));

    for (const target of budgetTargets(snapshot, budgets)) {
      await this.#evaluateTarget(target, periodKey, settings, now);
    }
    this.#lastFingerprint = fingerprint;
  }

  async #evaluateTarget(
    target: BudgetTarget,
    periodKey: string,
    settings: ReturnType<TokenUsageBudgetNotificationSettingsPort['getSettings']>,
    now: Date
  ): Promise<void> {
    const checks = budgetMetricChecks(target);
    for (const check of checks) {
      const percent = check.limit > 0 ? (check.value / check.limit) * 100 : 0;
      const thresholds: TokenUsageBudgetNotificationThreshold[] = [];
      if (settings.notifyAtCritical && percent >= 100) {
        thresholds.push(100);
      } else if (settings.notifyAtWarning && percent >= 80) {
        thresholds.push(80);
      }

      for (const threshold of thresholds) {
        const dedupeKey = [
          'token-budget',
          'monthly',
          target.scope,
          target.id,
          check.metric,
          String(threshold),
          periodKey,
        ].join(':');
        if (await this.#deps.state.hasSent(dedupeKey)) continue;

        const record: TokenUsageBudgetNotificationRecord = {
          dedupeKey,
          sentAt: now.toISOString(),
          periodKey,
          scope: target.scope,
          id: target.id,
          metric: check.metric,
          threshold,
          value: check.value,
          limit: check.limit,
          percent,
        };
        await this.#deps.sink.notifyBudgetThreshold({
          ...record,
          label: target.label,
          severity: threshold === 100 ? 'critical' : 'warning',
          suppressToast: !settings.nativeToasts,
        });
        await this.#deps.state.markSent(record);
      }
    }
  }
}

function budgetTargets(
  snapshot: TokenUsageAnalyticsSnapshotDto,
  budgets: TokenUsageBudgetSettingsDto
): BudgetTarget[] {
  const targets: BudgetTarget[] = [];
  if (budgets.global && hasBudgetLimit(budgets.global)) {
    targets.push({
      scope: 'global',
      id: 'global',
      label: 'All teams',
      summary: snapshot.summary,
      limit: budgets.global,
    });
  }

  for (const team of snapshot.byTeam) {
    const limit = budgets.teams?.[team.id];
    if (limit && hasBudgetLimit(limit)) {
      targets.push({
        scope: 'team',
        id: team.id,
        label: team.label,
        summary: team.summary,
        limit,
      });
    }
  }

  for (const project of snapshot.byProject) {
    const limit = budgets.projects?.[project.id];
    if (limit && hasBudgetLimit(limit)) {
      targets.push({
        scope: 'project',
        id: project.id,
        label: project.label,
        summary: project.summary,
        limit,
      });
    }
  }

  return targets;
}

function hasBudgetLimit(limit: TokenUsageBudgetLimitDto): boolean {
  return (
    (typeof limit.monthlyTokenLimit === 'number' && limit.monthlyTokenLimit > 0) ||
    (typeof limit.monthlyApiEquivalentCostLimitUsd === 'number' &&
      limit.monthlyApiEquivalentCostLimitUsd > 0)
  );
}

function budgetMetricChecks(target: BudgetTarget): {
  metric: TokenUsageBudgetNotificationMetric;
  value: number;
  limit: number;
}[] {
  const checks: { metric: TokenUsageBudgetNotificationMetric; value: number; limit: number }[] = [];
  if (target.limit.monthlyTokenLimit && target.limit.monthlyTokenLimit > 0) {
    checks.push({
      metric: 'tokens',
      value: target.summary.totalTokens,
      limit: target.limit.monthlyTokenLimit,
    });
  }
  if (
    target.limit.monthlyApiEquivalentCostLimitUsd &&
    target.limit.monthlyApiEquivalentCostLimitUsd > 0
  ) {
    checks.push({
      metric: 'apiEquivalentCostUsd',
      value: target.summary.apiEquivalentCostUsd,
      limit: target.limit.monthlyApiEquivalentCostLimitUsd,
    });
  }
  return checks;
}

function periodKeyFor(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return new Date().toISOString().slice(0, 7);
  return parsed.toISOString().slice(0, 7);
}

function monthKeyOffset(periodKey: string, offset: number): string {
  const [year = '1970', month = '01'] = periodKey.split('-');
  const date = new Date(Date.UTC(Number(year), Number(month) - 1 + offset, 1));
  return date.toISOString().slice(0, 7);
}
