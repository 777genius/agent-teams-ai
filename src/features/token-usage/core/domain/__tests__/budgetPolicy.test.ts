import { describe, expect, it } from 'vitest';

import { buildBudgetStatus, buildTokenUsageSnapshot, normalizeCostBreakdown } from '..';

import { testEvent, testRun } from './budgetFixtures';

const config = {
  global: {
    monthlyTokenLimit: 200,
    monthlyApiEquivalentCostLimitUsd: 5,
    thresholds: [50, 70, 90, 100],
    notificationsEnabled: true,
  },
  projects: {
    'project:missing': { monthlyTokenLimit: 100, thresholds: [], notificationsEnabled: false },
  },
};
const now = new Date('2026-10-03T12:00:00.000Z');
export function project(runs = [testRun()], events = [testEvent()]) {
  return buildBudgetStatus({
    now,
    settings: config,
    ledger: { runs, events },
    degraded: false,
    usageUpdatedAt: now.toISOString(),
    policy: { enabled: true, nativeToasts: false },
  });
}

describe('Budget monthly projection', () => {
  it.each([
    ['future after clock rollback', '2026-10-03T13:00:00.000Z', true],
    ['current clock', '2026-10-03T12:00:00.000Z', false],
    ['just inside freshness window', '2026-10-03T11:55:00.001Z', false],
    ['at freshness deadline', '2026-10-03T11:55:00.000Z', true],
  ] as const)('bounds freshness for %s', (_label, usageUpdatedAt, stale) => {
    const status = buildBudgetStatus({
      now,
      settings: config,
      ledger: { runs: [testRun()], events: [testEvent()] },
      degraded: false,
      usageUpdatedAt,
      policy: { enabled: true, nativeToasts: false },
    });
    expect(status.stale).toBe(stale);
  });
  // Old getSnapshot range drops old running/completed runs, includes exact `to`; all-time overcounts prior events.
  it('counts events in [from,to) with full run map, UTC offsets and canonical cache-inclusive total', () => {
    const events = [
      testEvent({ id: 'old', occurredAt: '2026-09-30T23:59:59.999Z' }),
      testEvent({ id: 'from', occurredAt: '2026-10-01T00:00:00.000Z' }),
      testEvent({ id: 'offset', occurredAt: '2026-10-31T23:30:00-01:00' }),
      testEvent({ id: 'inside', occurredAt: '2026-11-01T00:30:00+01:00' }),
      testEvent({ id: 'to', occurredAt: '2026-11-01T00:00:00.000Z' }),
    ];
    for (const runStatus of ['running', 'completed'] as const) {
      const runs = [
        testRun({
          status: runStatus,
          endedAt: runStatus === 'completed' ? '2026-08-02T00:00:00.000Z' : undefined,
        }),
      ];
      const status = project(runs, events);
      expect(status.targets[0].metrics.map((metric) => metric.value)).toEqual([200, 4]);
      expect(status.targets[0].metrics[0]).toMatchObject({
        percent: 100,
        remaining: 0,
        nextThreshold: undefined,
      });
      expect(
        buildTokenUsageSnapshot({
          runs,
          events,
          nowIso: now.toISOString(),
          request: { from: status.period.from, to: status.period.to },
        }).summary.totalTokens
      ).toBe(0);
      expect(
        buildTokenUsageSnapshot({ runs, events, nowIso: now.toISOString() }).summary.totalTokens
      ).toBe(500);
    }
  });
  it('projects independent global/team/project limits from the same canonical cache-inclusive usage', () => {
    const status = buildBudgetStatus({
      now,
      ledger: {
        runs: [testRun()],
        events: [testEvent({ id: 'one' }), testEvent({ id: 'two' }), testEvent({ id: 'three' })],
      },
      settings: {
        global: { monthlyTokenLimit: 500, thresholds: [50, 100], notificationsEnabled: true },
        teams: {
          'sandbox-team': {
            monthlyTokenLimit: 250,
            thresholds: [50, 100],
            notificationsEnabled: true,
          },
        },
        projects: {
          'project:sandbox:hash': {
            monthlyTokenLimit: 100,
            thresholds: [50, 100],
            notificationsEnabled: true,
          },
        },
      },
      degraded: false,
      usageUpdatedAt: now.toISOString(),
      policy: { enabled: true, nativeToasts: false },
    });
    expect(
      status.targets.map((target) => [target.scope, target.id, target.metrics[0].percent])
    ).toEqual([
      ['global', 'global', 60],
      ['team', 'sandbox-team', 120],
      ['project', 'project:sandbox:hash', 300],
    ]);
    expect(status.targets.map((target) => target.metrics[0].value)).toEqual([300, 300, 300]);
  });
  it('keeps saved zero targets and scope identities outside analytics filters', () => {
    const status = project();
    expect(status.targets[1]).toMatchObject({
      id: 'project:missing',
      metrics: [{ value: 0, percent: 0, remaining: 100 }],
    });
    expect(status.options.map((option) => option.id)).toContain('project:sandbox:hash');
    expect(status.options.map((option) => option.id)).toContain('project:missing');
  });
  it.each(['api', 'subscription', 'free', 'unknown'] as const)(
    'counts %s billing without converting credits',
    (billingMode) => {
      const status = project(
        [testRun({ teamName: undefined })],
        [
          testEvent({
            billingMode,
            providerUsage: { kiro: { credits: 123, creditsUnit: 'credits' } },
          }),
        ]
      );
      expect(status.targets[0].metrics.map((metric) => metric.value)).toEqual([100, 2]);
      expect(status.options.map((option) => option.id)).toContain('unassigned');
    }
  );
  it('unknown cost is incomplete subtotal; invalid dates/unmapped month events degrade', () => {
    const unknown = testEvent({
      id: 'unknown',
      cost: normalizeCostBreakdown({ source: 'unknown' }),
    });
    const status = project(
      [testRun()],
      [
        testEvent(),
        unknown,
        testEvent({ id: 'invalid', occurredAt: 'invalid-date' }),
        testEvent({ id: 'unmapped', appRunId: 'missing' }),
      ]
    );
    expect(status.degraded).toBe(true);
    expect(status.targets[0].metrics[0]).toMatchObject({ value: 200, incomplete: false });
    expect(status.targets[0].metrics[1]).toMatchObject({ value: 2, incomplete: true });
  });
  it('known zero cost stays complete and unavailable ledger is null rather than zero', () => {
    expect(
      project(
        [testRun()],
        [testEvent({ model: 'custom-model', cost: normalizeCostBreakdown({ source: 'provider' }) })]
      ).targets[0].metrics[1].incomplete
    ).toBe(false);
    const unavailable = buildBudgetStatus({
      now,
      settings: config,
      ledger: null,
      degraded: true,
      policy: { enabled: true, nativeToasts: true },
    });
    expect(unavailable.stale).toBe(true);
    expect(unavailable.targets[0].metrics[0]).toMatchObject({
      value: null,
      percent: null,
      remaining: null,
    });
  });
});
