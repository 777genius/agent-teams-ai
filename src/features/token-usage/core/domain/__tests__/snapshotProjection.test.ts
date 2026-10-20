import { describe, expect, it } from 'vitest';

import { buildTokenUsageSnapshot } from '../snapshotProjection';
import { normalizeCostBreakdown, normalizeRequestCount } from '../tokenUsageTotals';

import type { TokenUsageEventDto, TokenUsageRunDto } from '../../../contracts';

const NOW = '2026-06-30T00:05:00.000Z';

function run(overrides: Partial<TokenUsageRunDto> = {}): TokenUsageRunDto {
  return {
    appRunId: 'run-1',
    teamName: 'alpha',
    agentId: 'alpha:builder',
    agentName: 'builder',
    runtimeKind: 'anthropic',
    providerId: 'anthropic',
    model: 'claude-sonnet',
    commandId: 'launch-team',
    commandInvocationId: 'launch-team-invocation-1',
    startedAt: '2026-06-30T00:00:00.000Z',
    status: 'running',
    source: 'team_launch_state',
    sources: [
      {
        id: 'source-1',
        appRunId: 'run-1',
        sourceType: 'cli_log',
        nativeSessionId: 'native-session-1',
        discoveredAt: '2026-06-30T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function event(overrides: Partial<TokenUsageEventDto> = {}): TokenUsageEventDto {
  return {
    id: 'event-1',
    appRunId: 'run-1',
    teamName: 'alpha',
    agentId: 'alpha:builder',
    agentName: 'builder',
    runtimeKind: 'anthropic',
    providerId: 'anthropic',
    model: 'claude-sonnet',
    commandId: 'launch-team',
    commandInvocationId: 'launch-team-invocation-1',
    nativeSessionId: 'native-session-1',
    tokens: {
      inputTokens: 40,
      outputTokens: 60,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      audioTokens: 0,
      imageTokens: 0,
      totalTokens: 100,
    },
    cost: {
      estimatedUsd: 0.12,
      billableUsd: 0,
      apiEquivalentUsd: 0.12,
      source: 'pricing_table',
      billingMode: 'subscription',
    },
    billingMode: 'subscription',
    usageSourceKind: 'log_parsed',
    occurredAt: '2026-06-30T00:01:00.000Z',
    createdAt: '2026-06-30T00:02:00.000Z',
    ...overrides,
  };
}

describe('buildTokenUsageSnapshot', () => {
  it('aggregates only mapped app runs and reports unmapped events', () => {
    const snapshot = buildTokenUsageSnapshot({
      runs: [run({ billingMode: 'subscription' })],
      events: [
        event(),
        event({
          id: 'orphan',
          appRunId: 'external-session',
          tokens: {
            inputTokens: 900,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            reasoningTokens: 0,
            audioTokens: 0,
            imageTokens: 0,
            totalTokens: 900,
          },
        }),
      ],
      nowIso: NOW,
    });

    expect(snapshot.summary.runCount).toBe(1);
    expect(snapshot.summary.runningRunCount).toBe(1);
    expect(snapshot.summary.totalTokens).toBe(100);
    expect(snapshot.summary.estimatedCostUsd).toBe(0.12);
    expect(snapshot.summary.apiEquivalentCostUsd).toBe(0.12);
    expect(snapshot.summary.billableCostUsd).toBe(0);
    expect(snapshot.summary.subscriptionTokens).toBe(100);
    expect(snapshot.summary.subscriptionRequestCount).toBe(1);
    expect(snapshot.unmappedEventCount).toBe(1);
    expect(snapshot.sourceCounts.log_parsed).toBe(1);
    expect(snapshot.byTeam).toEqual([
      expect.objectContaining({
        id: 'team:alpha',
        teamName: 'alpha',
        summary: expect.objectContaining({ totalTokens: 100 }),
      }),
    ]);
    expect(snapshot.byAgent[0]).toEqual(
      expect.objectContaining({
        id: 'alpha:builder',
        teamName: 'alpha',
        agentName: 'builder',
      })
    );
    expect(snapshot.byCommand).toEqual([
      expect.objectContaining({
        id: 'launch-team',
        summary: expect.objectContaining({ runCount: 1, totalTokens: 100 }),
      }),
    ]);
    expect(snapshot.bySession).toEqual([
      expect.objectContaining({
        id: 'native-session-1',
        summary: expect.objectContaining({ runCount: 1, totalTokens: 100 }),
      }),
    ]);
    expect(snapshot.tokenTrend).toEqual([
      expect.objectContaining({
        id: '2026-06-30',
        label: '06-30',
        summary: expect.objectContaining({ totalTokens: 100 }),
      }),
    ]);
    expect(snapshot.usageHeatmap.find((point) => point.id === '2026-06-30')).toEqual(
      expect.objectContaining({
        id: '2026-06-30',
        summary: expect.objectContaining({ totalTokens: 100 }),
      })
    );
    expect(snapshot.commandRuns[0]).toEqual(
      expect.objectContaining({
        id: 'launch-team-invocation-1',
        commandId: 'launch-team',
        commandInvocationId: 'launch-team-invocation-1',
        durationMs: 300000,
        status: 'running',
        summary: expect.objectContaining({ totalTokens: 100 }),
      })
    );
    expect(snapshot.sessionRuns[0]).toEqual(
      expect.objectContaining({
        id: 'native-session-1',
        nativeSessionId: 'native-session-1',
        billingMode: 'subscription',
        durationMs: 300000,
        summary: expect.objectContaining({ totalTokens: 100 }),
      })
    );
    expect(snapshot.recentRuns[0]).toEqual(
      expect.objectContaining({
        appRunId: 'run-1',
        billingMode: 'subscription',
      })
    );
  });

  it('separates actual API billed cost from API-equivalent subscription estimates', () => {
    const snapshot = buildTokenUsageSnapshot({
      runs: [
        run({ appRunId: 'api-run', billingMode: 'api' }),
        run({ appRunId: 'subscription-run', billingMode: 'subscription' }),
      ],
      events: [
        event({
          id: 'api-event',
          appRunId: 'api-run',
          billingMode: 'api',
          cost: {
            estimatedUsd: 0.8,
            billableUsd: 0.8,
            apiEquivalentUsd: 0.8,
            source: 'provider',
            billingMode: 'api',
          },
        }),
        event({
          id: 'subscription-event',
          appRunId: 'subscription-run',
          billingMode: 'subscription',
          cost: {
            estimatedUsd: 0.12,
            billableUsd: 0,
            apiEquivalentUsd: 0.12,
            source: 'pricing_table',
            billingMode: 'subscription',
          },
        }),
      ],
      nowIso: NOW,
    });

    expect(snapshot.summary.billableCostUsd).toBe(0.8);
    expect(snapshot.summary.apiEquivalentCostUsd).toBe(0.92);
    expect(snapshot.summary.apiBillingTokens).toBe(100);
    expect(snapshot.summary.subscriptionTokens).toBe(100);
    expect(snapshot.summary.apiBillingRequestCount).toBe(1);
    expect(snapshot.summary.subscriptionRequestCount).toBe(1);
    expect(snapshot.recentRuns.find((run) => run.appRunId === 'api-run')?.billingMode).toBe('api');
    expect(
      snapshot.recentRuns.find((run) => run.appRunId === 'subscription-run')?.billingMode
    ).toBe('subscription');
  });

  it('aggregates exact Kiro credits and keeps the latest turn value separately', () => {
    const snapshot = buildTokenUsageSnapshot({
      runs: [run({ runtimeKind: 'opencode', providerId: 'opencode', model: 'kiro/auto' })],
      events: [
        event({
          id: 'kiro-event-1',
          runtimeKind: 'opencode',
          providerId: 'opencode',
          model: 'kiro/auto',
          providerUsage: { kiro: { credits: 0.03, creditsUnit: 'credit' } },
          occurredAt: '2026-06-30T00:01:00.000Z',
        }),
        event({
          id: 'kiro-event-2',
          runtimeKind: 'opencode',
          providerId: 'opencode',
          model: 'kiro/auto',
          providerUsage: { kiro: { credits: 0.08, creditsUnit: 'credit' } },
          occurredAt: '2026-06-30T00:02:00.000Z',
        }),
      ],
      nowIso: NOW,
    });

    expect(snapshot.summary).toEqual(
      expect.objectContaining({
        kiroCredits: 0.11,
        kiroCreditEventCount: 2,
        lastKiroCredits: 0.08,
        lastKiroCreditsAt: '2026-06-30T00:02:00.000Z',
        kiroCreditsUnit: 'credit',
      })
    );
    expect(snapshot.byAgent[0]?.summary.kiroCredits).toBe(0.11);
    expect(snapshot.byTeam[0]?.summary.lastKiroCredits).toBe(0.08);
  });

  it('filters by team before aggregating agent/runtime/model breakdowns', () => {
    const snapshot = buildTokenUsageSnapshot({
      runs: [
        run(),
        run({
          appRunId: 'run-2',
          teamName: 'beta',
          agentId: 'beta:reviewer',
          agentName: 'reviewer',
          runtimeKind: 'codex',
          providerId: 'codex',
          model: 'gpt-5.4',
        }),
      ],
      events: [
        event(),
        event({
          id: 'event-2',
          appRunId: 'run-2',
          teamName: 'beta',
          agentId: 'beta:reviewer',
          agentName: 'reviewer',
          runtimeKind: 'codex',
          providerId: 'codex',
          model: 'gpt-5.4',
        }),
      ],
      request: { teamName: 'beta' },
      nowIso: NOW,
    });

    expect(snapshot.summary.runCount).toBe(1);
    expect(snapshot.byTeam.map((item) => item.id)).toEqual(['team:beta']);
    expect(snapshot.byAgent.map((item) => item.id)).toEqual(['beta:reviewer']);
    expect(snapshot.byRuntime.map((item) => item.id)).toEqual(['codex']);
    expect(snapshot.byModel.map((item) => item.id)).toEqual(['gpt-5.4']);
  });

  it('attributes events to the owner-matched task work interval', () => {
    const snapshot = buildTokenUsageSnapshot({
      runs: [run()],
      events: [
        event({
          id: 'builder-event',
          occurredAt: '2026-06-30T00:03:00.000Z',
          tokens: {
            inputTokens: 120,
            outputTokens: 80,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            reasoningTokens: 0,
            audioTokens: 0,
            imageTokens: 0,
            totalTokens: 200,
          },
          cost: {
            estimatedUsd: 0.24,
            billableUsd: 0,
            apiEquivalentUsd: 0.24,
            source: 'pricing_table',
            billingMode: 'subscription',
          },
        }),
        event({
          id: 'reviewer-event',
          agentId: 'alpha:reviewer',
          agentName: 'reviewer',
          occurredAt: '2026-06-30T00:04:00.000Z',
        }),
        event({
          id: 'outside-task-interval',
          occurredAt: '2026-06-30T00:20:00.000Z',
        }),
      ],
      tasks: [
        {
          id: '1',
          displayId: 'AT-1',
          teamName: 'alpha',
          owner: 'reviewer',
          subject: 'Review task',
          status: 'in_progress',
          workIntervals: [
            {
              startedAt: '2026-06-30T00:00:00.000Z',
              completedAt: '2026-06-30T00:10:00.000Z',
            },
          ],
        },
        {
          id: '2',
          displayId: 'AT-2',
          teamName: 'alpha',
          owner: 'builder',
          subject: 'Build task',
          status: 'in_progress',
          workIntervals: [
            {
              startedAt: '2026-06-30T00:02:00.000Z',
              completedAt: '2026-06-30T00:08:00.000Z',
            },
          ],
        },
      ],
      nowIso: NOW,
    });

    expect(snapshot.byTask).toEqual([
      expect.objectContaining({
        id: 'task:alpha:2',
        taskId: '2',
        displayId: 'AT-2',
        label: 'AT-2 Build task',
        teamName: 'alpha',
        agentName: 'builder',
        summary: expect.objectContaining({ requestCount: 1, totalTokens: 200 }),
      }),
      expect.objectContaining({
        id: 'task:alpha:1',
        taskId: '1',
        label: 'AT-1 Review task',
        agentName: 'reviewer',
        summary: expect.objectContaining({ requestCount: 1, totalTokens: 100 }),
      }),
    ]);
  });

  it('sorts model breakdowns by token usage before cost', () => {
    const snapshot = buildTokenUsageSnapshot({
      runs: [
        run({ appRunId: 'expensive-small', model: 'opus' }),
        run({ appRunId: 'large-unknown-cost', model: 'gpt-5.5' }),
      ],
      events: [
        event({
          id: 'expensive-small-event',
          appRunId: 'expensive-small',
          model: 'opus',
          tokens: {
            inputTokens: 40,
            outputTokens: 60,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            reasoningTokens: 0,
            audioTokens: 0,
            imageTokens: 0,
            totalTokens: 100,
          },
          cost: {
            estimatedUsd: 5,
            billableUsd: 0,
            apiEquivalentUsd: 5,
            source: 'pricing_table',
            billingMode: 'subscription',
          },
        }),
        event({
          id: 'large-unknown-cost-event',
          appRunId: 'large-unknown-cost',
          model: 'gpt-5.5',
          tokens: {
            inputTokens: 600,
            outputTokens: 400,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            reasoningTokens: 0,
            audioTokens: 0,
            imageTokens: 0,
            totalTokens: 1000,
          },
          cost: {
            estimatedUsd: 0,
            billableUsd: 0,
            apiEquivalentUsd: 0,
            source: 'unknown',
            billingMode: 'subscription',
          },
        }),
      ],
      nowIso: NOW,
    });

    expect(snapshot.byModel.map((item) => item.id)).toEqual(['gpt-5.5', 'opus']);
  });

  it('groups model usage by the concrete usage event model when run config stores an alias', () => {
    const snapshot = buildTokenUsageSnapshot({
      runs: [run({ model: 'sonnet' })],
      events: [event({ model: 'claude-sonnet-4-6' })],
      nowIso: NOW,
    });

    expect(snapshot.byModel).toHaveLength(1);
    expect(snapshot.byModel[0]).toEqual(
      expect.objectContaining({
        id: 'claude-sonnet-4-6',
        label: 'claude-sonnet-4-6',
        summary: expect.objectContaining({
          requestCount: 1,
          totalTokens: 100,
        }),
      })
    );
    expect(snapshot.commandRuns[0]?.models).toEqual(['claude-sonnet-4-6']);
    expect(snapshot.recentRuns[0]?.model).toBe('claude-sonnet-4-6');
    expect(snapshot.sessionRuns[0]?.model).toBe('claude-sonnet-4-6');
  });

  it('enriches stale synthetic events with the current run model pricing', () => {
    const snapshot = buildTokenUsageSnapshot({
      runs: [run({ model: 'gpt-5.4-mini', runtimeKind: 'codex', providerId: 'codex' })],
      events: [
        event({
          model: undefined,
          cost: {
            estimatedUsd: 0,
            billableUsd: 0,
            apiEquivalentUsd: 0,
            source: 'pricing_table',
            billingMode: 'subscription',
          },
          rawUsageJson: {
            sourceName: 'tokscale',
            record: { model: '<synthetic>', cost: 0 },
          },
        }),
      ],
      nowIso: NOW,
    });

    expect(snapshot.byModel[0]).toEqual(
      expect.objectContaining({
        id: 'gpt-5.4-mini',
        summary: expect.objectContaining({
          costKnownEventCount: 1,
          estimatedCostUsd: expect.any(Number),
        }),
      })
    );
    expect(snapshot.byModel[0]?.summary.estimatedCostUsd).toBeGreaterThan(0);
  });

  it('ignores stale unmodeled events when a modeled event exists for the same source session', () => {
    const snapshot = buildTokenUsageSnapshot({
      runs: [run({ model: 'gpt-5.5' })],
      events: [
        event({
          id: 'stale-synthetic',
          model: undefined,
          rawUsageJson: {
            sourceName: 'tokscale',
            record: { model: '<synthetic>' },
          },
        }),
        event({
          id: 'modeled-refresh',
          model: 'gpt-5.5',
          tokens: {
            inputTokens: 20,
            outputTokens: 30,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            reasoningTokens: 0,
            audioTokens: 0,
            imageTokens: 0,
            totalTokens: 50,
          },
          rawUsageJson: {
            sourceName: 'tokscale',
            record: { model: 'gpt-5.5' },
          },
        }),
      ],
      nowIso: NOW,
    });

    expect(snapshot.summary.totalTokens).toBe(50);
    expect(snapshot.byModel).toEqual([
      expect.objectContaining({
        id: 'gpt-5.5',
        summary: expect.objectContaining({ totalTokens: 50 }),
      }),
    ]);
  });

  it('filters by multiple selected teams', () => {
    const snapshot = buildTokenUsageSnapshot({
      runs: [
        run(),
        run({
          appRunId: 'run-2',
          teamName: 'beta',
          agentId: 'beta:reviewer',
          sources: [
            {
              id: 'source-2',
              appRunId: 'run-2',
              sourceType: 'cli_log',
              nativeSessionId: 'native-session-2',
              discoveredAt: '2026-06-30T00:00:00.000Z',
            },
          ],
        }),
        run({
          appRunId: 'run-3',
          teamName: 'gamma',
          agentId: 'gamma:builder',
          sources: [
            {
              id: 'source-3',
              appRunId: 'run-3',
              sourceType: 'cli_log',
              nativeSessionId: 'native-session-3',
              discoveredAt: '2026-06-30T00:00:00.000Z',
            },
          ],
        }),
      ],
      events: [
        event(),
        event({ id: 'event-2', appRunId: 'run-2', teamName: 'beta', agentId: 'beta:reviewer' }),
        event({ id: 'event-3', appRunId: 'run-3', teamName: 'gamma', agentId: 'gamma:builder' }),
      ],
      request: { teamNames: ['alpha', 'gamma'] },
      nowIso: NOW,
    });

    expect(snapshot.summary.runCount).toBe(2);
    expect(snapshot.summary.totalTokens).toBe(200);
    expect(snapshot.byTeam.map((item) => item.id)).toEqual(['team:alpha', 'team:gamma']);
  });

  it('filters by command invocation and native session while keeping overlapping runs', () => {
    const snapshot = buildTokenUsageSnapshot({
      runs: [
        run({
          endedAt: '2026-06-30T00:10:00.000Z',
          status: 'completed',
        }),
        run({
          appRunId: 'run-2',
          agentId: 'alpha:reviewer',
          agentName: 'reviewer',
          commandInvocationId: 'launch-team-invocation-2',
          sources: [
            {
              id: 'source-2',
              appRunId: 'run-2',
              sourceType: 'cli_log',
              nativeSessionId: 'native-session-2',
              discoveredAt: '2026-06-30T00:00:00.000Z',
            },
          ],
        }),
      ],
      events: [
        event({
          occurredAt: '2026-06-30T00:06:00.000Z',
        }),
        event({
          id: 'event-2',
          appRunId: 'run-2',
          agentId: 'alpha:reviewer',
          agentName: 'reviewer',
          commandInvocationId: 'launch-team-invocation-2',
          nativeSessionId: 'native-session-2',
          occurredAt: '2026-06-30T00:06:00.000Z',
        }),
      ],
      request: {
        commandInvocationId: 'launch-team-invocation-1',
        nativeSessionId: 'native-session-1',
        from: '2026-06-30T00:05:00.000Z',
        to: '2026-06-30T00:07:00.000Z',
      },
      nowIso: NOW,
    });

    expect(snapshot.summary.runCount).toBe(1);
    expect(snapshot.summary.totalTokens).toBe(100);
    expect(snapshot.commandRuns).toHaveLength(1);
    expect(snapshot.commandRuns[0]?.id).toBe('launch-team-invocation-1');
    expect(snapshot.sessionRuns.map((item) => item.nativeSessionId)).toEqual(['native-session-1']);
  });

  it('builds a sorted bounded token trend after applying filters', () => {
    const olderRun = run({
      appRunId: 'older-run',
      startedAt: '2026-06-28T00:00:00.000Z',
      sources: [
        {
          id: 'older-source',
          appRunId: 'older-run',
          sourceType: 'cli_log',
          nativeSessionId: 'older-session',
          discoveredAt: '2026-06-28T00:00:00.000Z',
        },
      ],
    });
    const currentRun = run();
    const filteredOutRun = run({
      appRunId: 'filtered-out',
      teamName: 'beta',
      agentId: 'beta:builder',
      sources: [
        {
          id: 'filtered-out-source',
          appRunId: 'filtered-out',
          sourceType: 'cli_log',
          nativeSessionId: 'filtered-out-session',
          discoveredAt: '2026-06-30T00:00:00.000Z',
        },
      ],
    });

    const snapshot = buildTokenUsageSnapshot({
      runs: [filteredOutRun, currentRun, olderRun],
      events: [
        event({
          id: 'older-event',
          appRunId: 'older-run',
          nativeSessionId: 'older-session',
          occurredAt: '2026-06-28T00:01:00.000Z',
          tokens: {
            inputTokens: 10,
            outputTokens: 20,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            reasoningTokens: 0,
            audioTokens: 0,
            imageTokens: 0,
            totalTokens: 30,
          },
        }),
        event(),
        event({
          id: 'filtered-out-event',
          appRunId: 'filtered-out',
          teamName: 'beta',
          agentId: 'beta:builder',
          nativeSessionId: 'filtered-out-session',
          occurredAt: '2026-06-30T00:01:00.000Z',
        }),
      ],
      request: { teamName: 'alpha' },
      nowIso: NOW,
    });

    expect(snapshot.tokenTrend.map((point) => point.id)).toEqual(['2026-06-28', '2026-06-30']);
    expect(snapshot.tokenTrend.map((point) => point.summary.totalTokens)).toEqual([30, 100]);
    expect(snapshot.summary.totalTokens).toBe(130);
  });

  it('builds daily heatmap buckets for the selected date range', () => {
    const olderRun = run({
      appRunId: 'older-run',
      startedAt: '2026-06-28T00:00:00.000Z',
      sources: [
        {
          id: 'older-source',
          appRunId: 'older-run',
          sourceType: 'cli_log',
          nativeSessionId: 'older-session',
          discoveredAt: '2026-06-28T00:00:00.000Z',
        },
      ],
    });

    const snapshot = buildTokenUsageSnapshot({
      runs: [olderRun, run()],
      events: [
        event({
          id: 'older-event',
          appRunId: 'older-run',
          nativeSessionId: 'older-session',
          occurredAt: '2026-06-28T00:01:00.000Z',
          tokens: {
            inputTokens: 10,
            outputTokens: 20,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            reasoningTokens: 0,
            audioTokens: 0,
            imageTokens: 0,
            totalTokens: 30,
          },
        }),
        event(),
      ],
      request: {
        from: '2026-06-28T00:00:00.000Z',
        to: '2026-06-30T23:59:59.999Z',
      },
      nowIso: NOW,
    });

    expect(snapshot.usageHeatmap.map((point) => point.id)).toEqual([
      '2026-06-28',
      '2026-06-29',
      '2026-06-30',
    ]);
    expect(snapshot.usageHeatmap.map((point) => point.summary.totalTokens)).toEqual([30, 0, 100]);
  });
  // Missing run metadata must never turn an orphan event into anonymous usage.
  it('canonical anonymous filter excludes unmatched events and overrides raw names', () => {
    const snapshot = buildTokenUsageSnapshot({
      runs: [run({ appRunId: 'anonymous', teamName: undefined })],
      events: [
        event({ appRunId: 'anonymous', teamName: undefined }),
        event({ id: 'orphan', appRunId: 'missing', teamName: undefined }),
      ],
      request: { teamIds: ['anonymous'], teamName: 'alpha' },
      nowIso: NOW,
    });
    expect(snapshot.summary.totalTokens).toBe(event().tokens.totalTokens);
    expect(snapshot.summary.requestCount).toBe(1);
    expect(snapshot.byTeam.map((row) => row.id)).toEqual(['anonymous']);
    expect(snapshot.unmappedEventCount).toBe(0);
    expect(() =>
      buildTokenUsageSnapshot({ runs: [], events: [], request: { teamIds: [''] }, nowIso: NOW })
    ).toThrow('canonical team filter');
  });
});

describe('buildTokenUsageSnapshot gateway aggregates', () => {
  function gatewayEvent(overrides: Partial<TokenUsageEventDto> = {}): TokenUsageEventDto {
    return event({
      id: 'gateway-day',
      appRunId: 'gateway:gateway-ref-1:2026-06-30',
      teamName: 'alpha',
      agentId: 'alpha:builder',
      agentName: 'builder',
      runtimeKind: 'unknown',
      providerId: undefined,
      billingMode: 'api',
      model: 'claude-sonnet',
      commandId: undefined,
      commandInvocationId: undefined,
      nativeSessionId: undefined,
      usageSourceKind: 'gateway_exact',
      gatewayUsageRef: 'gateway-ref-1',
      gatewayDay: '2026-06-30',
      requestCount: 25,
      cost: {
        estimatedUsd: 0.5,
        billableUsd: 0,
        apiEquivalentUsd: 0.5,
        source: 'gateway',
        billingMode: 'api',
      },
      occurredAt: '2026-06-30T00:00:00.000Z',
      createdAt: '2026-06-30T00:02:00.000Z',
      ...overrides,
    });
  }

  it('includes run-less gateway aggregates in totals, team/agent/runtime/model and sourceCounts', () => {
    const snapshot = buildTokenUsageSnapshot({
      runs: [],
      events: [gatewayEvent()],
      nowIso: NOW,
    });

    expect(snapshot.summary).toEqual(
      expect.objectContaining({
        runCount: 0,
        totalTokens: 100,
        requestCount: 25,
        apiEquivalentCostUsd: 0.5,
        exactEventCount: 1,
        estimatedEventCount: 0,
      })
    );
    expect(snapshot.sourceCounts).toEqual({
      sdk_exact: 0,
      gateway_exact: 1,
      log_parsed: 0,
      tokenizer_estimated: 0,
      cost_estimated: 0,
    });
    expect(snapshot.byTeam).toEqual([
      expect.objectContaining({
        id: 'team:alpha',
        teamName: 'alpha',
        summary: expect.objectContaining({ totalTokens: 100, requestCount: 25 }),
      }),
    ]);
    expect(snapshot.byAgent).toEqual([
      expect.objectContaining({ id: 'alpha:builder', agentName: 'builder' }),
    ]);
    expect(snapshot.byRuntime).toEqual([expect.objectContaining({ id: 'unknown' })]);
    expect(snapshot.byModel).toEqual([
      expect.objectContaining({
        id: 'claude-sonnet',
        summary: expect.objectContaining({ totalTokens: 100 }),
      }),
    ]);
    expect(snapshot.unmappedEventCount).toBe(0);
  });

  it('excludes gateway day totals from task, project, session, command and run lists', () => {
    const snapshot = buildTokenUsageSnapshot({
      runs: [run()],
      events: [event(), gatewayEvent()],
      tasks: [
        {
          id: '1',
          displayId: 'AT-1',
          teamName: 'alpha',
          owner: 'builder',
          subject: 'Build task',
          status: 'in_progress',
          workIntervals: [
            {
              startedAt: '2026-06-30T00:00:00.000Z',
              completedAt: '2026-06-30T00:10:00.000Z',
            },
          ],
        },
      ],
      nowIso: NOW,
    });

    expect(snapshot.summary.totalTokens).toBe(200);
    // The gateway day falls inside the owner-matched interval but never funds a task.
    expect(snapshot.byTask).toEqual([
      expect.objectContaining({
        id: 'task:alpha:1',
        summary: expect.objectContaining({ totalTokens: 100 }),
      }),
    ]);
    expect(snapshot.byProject.map((item) => item.summary.totalTokens)).toEqual([100]);
    expect(snapshot.bySession.map((item) => item.summary.totalTokens)).toEqual([100]);
    expect(snapshot.byCommand.map((item) => item.summary.totalTokens)).toEqual([100]);
    expect(snapshot.recentRuns.map((item) => item.appRunId)).toEqual(['run-1']);
    expect(snapshot.recentRuns[0]?.summary.totalTokens).toBe(100);
    expect(snapshot.expensiveRuns.map((item) => item.appRunId)).toEqual(['run-1']);
  });

  it('filters gateway aggregates by their own team name', () => {
    const events = [
      gatewayEvent(),
      gatewayEvent({
        id: 'gateway-day-beta',
        appRunId: 'gateway:gateway-ref-2:2026-06-30',
        teamName: 'beta',
        agentId: 'beta:reviewer',
        agentName: 'reviewer',
        gatewayUsageRef: 'gateway-ref-2',
      }),
    ];

    const alpha = buildTokenUsageSnapshot({
      runs: [],
      events,
      request: { teamName: 'alpha' },
      nowIso: NOW,
    });
    expect(alpha.summary.totalTokens).toBe(100);
    expect(alpha.byTeam.map((item) => item.id)).toEqual(['team:alpha']);

    const beta = buildTokenUsageSnapshot({
      runs: [],
      events,
      request: { teamIds: ['team:beta'] },
      nowIso: NOW,
    });
    expect(beta.summary.totalTokens).toBe(100);
    expect(beta.byTeam.map((item) => item.id)).toEqual(['team:beta']);
  });

  it('keeps ordinary orphans unmapped while gateway aggregates stay attributed', () => {
    const snapshot = buildTokenUsageSnapshot({
      runs: [],
      events: [
        gatewayEvent(),
        event({ id: 'orphan', appRunId: 'missing-run', occurredAt: '2026-06-30T00:01:00.000Z' }),
      ],
      nowIso: NOW,
    });

    expect(snapshot.unmappedEventCount).toBe(1);
    expect(snapshot.summary.totalTokens).toBe(100);
    expect(snapshot.sourceCounts).toEqual({
      sdk_exact: 0,
      gateway_exact: 1,
      log_parsed: 0,
      tokenizer_estimated: 0,
      cost_estimated: 0,
    });
  });

  it('keeps explicit zero billable cost and weights request counts into summary counters', () => {
    expect(
      normalizeCostBreakdown({ estimatedUsd: 0.5, billableUsd: 0, apiEquivalentUsd: 0.5, source: 'gateway' })
    ).toMatchObject({ billableUsd: 0, estimatedUsd: 0.5, apiEquivalentUsd: 0.5 });
    expect(normalizeCostBreakdown({ estimatedUsd: 0.5, source: 'gateway' })).toMatchObject({
      billableUsd: 0.5,
    });
    expect([0, 25, undefined, -3, 2.5, '25'].map((value) => normalizeRequestCount(value))).toEqual([
      0, 25, 1, 1, 1, 1,
    ]);

    const snapshot = buildTokenUsageSnapshot({
      runs: [],
      events: [
        gatewayEvent({ id: 'req-0', model: 'model-zero', requestCount: 0 }),
        gatewayEvent({ id: 'req-25', model: 'model-many', requestCount: 25 }),
        gatewayEvent({ id: 'req-default', model: 'model-default', requestCount: undefined }),
        gatewayEvent({ id: 'req-invalid', model: 'model-invalid', requestCount: -3 }),
      ],
      nowIso: NOW,
    });

    expect(snapshot.summary.requestCount).toBe(27);
    expect(snapshot.summary.apiBillingRequestCount).toBe(27);
    expect(snapshot.summary.billableCostUsd).toBe(0);
    expect(snapshot.summary.apiEquivalentCostUsd).toBe(2);
  });
});
