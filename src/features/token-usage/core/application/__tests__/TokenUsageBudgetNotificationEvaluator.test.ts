import { describe, expect, it } from 'vitest';

import { TokenUsageBudgetNotificationEvaluator } from '../TokenUsageBudgetNotificationEvaluator';

import type {
  TokenUsageAnalyticsSnapshotDto,
  TokenUsageBudgetSettingsDto,
  TokenUsageSummaryDto,
} from '../../../contracts';
import type {
  TokenUsageBudgetNotificationEvent,
  TokenUsageBudgetNotificationRecord,
  TokenUsageBudgetNotificationSettings,
  TokenUsageBudgetNotificationStateRepositoryPort,
  TokenUsageBudgetSettingsRepositoryPort,
} from '../ports';

const ZERO_SUMMARY: TokenUsageSummaryDto = {
  requestCount: 0,
  runCount: 0,
  runningRunCount: 0,
  totalTokens: 0,
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationTokens: 0,
  cacheReadTokens: 0,
  reasoningTokens: 0,
  estimatedCostUsd: 0,
  billableCostUsd: 0,
  apiEquivalentCostUsd: 0,
  costKnownEventCount: 0,
  billableEventCount: 0,
  apiBillingRequestCount: 0,
  subscriptionRequestCount: 0,
  freeRequestCount: 0,
  unknownBillingRequestCount: 0,
  apiBillingTokens: 0,
  subscriptionTokens: 0,
  freeTokens: 0,
  unknownBillingTokens: 0,
  exactEventCount: 0,
  estimatedEventCount: 0,
};

describe('TokenUsageBudgetNotificationEvaluator', () => {
  it('sends warning once and critical when usage later crosses 100%', async () => {
    const sink = new MemorySink();
    const evaluator = createEvaluator({
      budgets: { global: { monthlyTokenLimit: 1_000 } },
      sink,
    });

    await evaluator.evaluate(makeSnapshot({ totalTokens: 850 }), 'snapshot');
    await evaluator.evaluate(makeSnapshot({ totalTokens: 850 }), 'snapshot');
    await evaluator.evaluate(
      makeSnapshot({ totalTokens: 1_100, updatedAt: '2026-06-30T00:01:00.000Z' }),
      'snapshot'
    );

    expect(sink.events.map((event) => event.threshold)).toEqual([80, 100]);
  });

  it('sends only the critical notification when first observed over 100%', async () => {
    const sink = new MemorySink();
    const evaluator = createEvaluator({
      budgets: { global: { monthlyTokenLimit: 1_000 } },
      sink,
    });

    await evaluator.evaluate(makeSnapshot({ totalTokens: 1_300 }), 'snapshot');

    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.threshold).toBe(100);
  });

  it('skips stale or degraded snapshots', async () => {
    const sink = new MemorySink();
    const evaluator = createEvaluator({
      budgets: { global: { monthlyTokenLimit: 1_000 } },
      sink,
    });

    await evaluator.evaluate(makeSnapshot({ totalTokens: 1_300, degraded: true }), 'snapshot');
    await evaluator.evaluate(makeSnapshot({ totalTokens: 1_300, stale: true }), 'snapshot');

    expect(sink.events).toHaveLength(0);
  });

  it('does not mark a notification sent when the sink fails', async () => {
    const sink = new MemorySink();
    sink.failNext = true;
    const state = new MemoryStateRepository();
    const evaluator = createEvaluator({
      budgets: { global: { monthlyTokenLimit: 1_000 } },
      sink,
      state,
    });

    const snapshot = makeSnapshot({ totalTokens: 1_300 });
    await expect(evaluator.evaluate(snapshot, 'snapshot')).rejects.toThrow('sink failed');
    expect(state.sent.size).toBe(0);

    await evaluator.evaluate(snapshot, 'settings');

    expect(sink.events).toHaveLength(1);
    expect(state.sent.size).toBe(1);
  });

  it('uses the native toast setting as a suppressToast flag', async () => {
    const sink = new MemorySink();
    const evaluator = createEvaluator({
      budgets: { global: { monthlyApiEquivalentCostLimitUsd: 10 } },
      settings: { nativeToasts: false },
      sink,
    });

    await evaluator.evaluate(makeSnapshot({ apiEquivalentCostUsd: 11 }), 'snapshot');

    expect(sink.events[0]).toMatchObject({
      metric: 'apiEquivalentCostUsd',
      suppressToast: true,
      threshold: 100,
    });
  });
});

