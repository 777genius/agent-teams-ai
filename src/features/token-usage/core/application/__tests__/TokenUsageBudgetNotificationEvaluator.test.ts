import { describe, expect, it } from 'vitest';

import { budgetCoverageKey } from '../../domain';
import { TokenUsageBudgetNotificationEvaluator } from '../TokenUsageBudgetNotificationEvaluator';

import type { TokenUsageBudgetStatusDto } from '../../../contracts';
import type {
  TokenUsageBudgetNotificationEvent,
  TokenUsageBudgetNotificationRecord,
} from '../ports';
import type { TokenUsageBudgetNotificationEvaluatorDeps } from '../TokenUsageBudgetNotificationEvaluator';

// Catches lost lower-threshold coverage, split toasts, retry duplicates and stale-month delivery.
const initialTime = '2026-10-03T12:00:00.000Z';
function status(
  percent: number,
  overrides: Partial<TokenUsageBudgetStatusDto> = {}
): TokenUsageBudgetStatusDto {
  return {
    period: {
      key: '2026-10',
      from: '2026-10-01T00:00:00.000Z',
      to: '2026-11-01T00:00:00.000Z',
      timeZone: 'UTC',
    },
    computedAt: initialTime,
    stale: false,
    degraded: false,
    notificationPolicy: { enabled: true, nativeToasts: false },
    options: [],
    targets: [
      {
        scope: 'project',
        id: 'project:a:b',
        label: 'Sandbox',
        thresholds: [50, 70, 90, 100],
        notificationsEnabled: true,
        metrics: [
          {
            metric: 'tokens',
            value: percent * 10,
            limit: 1000,
            percent,
            remaining: Math.max(0, 1000 - percent * 10),
            incomplete: false,
          },
        ],
      },
    ],
    ...overrides,
  };
}
function fixture() {
  let now = new Date(initialTime);
  let failSink = false;
  let failPersist = false;
  let enabled = true;
  const covered = new Set<string>();
  const calls: TokenUsageBudgetNotificationEvent[] = [];
  const batches: TokenUsageBudgetNotificationRecord[][] = [];
  const state = {
    hasSent: async (key: string) => covered.has(key),
    pruneBeforePeriod: async () => undefined,
    markCovered: async (records: readonly TokenUsageBudgetNotificationRecord[]) => {
      if (failPersist) throw new Error('disk full');
      batches.push([...records]);
      for (const item of records) covered.add(budgetCoverageKey(item));
    },
  };
  const make = (overrides: Partial<TokenUsageBudgetNotificationEvaluatorDeps> = {}) =>
    new TokenUsageBudgetNotificationEvaluator({
      state,
      clock: { now: () => now },
      settings: {
        getSettings: () => ({
          enabled,
          nativeToasts: false,
          notifyAtWarning: false,
          notifyAtCritical: false,
        }),
      },
      sink: {
        notifyBudgetThreshold: async (event) => {
          calls.push(event);
          if (failSink) throw new Error('offline');
        },
      },
      ...overrides,
    });
  return {
    make,
    calls,
    covered,
    batches,
    state,
    advance: (ms = 30_000) => {
      now = new Date(now.getTime() + ms);
    },
    sinkFails: (v: boolean) => {
      failSink = v;
    },
    persistFails: (v: boolean) => {
      failPersist = v;
    },
    enable: (v: boolean) => {
      enabled = v;
    },
  };
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}
describe('monthly aggregate budget notifications', () => {
  it('45 -> 92 sends one highest reason and covers every reached configured level', async () => {
    const f = fixture();
    const evaluator = f.make();
    await evaluator.evaluate(status(45), 'startup');
    f.advance();
    await evaluator.evaluate(status(92), 'snapshot');
    expect(f.calls.map((event) => event.reasons.map((reason) => reason.threshold))).toEqual([[90]]);
    expect(f.batches[0].map((item) => item.threshold)).toEqual([50, 70, 90]);
    f.advance();
    await evaluator.evaluate(status(55), 'snapshot');
    f.advance();
    await evaluator.evaluate(status(92), 'snapshot');
    expect(f.calls).toHaveLength(1);
    await f.make().evaluate(status(92), 'startup');
    expect(f.calls).toHaveLength(1);
    f.advance();
    await evaluator.evaluate(status(110), 'snapshot');
    expect(f.calls[1].reasons[0].threshold).toBe(100);
    f.advance();
    await evaluator.evaluate(status(110), 'snapshot');
    expect(f.calls).toHaveLength(2);
  });
  it('first >100 aggregates both metrics in one critical sink and one atomic batch', async () => {
    const f = fixture();
    const data = status(130);
    data.targets[0].metrics.push({
      metric: 'apiEquivalentCostUsd',
      value: 12,
      limit: 10,
      percent: 120,
      remaining: 0,
      incomplete: false,
    });
    await f.make().evaluate(data, 'startup');
    expect(f.calls).toHaveLength(1);
    expect(f.calls[0].reasons.map((reason) => [reason.metric, reason.threshold])).toEqual([
      ['apiEquivalentCostUsd', 100],
      ['tokens', 100],
    ]);
    expect(f.calls[0].severity).toBe('critical');
    expect(f.calls[0].suppressToast).toBe(true);
    expect(f.batches).toHaveLength(1);
    expect(f.batches[0]).toHaveLength(8);
  });
  it.each([
    { stale: true },
    { degraded: true },
    {
      period: {
        key: '2026-09',
        from: '2026-09-01T00:00:00.000Z',
        to: '2026-10-01T00:00:00.000Z',
        timeZone: 'UTC' as const,
      },
    },
  ])('does not deliver invalid health/month %j', async (override) => {
    const f = fixture();
    await f.make().evaluate(status(130, override), 'startup');
    expect(f.calls).toHaveLength(0);
  });
  it('unknown USD does not suppress independently valid tokens; paused/master stop delivery', async () => {
    const f = fixture();
    const data = status(92);
    data.targets[0].metrics.push({
      metric: 'apiEquivalentCostUsd',
      value: 20,
      limit: 10,
      percent: 200,
      remaining: 0,
      incomplete: true,
    });
    data.targets[0].notificationsEnabled = false;
    const e = f.make();
    await e.evaluate(data, 'settings');
    expect(f.calls).toHaveLength(0);
    data.targets[0].notificationsEnabled = true;
    f.enable(false);
    await e.evaluate(data, 'settings');
    expect(f.calls).toHaveLength(0);
    f.enable(true);
    await e.evaluate(data, 'settings');
    expect(f.calls[0].reasons.map((reason) => reason.metric)).toEqual(['tokens']);
  });
  it('sink rejection retries stable identity after 30s without coverage', async () => {
    const f = fixture();
    const e = f.make();
    f.sinkFails(true);
    await e.evaluate(status(92), 'startup');
    expect(f.covered.size).toBe(0);
    f.sinkFails(false);
    f.advance(29_000);
    await e.evaluate(status(95), 'settings');
    expect(f.calls).toHaveLength(1);
    f.advance(1000);
    await e.evaluate(status(95), 'tick');
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].dedupeKey).toBe(f.calls[0].dedupeKey);
  });
  it('accepted sink with failed persist retries only disk even after pause/rollover', async () => {
    const f = fixture();
    const e = f.make();
    f.persistFails(true);
    await e.evaluate(status(130), 'startup');
    expect(f.calls).toHaveLength(1);
    f.persistFails(false);
    f.enable(false);
    await e.evaluate(status(0, { stale: true }), 'tick');
    expect(f.calls).toHaveLength(1);
    expect(f.covered.size).toBe(4);
  });
  it('limit change and remove/readd preserve month coverage; a new month gets a new cycle', async () => {
    const f = fixture();
    const e = f.make();
    await e.evaluate(status(92), 'startup');
    const changed = status(180);
    changed.targets[0].thresholds = [50, 90];
    changed.targets[0].metrics[0].limit = 500;
    await e.evaluate(changed, 'settings');
    expect(f.calls).toHaveLength(1);
    await e.evaluate({ ...changed, targets: [] }, 'settings');
    await e.evaluate(changed, 'settings');
    expect(f.calls).toHaveLength(1);
    const next = status(92, {
      period: {
        key: '2026-11',
        from: '2026-11-01T00:00:00.000Z',
        to: '2026-12-01T00:00:00.000Z',
        timeZone: 'UTC',
      },
    });
    f.advance(31 * 24 * 60 * 60 * 1000);
    await e.evaluate(next, 'month');
    expect(f.calls).toHaveLength(2);
  });
  it('trailing tick evaluates latest throttled state and new custom level respects coverage', async () => {
    const f = fixture();
    const e = f.make();
    await e.evaluate(status(45), 'startup');
    f.advance(10_000);
    await e.evaluate(status(92), 'snapshot');
    expect(f.calls).toHaveLength(0);
    f.advance(20_000);
    await e.evaluate(status(92), 'tick');
    expect(f.calls).toHaveLength(1);
    const next = status(99);
    next.targets[0].thresholds = [50, 90, 95];
    await e.evaluate(next, 'settings');
    expect(f.calls[1].reasons[0].threshold).toBe(95);
    await e.evaluate(status(92), 'settings');
    expect(f.calls).toHaveLength(2);
  });
  it('clock rollback evaluates fresh snapshots without duplicating covered thresholds', async () => {
    const f = fixture();
    const e = f.make();
    await e.evaluate(status(55), 'startup');
    f.advance(-60 * 60 * 1000);
    await e.evaluate(status(92), 'snapshot');
    expect(f.calls.map((event) => event.reasons[0].threshold)).toEqual([50, 90]);
    expect(f.batches.map((batch) => batch.map((item) => item.threshold))).toEqual([[50], [70, 90]]);
    await e.evaluate(status(100), 'snapshot');
    expect(f.calls).toHaveLength(2);
    f.advance();
    await e.evaluate(status(100), 'snapshot');
    expect(f.calls).toHaveLength(3);
    expect(f.covered.size).toBe(4);
  });
  it('clock rollback recovers a failed sink retry and starts a new bounded retry window', async () => {
    const f = fixture();
    const e = f.make();
    f.sinkFails(true);
    await e.evaluate(status(92), 'startup');
    f.advance(-60 * 60 * 1000);
    await e.evaluate(status(92), 'snapshot');
    expect(f.calls).toHaveLength(2);
    expect(f.calls[1].dedupeKey).toBe(f.calls[0].dedupeKey);
    f.sinkFails(false);
    f.advance(29_000);
    await e.evaluate(status(92), 'settings');
    expect(f.calls).toHaveLength(2);
    f.advance(1000);
    await e.evaluate(status(92), 'tick');
    expect(f.calls).toHaveLength(3);
    expect(f.batches).toHaveLength(1);
    expect(f.covered.size).toBe(3);
  });
  it.each([true, false])(
    'drains newer settings after an in-flight %s stale/throttled snapshot',
    async (stale) => {
      const f = fixture();
      const entered = deferred();
      const release = deferred();
      let blockPersist = false;
      const e = f.make({
        state: {
          ...f.state,
          markCovered: async (records) => {
            if (blockPersist) {
              blockPersist = false;
              entered.resolve();
              await release.promise;
            }
            await f.state.markCovered(records);
          },
        },
      });
      f.persistFails(true);
      await e.evaluate(status(55), 'startup');
      f.persistFails(false);
      f.advance(1000);
      blockPersist = true;
      const earlier = e.evaluate(status(60, { stale }), 'snapshot');
      await entered.promise;
      const newer = e.evaluate(status(92), 'settings');
      release.resolve();
      await Promise.all([earlier, newer]);
      expect(f.calls.map((event) => event.reasons[0].threshold)).toEqual([50, 90]);
      expect(f.batches.map((batch) => batch.map((item) => item.threshold))).toEqual([
        [50],
        [70, 90],
      ]);
      await e.evaluate(status(92), 'settings');
      expect(f.calls).toHaveLength(2);
      expect(f.covered.size).toBe(3);
    }
  );
  it('a settings update arriving in the settlement microtask starts a new drain', async () => {
    const f = fixture();
    let queued: Promise<void> | undefined;
    let first = true;
    const e = f.make({
      settings: {
        getSettings: () => {
          const enabled = !first;
          if (first) {
            first = false;
            queueMicrotask(() => {
              queued = e.evaluate(status(92), 'settings');
            });
          }
          return {
            enabled,
            nativeToasts: false,
            notifyAtWarning: false,
            notifyAtCritical: false,
          };
        },
      },
    });
    await e.evaluate(status(55), 'startup');
    expect(queued).toBeDefined();
    await queued;
    expect(f.calls.map((event) => event.reasons[0].threshold)).toEqual([90]);
    expect(f.covered.size).toBe(3);
  });
  it('coalesces repeated throttled snapshots and delivers the latest state on a trailing tick', async () => {
    const f = fixture();
    const e = f.make();
    await e.evaluate(status(45), 'startup');
    f.advance(1000);
    await Promise.all([55, 70, 92, 100].map((percent) => e.evaluate(status(percent), 'snapshot')));
    expect(f.calls).toHaveLength(0);
    f.advance(29_000);
    await e.evaluate(status(100), 'tick');
    expect(f.calls.map((event) => event.reasons[0].threshold)).toEqual([100]);
    expect(f.batches).toHaveLength(1);
    expect(f.covered.size).toBe(4);
  });
});
