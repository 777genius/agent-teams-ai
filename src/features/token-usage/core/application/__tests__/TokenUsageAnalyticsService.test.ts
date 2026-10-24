import { describe, expect, it } from 'vitest';

import { TokenUsageAnalyticsService } from '../TokenUsageAnalyticsService';

import type {
  TokenUsageAnalyticsSnapshotDto,
  TokenUsageBudgetStatusDto,
  TokenUsageEventDto,
  TokenUsageGatewaySourceStateDto,
  TokenUsageRunDto,
} from '../../../contracts';
import type {
  TokenUsageBudgetNotificationEvaluatorPort,
  TokenUsageGatewayUsageSource,
  TokenUsageImportBatch,
  TokenUsageLedgerRepositoryPort,
  TokenUsageLedgerSnapshot,
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
    expect(evaluator.snapshots[0]?.period.key).toBe('2026-06');
  });
  it.each([false, true])(
    'same-month clock rollback refreshes after a future attempt (failed=%s)',
    async (failed) => {
      let now = new Date('2026-06-30T12:00:00.000Z');
      let attempts = 0;
      const ledger = new MemoryLedgerRepository();
      const evaluator = new CapturingBudgetEvaluator();
      const settings = {
        global: { monthlyTokenLimit: 1000, thresholds: [50], notificationsEnabled: true },
      };
      const service = new TokenUsageAnalyticsService({
        ledger,
        discovery: {
          discoverAppRuns: async () => {
            attempts++;
            if (failed && attempts === 1) throw new Error('discovery unavailable');
            return [run()];
          },
        },
        importers: [{ importUsage: async () => [event()] }],
        clock: { now: () => now },
        budgets: {
          getSettings: async () => settings,
          updateSettings: async () => settings,
        },
        budgetNotificationSettings: {
          getSettings: () => ({
            enabled: true,
            nativeToasts: false,
            notifyAtWarning: false,
            notifyAtCritical: false,
          }),
        },
        budgetNotifications: evaluator,
      });
      await service.refreshSnapshot();
      now = new Date('2026-06-30T11:00:00.000Z');
      expect((await service.getBudgetStatus()).stale).toBe(true);
      await service.tick();
      expect(attempts).toBe(2);
      const recovered = await service.getBudgetStatus();
      expect(recovered).toMatchObject({
        stale: false,
        degraded: false,
        usageUpdatedAt: now.toISOString(),
        period: { key: '2026-06' },
      });
      expect(evaluator.snapshots.at(-1)).toMatchObject({ stale: false, degraded: false });
      await service.tick();
      expect(attempts).toBe(2);
    }
  );
  it('orders GET and published budget projections monotonically across clock rollback', async () => {
    let now = new Date('2026-06-30T12:00:00.000Z');
    const published: TokenUsageBudgetStatusDto[] = [];
    const service = new TokenUsageAnalyticsService({
      ledger: new MemoryLedgerRepository(),
      discovery: { discoverAppRuns: async () => [run()] },
      importers: [{ importUsage: async () => [event()] }],
      clock: { now: () => now },
      statusEpoch: 'sandbox-service-epoch',
      publisher: {
        publishSnapshot: () => undefined,
        publishBudgetStatus: (status) => published.push(status),
      },
    });
    const before = await service.getBudgetStatus();
    await service.refreshSnapshot();
    now = new Date('2026-06-30T11:00:00.000Z');
    const after = await service.getBudgetStatus();
    await service.tick();
    expect([before, published[0], after, published[1]].map((status) => status.statusOrder)).toEqual(
      [
        { epoch: 'sandbox-service-epoch', sequence: 1 },
        { epoch: 'sandbox-service-epoch', sequence: 2 },
        { epoch: 'sandbox-service-epoch', sequence: 3 },
        { epoch: 'sandbox-service-epoch', sequence: 4 },
      ]
    );
    expect(Date.parse(after.computedAt)).toBeLessThan(Date.parse(before.computedAt));
    expect(published).toHaveLength(2);
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
  private sourceStates: TokenUsageGatewaySourceStateDto[] = [];

  async readSnapshot(): Promise<TokenUsageLedgerSnapshot> {
    return {
      runs: [...this.runs],
      events: [...this.events],
      sourceStates: [...this.sourceStates],
    };
  }

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

  async commitImportBatch(batch: TokenUsageImportBatch): Promise<void> {
    await this.upsertEvents(batch.events);
    const byRef = new Map(this.sourceStates.map((state) => [state.gatewayUsageRef, state]));
    for (const state of batch.sourceStates ?? []) byRef.set(state.gatewayUsageRef, state);
    this.sourceStates = [...byRef.values()];
  }
}

function gatewaySource(
  overrides: Partial<TokenUsageGatewayUsageSource> = {}
): TokenUsageGatewayUsageSource {
  return {
    gatewayUsageRef: 'ref-1',
    teamName: 'alpha',
    memberName: 'builder',
    agentId: 'alpha:builder',
    firstUsageDay: '2026-06-01',
    lastBoundAt: '2026-06-29T00:00:00.000Z',
    hasActiveBinding: true,
    hasRuntimeArtifact: false,
    ...overrides,
  };
}

function gatewayState(
  overrides: Partial<TokenUsageGatewaySourceStateDto> = {}
): TokenUsageGatewaySourceStateDto {
  return {
    gatewayUsageRef: 'ref-1',
    teamName: 'alpha',
    agentName: 'builder',
    degraded: false,
    lastSuccessfulAt: '2026-06-29T05:00:00.000Z',
    ...overrides,
  };
}

describe('TokenUsageAnalyticsService gateway health', () => {
  it('degrades the snapshot and gateway budgets when a gateway source state is degraded', async () => {
    const ledger = new MemoryLedgerRepository();
    await ledger.commitImportBatch({
      events: [],
      sourceStates: [gatewayState({ degraded: true, degradedReason: 'http_unavailable' })],
    });
    const settings = {
      global: { monthlyTokenLimit: 1000, thresholds: [50], notificationsEnabled: true },
      teams: {
        'team:alpha': { monthlyTokenLimit: 1000, thresholds: [50], notificationsEnabled: true },
        'team:beta': { monthlyTokenLimit: 1000, thresholds: [50], notificationsEnabled: true },
      },
    };
    const service = new TokenUsageAnalyticsService({
      ledger,
      discovery: { discoverAppRuns: async () => [] },
      importers: [],
      clock: { now: () => new Date(NOW) },
      budgets: {
        getSettings: async () => settings,
        updateSettings: async () => settings,
      },
      gatewayUsage: {
        listSources: async () => [gatewaySource()],
        readUsageDay: async () => [],
      },
    });

    const snapshot = await service.getSnapshot();
    expect(snapshot.degraded).toBe(true);
    expect(snapshot.gatewaySourceCount).toBe(1);
    expect(snapshot.gatewayLastSuccessfulAt).toBeUndefined();

    const status = await service.getBudgetStatus();
    expect(status.degraded).toBe(true);
    const byId = new Map(status.targets.map((target) => [target.id, target]));
    expect(byId.get('global')?.metrics.every((metric) => metric.incomplete)).toBe(true);
    expect(byId.get('team:alpha')?.metrics.every((metric) => metric.incomplete)).toBe(true);
    expect(byId.get('team:beta')?.metrics.every((metric) => metric.incomplete)).toBe(false);
  });

  it('reports gatewayLastSuccessfulAt as the earliest success of complete sources', async () => {
    const ledger = new MemoryLedgerRepository();
    await ledger.commitImportBatch({
      events: [],
      sourceStates: [
        gatewayState(),
        gatewayState({
          gatewayUsageRef: 'ref-2',
          teamName: 'beta',
          agentName: 'reviewer',
          lastSuccessfulAt: '2026-06-29T03:00:00.000Z',
        }),
      ],
    });
    let listedSources = [
      gatewaySource(),
      gatewaySource({ gatewayUsageRef: 'ref-2', teamName: 'beta', memberName: 'reviewer' }),
    ];
    const service = new TokenUsageAnalyticsService({
      ledger,
      discovery: { discoverAppRuns: async () => [] },
      importers: [],
      clock: { now: () => new Date(NOW) },
      gatewayUsage: {
        listSources: async () => listedSources,
        readUsageDay: async () => [],
      },
    });

    const complete = await service.getSnapshot();
    expect(complete.degraded).toBe(false);
    expect(complete.gatewaySourceCount).toBe(2);
    expect(complete.gatewayLastSuccessfulAt).toBe('2026-06-29T03:00:00.000Z');

    // A state older than the newest bind stays pending and drops the minimum entirely.
    listedSources = [
      gatewaySource(),
      gatewaySource({
        gatewayUsageRef: 'ref-2',
        teamName: 'beta',
        memberName: 'reviewer',
        lastBoundAt: '2026-06-29T04:00:00.000Z',
      }),
    ];
    const pending = await service.getSnapshot();
    expect(pending.degraded).toBe(true);
    expect(pending.gatewayLastSuccessfulAt).toBeUndefined();
  });

  it('keeps previous sums and marks degraded when a refresh import fails', async () => {
    const ledger = new MemoryLedgerRepository();
    await ledger.upsertRuns([run()]);
    await ledger.upsertEvents([event({ totalTokens: 100 })]);
    const service = new TokenUsageAnalyticsService({
      ledger,
      discovery: { discoverAppRuns: async () => [run()] },
      importers: [
        {
          importUsage: async () => {
            throw new Error('gateway unreachable');
          },
        },
      ],
      clock: { now: () => new Date(NOW) },
    });

    const snapshot = await service.refreshSnapshot();
    expect(snapshot.summary.totalTokens).toBe(100);
    expect(snapshot.degraded).toBe(true);
    expect((await service.getBudgetStatus()).degraded).toBe(true);
  });

  it('passes gateway-marked runs only to gateway importers during refresh', async () => {
    const ledger = new MemoryLedgerRepository();
    const cliSeen: string[] = [];
    const gatewaySeen: string[] = [];
    const service = new TokenUsageAnalyticsService({
      ledger,
      discovery: {
        discoverAppRuns: async () => [
          run(),
          run({ appRunId: 'gateway-run', gatewayUsageRef: 'ref-1' }),
        ],
      },
      importers: [
        {
          importUsage: async (runs) => {
            cliSeen.push(...runs.map((item) => item.appRunId));
            return [];
          },
        },
        {
          includesGatewayRuns: true,
          importUsage: async (runs) => {
            gatewaySeen.push(...runs.map((item) => item.appRunId));
            return { events: [], sourceStates: [] };
          },
        },
      ],
      clock: { now: () => new Date(NOW) },
    });

    await service.refreshSnapshot();
    expect(cliSeen.sort()).toEqual(['run-1']);
    expect(gatewaySeen.sort()).toEqual(['gateway-run', 'run-1']);
  });
});

class CapturingBudgetEvaluator implements TokenUsageBudgetNotificationEvaluatorPort {
  readonly snapshots: TokenUsageBudgetStatusDto[] = [];

  async evaluate(snapshot: TokenUsageBudgetStatusDto): Promise<void> {
    this.snapshots.push(snapshot);
  }
}