function createEvaluator({
  budgets,
  settings,
  sink,
  state = new MemoryStateRepository(),
}: {
  budgets: TokenUsageBudgetSettingsDto;
  settings?: Partial<TokenUsageBudgetNotificationSettings>;
  sink: MemorySink;
  state?: MemoryStateRepository;
}): TokenUsageBudgetNotificationEvaluator {
  return new TokenUsageBudgetNotificationEvaluator({
    budgets: new MemoryBudgetSettingsRepository(budgets),
    state,
    sink,
    settings: {
      getSettings: () => ({
        enabled: true,
        notifyAtWarning: true,
        notifyAtCritical: true,
        nativeToasts: true,
        ...settings,
      }),
    },
    clock: { now: () => new Date('2026-06-30T00:00:00.000Z') },
    minEvaluationIntervalMs: 0,
  });
}

function makeSnapshot({
  totalTokens = 0,
  apiEquivalentCostUsd = 0,
  updatedAt = '2026-06-30T00:00:00.000Z',
  degraded = false,
  stale = false,
}: {
  totalTokens?: number;
  apiEquivalentCostUsd?: number;
  updatedAt?: string;
  degraded?: boolean;
  stale?: boolean;
}): TokenUsageAnalyticsSnapshotDto {
  const summary = {
    ...ZERO_SUMMARY,
    totalTokens,
    apiEquivalentCostUsd,
    requestCount: totalTokens > 0 || apiEquivalentCostUsd > 0 ? 1 : 0,
  };
  return {
    updatedAt,
    stale,
    degraded,
    summary,
    byTeam: [],
    byAgent: [],
    byCommand: [],
    bySession: [],
    byProject: [],
    byRuntime: [],
    byModel: [],
    byTask: [],
    commandRuns: [],
    sessionRuns: [],
    tokenTrend: [],
    usageHeatmap: [],
    recentRuns: [],
    expensiveRuns: [],
    unmappedEventCount: 0,
    sourceCounts: {
      sdk_exact: 0,
      gateway_exact: 0,
      log_parsed: 0,
      tokenizer_estimated: 0,
      cost_estimated: 0,
    },
  };
}

class MemoryBudgetSettingsRepository implements TokenUsageBudgetSettingsRepositoryPort {
  constructor(private settings: TokenUsageBudgetSettingsDto) {}

  async getSettings(): Promise<TokenUsageBudgetSettingsDto> {
    return this.settings;
  }

  async updateSettings(
    settings: TokenUsageBudgetSettingsDto
  ): Promise<TokenUsageBudgetSettingsDto> {
    this.settings = settings;
    return settings;
  }
}

class MemoryStateRepository implements TokenUsageBudgetNotificationStateRepositoryPort {
  readonly sent = new Map<string, TokenUsageBudgetNotificationRecord>();

  async hasSent(dedupeKey: string): Promise<boolean> {
    return this.sent.has(dedupeKey);
  }

  async markSent(record: TokenUsageBudgetNotificationRecord): Promise<void> {
    this.sent.set(record.dedupeKey, record);
  }

  async pruneBeforePeriod(periodKey: string): Promise<void> {
    for (const [dedupeKey, record] of this.sent.entries()) {
      if (record.periodKey < periodKey) {
        this.sent.delete(dedupeKey);
      }
    }
  }
}

class MemorySink {
  readonly events: TokenUsageBudgetNotificationEvent[] = [];
  failNext = false;

  async notifyBudgetThreshold(event: TokenUsageBudgetNotificationEvent): Promise<void> {
    if (this.failNext) {
      this.failNext = false;
      throw new Error('sink failed');
    }
    this.events.push(event);
  }
}
