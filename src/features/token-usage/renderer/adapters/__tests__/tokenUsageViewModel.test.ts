import { describe, expect, it } from 'vitest';

import { toTokenUsageDashboardViewModel } from '../tokenUsageViewModel';

import type { TokenUsageAnalyticsSnapshotDto } from '../../../contracts';

const ZERO_SUMMARY = {
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

function snapshot(): TokenUsageAnalyticsSnapshotDto {
  return {
    updatedAt: '2026-06-30T00:00:00.000Z',
    stale: false,
    degraded: false,
    summary: {
      ...ZERO_SUMMARY,
      requestCount: 2,
      runCount: 2,
      totalTokens: 300,
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 150,
      estimatedCostUsd: 1.25,
      apiEquivalentCostUsd: 1.25,
      subscriptionTokens: 300,
      subscriptionRequestCount: 2,
      costKnownEventCount: 2,
    },
    byTeam: [
      {
        id: 'alpha',
        label: 'alpha',
        teamName: 'alpha',
        summary: {
          ...ZERO_SUMMARY,
          totalTokens: 300,
          requestCount: 2,
          estimatedCostUsd: 1.25,
          apiEquivalentCostUsd: 1.25,
        },
        lastActivityAt: '2026-06-30T00:00:00.000Z',
      },
    ],
    byAgent: [
      {
        id: 'alpha:builder',
        label: 'builder',
        teamName: 'alpha',
        agentName: 'builder',
        summary: {
          ...ZERO_SUMMARY,
          totalTokens: 300,
          requestCount: 2,
          estimatedCostUsd: 1.25,
          apiEquivalentCostUsd: 1.25,
        },
        lastActivityAt: '2026-06-30T00:00:00.000Z',
      },
    ],
    byProject: [
      {
        id: 'project:workspace-a',
        label: 'workspace-a',
        teamName: 'alpha',
        summary: {
          ...ZERO_SUMMARY,
          totalTokens: 300,
          requestCount: 2,
          estimatedCostUsd: 1.25,
          apiEquivalentCostUsd: 1.25,
        },
        lastActivityAt: '2026-06-30T00:00:00.000Z',
      },
    ],
    byCommand: [
      {
        id: 'cmd-a',
        label: 'Command A',
        summary: {
          ...ZERO_SUMMARY,
          totalTokens: 200,
          requestCount: 1,
          estimatedCostUsd: 0.75,
          apiEquivalentCostUsd: 0.75,
        },
        lastActivityAt: '2026-06-30T00:00:00.000Z',
      },
      {
        id: 'cmd-b',
        label: 'Command B',
        summary: {
          ...ZERO_SUMMARY,
          totalTokens: 100,
          requestCount: 1,
          estimatedCostUsd: 0.5,
          apiEquivalentCostUsd: 0.5,
        },
        lastActivityAt: '2026-06-30T00:00:00.000Z',
      },
    ],
    bySession: [],
    byRuntime: [
      {
        id: 'codex',
        label: 'codex',
        summary: {
          ...ZERO_SUMMARY,
          totalTokens: 300,
          requestCount: 2,
          estimatedCostUsd: 1.25,
          apiEquivalentCostUsd: 1.25,
        },
        lastActivityAt: '2026-06-30T00:00:00.000Z',
      },
    ],
    byModel: [
      {
        id: 'gpt-5.4',
        label: 'gpt-5.4',
        summary: {
          ...ZERO_SUMMARY,
          totalTokens: 200,
          requestCount: 1,
          estimatedCostUsd: 0.75,
          apiEquivalentCostUsd: 0.75,
        },
        lastActivityAt: '2026-06-30T00:00:00.000Z',
      },
      {
        id: 'claude-sonnet',
        label: 'claude-sonnet',
        summary: {
          ...ZERO_SUMMARY,
          totalTokens: 100,
          requestCount: 1,
          estimatedCostUsd: 0.5,
          apiEquivalentCostUsd: 0.5,
        },
        lastActivityAt: '2026-06-29T00:00:00.000Z',
      },
      {
        id: 'unused-model',
        label: 'unused-model',
        summary: { ...ZERO_SUMMARY },
        lastActivityAt: '2026-06-28T00:00:00.000Z',
      },
    ],
    commandRuns: [],
    sessionRuns: [],
    tokenTrend: [
      {
        id: '2026-06-29',
        label: '06-29',
        startedAt: '2026-06-29T00:00:00.000Z',
        endedAt: '2026-06-29T23:59:59.999Z',
        summary: {
          ...ZERO_SUMMARY,
          totalTokens: 100,
          inputTokens: 50,
          outputTokens: 25,
          cacheReadTokens: 25,
          estimatedCostUsd: 0.4,
          apiEquivalentCostUsd: 0.4,
        },
      },
      {
        id: '2026-06-30',
        label: '06-30',
        startedAt: '2026-06-30T00:00:00.000Z',
        endedAt: '2026-06-30T23:59:59.999Z',
        summary: {
          ...ZERO_SUMMARY,
          totalTokens: 300,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 150,
          estimatedCostUsd: 1.25,
          apiEquivalentCostUsd: 1.25,
        },
      },
    ],
    usageHeatmap: [
      {
        id: '2026-06-29',
        label: '06-29',
        startedAt: '2026-06-29T00:00:00.000Z',
        endedAt: '2026-06-29T23:59:59.999Z',
        summary: {
          ...ZERO_SUMMARY,
          totalTokens: 100,
          inputTokens: 50,
          outputTokens: 25,
          cacheReadTokens: 25,
          estimatedCostUsd: 0.4,
          apiEquivalentCostUsd: 0.4,
        },
      },
      {
        id: '2026-06-30',
        label: '06-30',
        startedAt: '2026-06-30T00:00:00.000Z',
        endedAt: '2026-06-30T23:59:59.999Z',
        summary: {
          ...ZERO_SUMMARY,
          totalTokens: 300,
          inputTokens: 100,
          outputTokens: 50,
          cacheReadTokens: 150,
          estimatedCostUsd: 1.25,
          apiEquivalentCostUsd: 1.25,
        },
      },
    ],
    recentRuns: [],
    expensiveRuns: [],
    unmappedEventCount: 3,
    sourceCounts: {
      sdk_exact: 0,
      gateway_exact: 0,
      log_parsed: 2,
      tokenizer_estimated: 0,
      cost_estimated: 0,
    },
  };
}

describe('toTokenUsageDashboardViewModel', () => {
  it('builds numeric chart models without parsing formatted labels', () => {
    const viewModel = toTokenUsageDashboardViewModel(snapshot());

    expect(viewModel.trendPoints.map((point) => point.heightPercent)).toEqual([
      expect.any(Number),
      100,
    ]);
    expect(viewModel.trendPoints[1]).toEqual(
      expect.objectContaining({
        segments: expect.arrayContaining([
          expect.objectContaining({
            id: 'input',
            percent: expect.any(Number),
          }),
          expect.objectContaining({
            id: 'output',
            percent: expect.any(Number),
          }),
          expect.objectContaining({
            id: 'cache',
            percent: 50,
          }),
        ]),
      })
    );
    expect(viewModel.commandSpendBars.map((item) => item.percent)).toEqual([100, 50]);
    expect(viewModel.metrics.find((metric) => metric.id === 'billing')).toEqual(
      expect.objectContaining({
        label: 'Billing',
        value: '$0.00',
        detail: '0 billable API requests',
        help: expect.stringContaining('billingMode=subscription'),
        rows: expect.arrayContaining([
          expect.objectContaining({
            label: 'Subscription usage',
            value: '300',
            detail: '2 req',
          }),
          expect.objectContaining({
            label: 'API-equivalent',
            detail: '2 / 2 est. req',
          }),
        ]),
      })
    );
    expect(viewModel.metrics.find((metric) => metric.id === 'billing')?.rows).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Legacy unclassified' })])
    );
    expect(viewModel.runtimeBars[0]?.percent).toBe(100);
    expect(viewModel.teamFilterOptions.map((option) => option.id)).toEqual(['alpha']);
    expect(viewModel.agentRows[0]).toEqual(
      expect.objectContaining({ teamName: 'alpha', agentName: 'builder' })
    );
    expect(viewModel.modelUsage.map((segment) => segment.id)).toEqual(['gpt-5.4', 'claude-sonnet']);
    expect(viewModel.modelUsage.map((segment) => Math.round(segment.percent))).toEqual([67, 33]);
    expect(viewModel.modelBars.map((item) => ({ id: item.id, percent: item.percent }))).toEqual([
      { id: 'gpt-5.4', percent: 100 },
      { id: 'claude-sonnet', percent: 50 },
      { id: 'unused-model', percent: 0 },
    ]);
    expect(viewModel.activityDays.map((day) => day.intensity)).toEqual([2, 4]);
    expect(viewModel.sourceQuality.find((item) => item.label === 'Log parsed')?.percent).toBe(100);
    expect(viewModel.unmappedEventCount).toBe(3);
  });

  it('excludes cache tokens from headline and trend points when disabled', () => {
    const viewModel = toTokenUsageDashboardViewModel(snapshot(), { includeCacheTokens: false });

    expect(viewModel.metrics.find((metric) => metric.id === 'tokens')?.value).toBe('150');
    expect(viewModel.trendPoints[1]).toEqual(
      expect.objectContaining({
        tokenValue: 150,
        tokens: '150',
        segments: [
          expect.objectContaining({ id: 'input', tokenValue: 100 }),
          expect.objectContaining({ id: 'output', tokenValue: 50 }),
        ],
      })
    );
  });

  it('builds billing split, burn rate, and budget alerts', () => {
    const viewModel = toTokenUsageDashboardViewModel(snapshot(), {
      budgetLimits: {
        global: { monthlyTokenLimit: 500 },
        projects: { 'project:workspace-a': { monthlyTokenLimit: 100 } },
        teams: { alpha: { monthlyTokenLimit: 250 } },
      },
      locale: 'en-US',
    });

    expect(viewModel.billingSplit.map((item) => item.id)).toEqual([
      'api-billable',
      'subscription',
      'api-equivalent',
    ]);
    expect(viewModel.billingSplit.find((item) => item.id === 'subscription')).toEqual(
      expect.objectContaining({
        value: '300',
        detail: '2 req',
        percent: 100,
      })
    );
    expect(viewModel.burnRate).toEqual(
      expect.objectContaining({
        dailyTokens: '200',
        monthForecastTokens: '600',
        weekForecastTokens: '1.6K',
      })
    );
    expect(viewModel.budgetAlerts.map((alert) => alert.id)).toEqual([
      'project:workspace-a',
      'alpha',
      'global',
    ]);
    expect(viewModel.budgetAlerts[0]).toEqual(
      expect.objectContaining({
        id: 'project:workspace-a',
        scope: 'project',
        severity: 'critical',
        percent: 300,
      })
    );
    expect(viewModel.budgetAlerts[1]).toEqual(
      expect.objectContaining({
        id: 'alpha',
        severity: 'critical',
        percent: 120,
      })
    );
    expect(viewModel.budgetAlerts[2]).toEqual(
      expect.objectContaining({
        id: 'global',
        severity: 'ok',
        percent: 60,
      })
    );
    expect(viewModel.budgetTargetOptions.map((option) => `${option.scope}:${option.id}`)).toEqual([
      'global:global',
      'team:alpha',
      'project:project:workspace-a',
    ]);
  });

  it('keeps unclassified billing data out of user-facing billing panels', () => {
    const data = snapshot();
    data.summary.unknownBillingRequestCount = 300;
    data.summary.unknownBillingTokens = 67_300_000;

    const viewModel = toTokenUsageDashboardViewModel(data);
    const billingMetric = viewModel.metrics.find((metric) => metric.id === 'billing');

    expect(viewModel.billingSplit.map((item) => item.id)).not.toContain('legacy');
    expect(billingMetric?.rows).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ label: 'Legacy unclassified' })])
    );
  });
});
