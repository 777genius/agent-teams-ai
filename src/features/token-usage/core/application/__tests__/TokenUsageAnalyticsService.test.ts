import { describe, expect, it } from 'vitest';

import { TokenUsageAnalyticsService } from '../TokenUsageAnalyticsService';

import type {
  TokenUsageAnalyticsSnapshotDto,
  TokenUsageEventDto,
  TokenUsageRunDto,
} from '../../../contracts';
import type {
  TokenUsageBudgetNotificationEvaluatorPort,
  TokenUsageLedgerRepositoryPort,
} from '../ports';

const NOW = '2026-06-30T00:05:00.000Z';

describe('TokenUsageAnalyticsService', () => {
  it('returns a filtered refresh result but publishes and evaluates the canonical snapshot', async () => {
    const runs = [
      run({ appRunId: 'run-alpha', teamName: 'alpha' }),
      run({ appRunId: 'run-beta', teamName: 'beta' }),
    ];
    const events = [
      event({ id: 'event-alpha', appRunId: 'run-alpha', teamName: 'alpha', totalTokens: 100 }),
      event({ id: 'event-beta', appRunId: 'run-beta', teamName: 'beta', totalTokens: 200 }),
    ];
    const ledger = new MemoryLedgerRepository();
    const published: TokenUsageAnalyticsSnapshotDto[] = [];
    const evaluator = new CapturingBudgetEvaluator();
    const service = new TokenUsageAnalyticsService({
      ledger,
      discovery: { discoverAppRuns: async () => runs },
      importers: [{ importUsage: async () => events }],
      clock: { now: () => new Date(NOW) },
      publisher: { publishSnapshot: (snapshot) => published.push(snapshot) },
      budgetNotifications: evaluator,
      taskAttributionSource: {
        listTaskAttributions: async () => [
          {
            id: '1',
            displayId: 'AT-1',
            teamName: 'alpha',
            owner: 'builder',
            subject: 'Alpha task',
            status: 'in_progress',
            workIntervals: [
              {
                startedAt: '2026-06-30T00:00:00.000Z',
                completedAt: '2026-06-30T00:05:00.000Z',
              },
            ],
          },
          {
            id: '2',
            displayId: 'BT-2',
            teamName: 'beta',
            owner: 'builder',
            subject: 'Beta task',
            status: 'in_progress',
            workIntervals: [
              {
                startedAt: '2026-06-30T00:00:00.000Z',
                completedAt: '2026-06-30T00:05:00.000Z',
              },
            ],
          },
        ],
      },
    });

    const filtered = await service.refreshSnapshot({ teamNames: ['alpha'] });

    expect(filtered.summary.totalTokens).toBe(100);
    expect(filtered.byTask.map((item) => item.id)).toEqual(['task:alpha:1']);
    expect(published[0]?.summary.totalTokens).toBe(300);
    expect(published[0]?.byTask.map((item) => item.id)).toEqual(['task:beta:2', 'task:alpha:1']);
    expect(evaluator.snapshots[0]?.summary.totalTokens).toBe(300);
  });
});

function run(overrides: Partial<TokenUsageRunDto> = {}): TokenUsageRunDto {
  const appRunId = overrides.appRunId ?? 'run-1';
  return {
    appRunId,
    teamName: 'alpha',
    agentId: `${overrides.teamName ?? 'alpha'}:builder`,
    agentName: 'builder',
    runtimeKind: 'anthropic',
    providerId: 'anthropic',
    model: 'claude-sonnet',
    commandId: 'launch-team',
    commandInvocationId: `${appRunId}:command`,
    startedAt: '2026-06-30T00:00:00.000Z',
    status: 'running',
    source: 'team_launch_state',
    sources: [
      {
        id: `${appRunId}:source`,
        appRunId,
        sourceType: 'cli_log',
        nativeSessionId: `${appRunId}:native`,
        discoveredAt: '2026-06-30T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function event(
  overrides: Partial<TokenUsageEventDto> & { totalTokens?: number } = {}
): TokenUsageEventDto {
  const totalTokens = overrides.totalTokens ?? 100;
  const { totalTokens: ignoredTotalTokens, ...eventOverrides } = overrides;
  void ignoredTotalTokens;
  const appRunId = overrides.appRunId ?? 'run-1';
  const teamName = overrides.teamName ?? 'alpha';
  return {
    id: 'event-1',
    appRunId,
    teamName,
    agentId: `${teamName}:builder`,
    agentName: 'builder',
    runtimeKind: 'anthropic',
    providerId: 'anthropic',
    model: 'claude-sonnet',
    commandId: 'launch-team',
    commandInvocationId: `${appRunId}:command`,
    nativeSessionId: `${appRunId}:native`,
    tokens: {
      inputTokens: totalTokens,
      outputTokens: 0,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      audioTokens: 0,
      imageTokens: 0,
      totalTokens,
    },
    cost: {
      estimatedUsd: totalTokens / 1_000,
      billableUsd: 0,
      apiEquivalentUsd: totalTokens / 1_000,
      source: 'pricing_table',
      billingMode: 'subscription',
    },
    billingMode: 'subscription',
    usageSourceKind: 'log_parsed',
    occurredAt: '2026-06-30T00:01:00.000Z',
    createdAt: '2026-06-30T00:02:00.000Z',
    ...eventOverrides,
  };
}

class MemoryLedgerRepository implements TokenUsageLedgerRepositoryPort {
  private runs: TokenUsageRunDto[] = [];
  private events: TokenUsageEventDto[] = [];

  async listRuns(): Promise<TokenUsageRunDto[]> {
    return [...this.runs];
  }

  async listEvents(): Promise<TokenUsageEventDto[]> {
    return [...this.events];
  }

  async upsertRuns(runs: readonly TokenUsageRunDto[]): Promise<void> {
    const byId = new Map(this.runs.map((runItem) => [runItem.appRunId, runItem]));
    for (const runItem of runs) byId.set(runItem.appRunId, runItem);
    this.runs = [...byId.values()];
  }

  async replaceRunsForSource(
    source: TokenUsageRunDto['source'],
    runs: readonly TokenUsageRunDto[]
  ): Promise<void> {
    this.runs = this.runs.filter((runItem) => runItem.source !== source);
    await this.upsertRuns(runs);
  }

  async upsertEvents(events: readonly TokenUsageEventDto[]): Promise<void> {
    const byId = new Map(this.events.map((eventItem) => [eventItem.id, eventItem]));
    for (const eventItem of events) byId.set(eventItem.id, eventItem);
    this.events = [...byId.values()];
  }
}

class CapturingBudgetEvaluator implements TokenUsageBudgetNotificationEvaluatorPort {
  readonly snapshots: TokenUsageAnalyticsSnapshotDto[] = [];

  async evaluate(snapshot: TokenUsageAnalyticsSnapshotDto): Promise<void> {
    this.snapshots.push(snapshot);
  }
}
