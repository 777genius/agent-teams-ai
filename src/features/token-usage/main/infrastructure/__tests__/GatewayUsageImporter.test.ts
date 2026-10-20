import { createHash } from 'crypto';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { GatewayUsageImporter } from '../GatewayUsageImporter';
import { JsonTokenUsageLedgerRepository } from '../JsonTokenUsageLedgerRepository';

import type {
  TokenUsageEventDto,
  TokenUsageGatewaySourceStateDto,
  TokenUsageRunDto,
} from '../../../contracts';
import type {
  TokenUsageGatewayModelUsage,
  TokenUsageGatewayUsagePort,
  TokenUsageGatewayUsageSource,
  TokenUsageImportBatch,
  TokenUsageLedgerSnapshot,
} from '../../../core/application';

const REF = 'gateway-ref-1';

function source(
  overrides: Partial<TokenUsageGatewayUsageSource> = {}
): TokenUsageGatewayUsageSource {
  return {
    gatewayUsageRef: REF,
    teamName: 'alpha',
    memberName: 'builder',
    agentId: 'alpha:builder',
    firstUsageDay: '2026-06-01',
    lastBoundAt: '2026-06-01T00:00:00.000Z',
    hasActiveBinding: true,
    hasRuntimeArtifact: false,
    ...overrides,
  };
}

function modelUsage(
  overrides: Partial<TokenUsageGatewayModelUsage> = {}
): TokenUsageGatewayModelUsage {
  return {
    model: 'claude-sonnet',
    requests: 25,
    inputTokens: 10,
    outputTokens: 20,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalTokens: 30,
    apiEquivalentUsd: 0.5,
    billableUsd: 0.5,
    ...overrides,
  };
}

function gatewayEventId(day: string, model: string): string {
  const digest = createHash('sha256')
    .update(JSON.stringify([REF, day, model]))
    .digest('hex');
  return `gateway:${digest}`;
}

class MemoryLedger {
  events: TokenUsageEventDto[] = [];
  sourceStates: TokenUsageGatewaySourceStateDto[] = [];

  async readSnapshot(): Promise<TokenUsageLedgerSnapshot> {
    return { runs: [], events: [...this.events], sourceStates: [...this.sourceStates] };
  }

  commit(batch: TokenUsageImportBatch): void {
    const eventsById = new Map(this.events.map((event) => [event.id, event]));
    for (const event of batch.events) eventsById.set(event.id, event);
    this.events = [...eventsById.values()];
    const statesByRef = new Map(this.sourceStates.map((state) => [state.gatewayUsageRef, state]));
    for (const state of batch.sourceStates ?? []) statesByRef.set(state.gatewayUsageRef, state);
    this.sourceStates = [...statesByRef.values()];
  }
}

function fakeUsage(
  readDay: (day: string) => TokenUsageGatewayModelUsage[],
  sources: TokenUsageGatewayUsageSource[] = [source()]
): { port: TokenUsageGatewayUsagePort; readDays: string[] } {
  const readDays: string[] = [];
  return {
    readDays,
    port: {
      listSources: async () => sources,
      readUsageDay: async (_gatewayUsageRef, day) => {
        readDays.push(day);
        return readDay(day);
      },
    },
  };
}

describe('GatewayUsageImporter', () => {
  it('successful empty day emits no events and advances the watermark once stabilized', async () => {
    const ledger = new MemoryLedger();
    const gateway = fakeUsage(() => []);
    const importer = new GatewayUsageImporter({
      usage: gateway.port,
      ledger,
      clock: { now: () => new Date('2026-06-03T00:00:00.000Z') },
    });

    const batch = await importer.importUsage([]);

    expect(gateway.readDays).toEqual(['2026-06-01', '2026-06-02', '2026-06-03']);
    expect(batch.events).toEqual([]);
    expect(batch.sourceStates).toHaveLength(1);
    expect(batch.sourceStates[0]).toMatchObject({
      gatewayUsageRef: REF,
      watermarkDay: '2026-06-01',
      degraded: false,
    });
  });

  it.each([
    ['credential_changed', { reason: 'credential_changed' }],
    ['credential_missing', { reason: 'credential_missing' }],
    ['http_unavailable', new Error('gateway unreachable')],
  ] as const)(
    'error day keeps previous sums, maps %s and does not advance the watermark',
    async (reason, error) => {
      const ledger = new MemoryLedger();
      ledger.events = [previousEvent('2026-06-01', 'claude-sonnet')];
      const gateway = fakeUsage((day) => {
        // eslint-disable-next-line @typescript-eslint/only-throw-error -- contract cases throw error-like { reason } shapes and Errors
        if (day === '2026-06-01') throw error;
        return [modelUsage({ model: 'claude-sonnet' })];
      });
      const importer = new GatewayUsageImporter({
        usage: gateway.port,
        ledger,
        clock: { now: () => new Date('2026-06-05T00:00:00.000Z') },
      });

      const batch = await importer.importUsage([]);

      expect(batch.events).toHaveLength(4);
      expect(batch.events.every((event) => event.gatewayDay !== '2026-06-01')).toBe(true);
      expect(ledger.events).toEqual([previousEvent('2026-06-01', 'claude-sonnet')]);
      expect(batch.sourceStates[0]).toMatchObject({ degraded: true, degradedReason: reason });
      expect(batch.sourceStates[0]?.watermarkDay).toBeUndefined();
      expect(batch.sourceStates[0]?.lastSuccessfulAt).toBeUndefined();
    }
  );

  it('does not advance the watermark past an un-stabilized day', async () => {
    const ledger = new MemoryLedger();
    const gateway = fakeUsage(() => [modelUsage()]);
    const importer = new GatewayUsageImporter({
      usage: gateway.port,
      ledger,
      clock: { now: () => new Date('2026-06-04T12:00:00.000Z') },
    });

    const batch = await importer.importUsage([]);

    expect(batch.events.map((event) => event.gatewayDay)).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
    ]);
    expect(batch.sourceStates[0]?.watermarkDay).toBe('2026-06-02');
  });

  it('keeps a day pending inside the 24h window and completes it with late records on re-import', async () => {
    const ledger = new MemoryLedger();
    let now = new Date('2026-06-02T12:00:00.000Z');
    let dayOneUsage = [modelUsage({ model: 'model-a' })];
    const gateway = fakeUsage((day) => (day === '2026-06-01' ? dayOneUsage : []));
    const importer = new GatewayUsageImporter({
      usage: gateway.port,
      ledger,
      clock: { now: () => now },
    });

    const first = await importer.importUsage([]);
    ledger.commit(first);
    expect(first.sourceStates[0]?.watermarkDay).toBeUndefined();

    dayOneUsage = [modelUsage({ model: 'model-a' }), modelUsage({ model: 'model-b' })];
    now = new Date('2026-06-04T00:00:00.000Z');
    const second = await importer.importUsage([]);

    expect(gateway.readDays.filter((day) => day === '2026-06-01')).toHaveLength(2);
    expect(second.events.map((event) => event.model)).toEqual(['model-a', 'model-b']);
    expect(second.events.find((event) => event.model === 'model-b')).toMatchObject({
      id: gatewayEventId('2026-06-01', 'model-b'),
    });
    expect(second.sourceStates[0]?.watermarkDay).toBe('2026-06-02');
  });

  it('re-import upserts deterministic ids without duplicating day aggregates', async () => {
    const ledger = new MemoryLedger();
    const now = new Date('2026-06-02T12:00:00.000Z');
    const gateway = fakeUsage(() => [
      modelUsage({ model: 'model-a' }),
      modelUsage({ model: 'model-b', requests: 0 }),
    ]);
    const deps = {
      usage: gateway.port,
      ledger,
      clock: { now: () => now },
    };
    const expectedIds = [
      gatewayEventId('2026-06-01', 'model-a'),
      gatewayEventId('2026-06-01', 'model-b'),
      gatewayEventId('2026-06-02', 'model-a'),
      gatewayEventId('2026-06-02', 'model-b'),
    ];

    const first = await new GatewayUsageImporter(deps).importUsage([]);
    ledger.commit(first);
    const second = await new GatewayUsageImporter(deps).importUsage([]);
    ledger.commit(second);
    const third = await new GatewayUsageImporter(deps).importUsage([]);

    expect(first.events.map((event) => event.id)).toEqual(expectedIds);
    expect(second.events.map((event) => event.id)).toEqual(expectedIds);
    expect(third.events.map((event) => event.id)).toEqual(expectedIds);
    expect(ledger.events).toHaveLength(4);
  });

  it('zeroes disappeared models with their previous ids when a pending day is re-imported', async () => {
    const ledger = new MemoryLedger();
    const now = new Date('2026-06-02T12:00:00.000Z');
    let dayOne = [modelUsage({ model: 'model-a' }), modelUsage({ model: 'model-b' })];
    let dayTwo = [modelUsage({ model: 'model-c' })];
    const gateway = fakeUsage((day) => (day === '2026-06-01' ? dayOne : dayTwo));
    const importer = new GatewayUsageImporter({
      usage: gateway.port,
      ledger,
      clock: { now: () => now },
    });
    const first = await importer.importUsage([]);
    ledger.commit(first);
    expect(first.events).toHaveLength(3);

    dayOne = [modelUsage({ model: 'model-a' })];
    dayTwo = [];
    const second = await importer.importUsage([]);

    expect(second.events.map((event) => event.id)).toEqual([
      gatewayEventId('2026-06-01', 'model-a'),
      gatewayEventId('2026-06-01', 'model-b'),
      gatewayEventId('2026-06-02', 'model-c'),
    ]);
    const zeroed = second.events.filter((event) => event.model !== 'model-a');
    expect(zeroed).toHaveLength(2);
    for (const event of zeroed) {
      expect(event.tokens.totalTokens).toBe(0);
      expect(event.cost).toEqual({
        estimatedUsd: 0,
        billableUsd: 0,
        apiEquivalentUsd: 0,
        source: 'gateway',
        billingMode: 'api',
      });
      expect(event.requestCount).toBe(0);
    }
    expect(second.events.find((event) => event.model === 'model-a')?.tokens.totalTokens).toBe(30);
  });

  it('round-trips requestCount 0/25 and explicit zero billable cost through the ledger', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'gateway-usage-importer-'));
    try {
      const repository = new JsonTokenUsageLedgerRepository(path.join(root, 'ledger.json'));
      const gateway = fakeUsage(() => [
        modelUsage({
          model: 'model-zero',
          requests: 0,
          billableUsd: 0,
          apiEquivalentUsd: 0.5,
        }),
        modelUsage({ model: 'model-many', requests: 25 }),
      ]);
      const importer = new GatewayUsageImporter({
        usage: gateway.port,
        ledger: repository,
        clock: { now: () => new Date('2026-06-02T12:00:00.000Z') },
      });

      const batch = await importer.importUsage([]);
      await repository.commitImportBatch(batch);
      const events = (await repository.readSnapshot()).events;

      const zeroRequestEvents = events.filter((event) => event.model === 'model-zero');
      expect(zeroRequestEvents.length).toBeGreaterThan(0);
      for (const event of zeroRequestEvents) {
        expect(event.requestCount).toBe(0);
        expect(event.cost.billableUsd).toBe(0);
        expect(event.cost.apiEquivalentUsd).toBe(0.5);
      }
      const manyRequestEvents = events.filter((event) => event.model === 'model-many');
      expect(manyRequestEvents.length).toBeGreaterThan(0);
      for (const event of manyRequestEvents) {
        expect(event.requestCount).toBe(25);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('stops importing after the final usage day computed from unbind', async () => {
    const ledger = new MemoryLedger();
    const gateway = fakeUsage(
      () => [modelUsage()],
      [source({ hasActiveBinding: false, lastUnboundAt: '2026-06-05T08:00:00.000Z' })]
    );
    const importer = new GatewayUsageImporter({
      usage: gateway.port,
      ledger,
      clock: { now: () => new Date('2026-06-20T00:00:00.000Z') },
    });

    const first = await importer.importUsage([]);
    ledger.commit(first);

    expect(gateway.readDays).toEqual([
      '2026-06-01',
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
    ]);
    expect(first.events.every((event) => (event.gatewayDay ?? '') <= '2026-06-05')).toBe(true);
    expect(first.sourceStates[0]).toMatchObject({
      finalUsageDay: '2026-06-05',
      lastUsedAt: '2026-06-05T08:00:00.000Z',
      watermarkDay: '2026-06-05',
    });

    const second = await importer.importUsage([]);

    expect(gateway.readDays).toHaveLength(5);
    expect(second.events).toEqual([]);
    expect(second.sourceStates[0]).toMatchObject({
      finalUsageDay: '2026-06-05',
      watermarkDay: '2026-06-05',
    });
  });

  it('re-imports every skipped UTC day once with the preserved owner after a bind pause', async () => {
    const ledger = new MemoryLedger();
    ledger.sourceStates = [
      {
        gatewayUsageRef: REF,
        teamName: 'alpha',
        agentName: 'builder',
        agentId: 'alpha:builder',
        watermarkDay: '2026-06-01',
        degraded: false,
        lastSuccessfulAt: '2026-06-03T00:00:00.000Z',
      },
    ];
    const gateway = fakeUsage(
      () => [modelUsage()],
      [source({ lastBoundAt: '2026-06-10T00:00:00.000Z' })]
    );
    const markedRun: TokenUsageRunDto = {
      appRunId: 'gateway-run',
      gatewayUsageRef: REF,
      teamName: 'beta',
      agentId: 'beta:renamed',
      agentName: 'renamed',
      runtimeKind: 'unknown',
      startedAt: '2026-06-09T10:00:00.000Z',
      endedAt: '2026-06-09T12:00:00.000Z',
      status: 'completed',
      source: 'team_launch_state',
      sources: [],
    };
    const importer = new GatewayUsageImporter({
      usage: gateway.port,
      ledger,
      clock: { now: () => new Date('2026-06-10T06:00:00.000Z') },
    });

    const batch = await importer.importUsage([markedRun]);

    expect(gateway.readDays).toEqual([
      '2026-06-02',
      '2026-06-03',
      '2026-06-04',
      '2026-06-05',
      '2026-06-06',
      '2026-06-07',
      '2026-06-08',
      '2026-06-09',
      '2026-06-10',
    ]);
    expect(batch.events).toHaveLength(9);
    expect(
      batch.events.every(
        (event) =>
          event.teamName === 'alpha' &&
          event.agentName === 'builder' &&
          event.agentId === 'alpha:builder'
      )
    ).toBe(true);
    expect(batch.sourceStates[0]?.watermarkDay).toBe('2026-06-08');
  });

  it('advances lastSuccessfulAt only on a fully successful import', async () => {
    const ledger = new MemoryLedger();
    ledger.sourceStates = [
      {
        gatewayUsageRef: REF,
        teamName: 'alpha',
        agentName: 'builder',
        watermarkDay: '2026-06-01',
        degraded: false,
        lastSuccessfulAt: '2026-06-01T00:00:00.000Z',
      },
    ];
    let failing = true;
    let now = new Date('2026-06-05T00:00:00.000Z');
    const gateway = fakeUsage((day) => {
      if (failing && day === '2026-06-03') throw new Error('gateway unreachable');
      return [modelUsage()];
    });
    const importer = new GatewayUsageImporter({
      usage: gateway.port,
      ledger,
      clock: { now: () => now },
    });

    const partial = await importer.importUsage([]);
    ledger.commit(partial);
    expect(partial.sourceStates[0]).toMatchObject({
      degraded: true,
      degradedReason: 'http_unavailable',
      lastSuccessfulAt: '2026-06-01T00:00:00.000Z',
      watermarkDay: '2026-06-02',
    });

    failing = false;
    now = new Date('2026-06-05T01:00:00.000Z');
    const recovered = await importer.importUsage([]);

    expect(recovered.sourceStates[0]).toMatchObject({
      degraded: false,
      lastSuccessfulAt: '2026-06-05T01:00:00.000Z',
      watermarkDay: '2026-06-03',
    });
    expect(recovered.sourceStates[0]?.degradedReason).toBeUndefined();
  });
  it('keeps an undiscovered or unknown-ended gateway consumer active after unbind', async () => {
    const gateway = fakeUsage(
      () => [],
      [source({ hasActiveBinding: false, lastUnboundAt: '2026-06-01T10:00:00.000Z' })]
    );
    const importer = new GatewayUsageImporter({
      usage: gateway.port,
      ledger: new MemoryLedger(),
      clock: { now: () => new Date('2026-06-05T12:00:00.000Z') },
    });
    const batch = await importer.importUsage([
      {
        appRunId: 'pending',
        gatewayUsageRef: REF,
        runtimeKind: 'unknown',
        startedAt: '2026-06-01T09:00:00.000Z',
        status: 'unknown',
        source: 'team_launch_state',
        sources: [],
      },
    ]);
    expect(batch.sourceStates[0].finalUsageDay).toBeUndefined();
    expect(gateway.readDays).toContain('2026-06-05');
  });
});

function previousEvent(day: string, model: string): TokenUsageEventDto {
  return {
    id: gatewayEventId(day, model),
    appRunId: `gateway:${REF}:${day}`,
    teamName: 'alpha',
    agentId: 'alpha:builder',
    agentName: 'builder',
    runtimeKind: 'unknown',
    billingMode: 'api',
    model,
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
    cost: {
      estimatedUsd: 0.5,
      billableUsd: 0.5,
      apiEquivalentUsd: 0.5,
      source: 'gateway',
      billingMode: 'api',
    },
    usageSourceKind: 'gateway_exact',
    gatewayUsageRef: REF,
    gatewayDay: day,
    requestCount: 25,
    occurredAt: `${day}T00:00:00.000Z`,
    createdAt: '2026-06-01T00:00:00.000Z',
  };
}
