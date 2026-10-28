import { mkdtemp, readFile, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { JsonTokenUsageLedgerRepository } from '../JsonTokenUsageLedgerRepository';

import type {
  TokenUsageEventDto,
  TokenUsageGatewaySourceStateDto,
  TokenUsageRunDto,
} from '../../../contracts';

function run(overrides: Partial<TokenUsageRunDto>): TokenUsageRunDto {
  return {
    appRunId: 'run-1',
    runtimeKind: 'codex',
    providerId: 'codex',
    providerBackendId: 'codex-native',
    billingMode: 'subscription',
    model: 'gpt-5.5',
    startedAt: '2026-06-30T00:00:00.000Z',
    status: 'unknown',
    source: 'team_launch_state',
    sources: [],
    ...overrides,
  };
}

function event(overrides: Partial<TokenUsageEventDto>): TokenUsageEventDto {
  return {
    id: 'event-1',
    appRunId: 'run-1',
    runtimeKind: 'codex',
    providerId: 'codex',
    providerBackendId: 'codex-native',
    billingMode: 'subscription',
    model: 'gpt-5.5',
    tokens: {
      inputTokens: 1,
      outputTokens: 2,
      cacheCreationTokens: 0,
      cacheReadTokens: 0,
      reasoningTokens: 0,
      audioTokens: 0,
      imageTokens: 0,
      totalTokens: 3,
    },
    cost: {
      estimatedUsd: 0.01,
      billableUsd: 0,
      apiEquivalentUsd: 0.01,
      source: 'pricing_table',
      billingMode: 'subscription',
    },
    usageSourceKind: 'log_parsed',
    occurredAt: '2026-06-30T00:01:00.000Z',
    createdAt: '2026-06-30T00:01:00.000Z',
    ...overrides,
  };
}

function sourceState(
  overrides: Partial<TokenUsageGatewaySourceStateDto> = {}
): TokenUsageGatewaySourceStateDto {
  return {
    gatewayUsageRef: 'ref-1',
    teamName: 'alpha',
    agentName: 'builder',
    degraded: false,
    ...overrides,
  };
}

describe('JsonTokenUsageLedgerRepository', () => {
  it.each([
    { operation: 'upsert', invalidField: 'appRunId' },
    { operation: 'upsert', invalidField: 'startedAt' },
    { operation: 'replace', invalidField: 'appRunId' },
    { operation: 'replace', invalidField: 'startedAt' },
  ] as const)(
    'preserves the durable ledger when $operation receives an invalid $invalidField',
    async ({ operation, invalidField }) => {
      const root = await mkdtemp(path.join(tmpdir(), 'token-usage-ledger-'));
      try {
        const filePath = path.join(root, 'ledger.json');
        const repository = new JsonTokenUsageLedgerRepository(filePath);
        await repository.upsertRuns([run({})]);
        const saved = await readFile(filePath, 'utf8');
        const batch = [
          run({ appRunId: 'new-run' }),
          run({ appRunId: 'invalid-run', [invalidField]: '   ' }),
        ];
        const mutate = (): Promise<void> =>
          operation === 'upsert'
            ? repository.upsertRuns(batch)
            : repository.replaceRunsForSource('team_launch_state', batch);

        await expect(mutate()).rejects.toThrow('Invalid token usage run entry');
        expect(await readFile(filePath, 'utf8')).toBe(saved);
        expect(await repository.listRuns()).toEqual([run({})]);

        await writeFile(filePath, '{"schemaVersion":2}');
        await expect(mutate()).rejects.toThrow('Invalid token usage run entry');
        expect(await readFile(filePath, 'utf8')).toBe('{"schemaVersion":2}');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it.each(['id', 'appRunId', 'occurredAt', 'createdAt'] as const)(
    'preserves the durable ledger when an event batch contains an invalid %s',
    async (invalidField) => {
      const root = await mkdtemp(path.join(tmpdir(), 'token-usage-ledger-'));
      try {
        const filePath = path.join(root, 'ledger.json');
        const repository = new JsonTokenUsageLedgerRepository(filePath);
        await repository.upsertRuns([run({})]);
        await repository.upsertEvents([event({})]);
        const saved = await readFile(filePath, 'utf8');
        const batch = [
          event({ id: 'event-1', model: 'replacement-model' }),
          event({ id: 'invalid-event', [invalidField]: '   ' }),
        ];

        await expect(repository.upsertEvents(batch)).rejects.toThrow(
          'Invalid token usage event entry'
        );
        expect(await readFile(filePath, 'utf8')).toBe(saved);
        expect(await repository.readSnapshot()).toEqual({
          runs: [run({})],
          events: [event({})],
          sourceStates: [],
        });

        await writeFile(filePath, '{"schemaVersion":2}');
        await expect(repository.upsertEvents(batch)).rejects.toThrow(
          'Invalid token usage event entry'
        );
        expect(await readFile(filePath, 'utf8')).toBe('{"schemaVersion":2}');
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('rejects an invalid replacement source without changing the durable ledger', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'token-usage-ledger-'));
    try {
      const filePath = path.join(root, 'ledger.json');
      const repository = new JsonTokenUsageLedgerRepository(filePath);
      await repository.upsertRuns([run({})]);
      const saved = await readFile(filePath, 'utf8');

      await expect(
        repository.replaceRunsForSource('invalid' as TokenUsageRunDto['source'], [])
      ).rejects.toThrow('Invalid token usage run source');
      expect(await readFile(filePath, 'utf8')).toBe(saved);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists canonical entries and merges replacements by normalized identifiers', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'token-usage-ledger-'));
    try {
      const filePath = path.join(root, 'ledger.json');
      const repository = new JsonTokenUsageLedgerRepository(filePath);
      const existingSource = {
        id: 'source-1',
        appRunId: 'run-1',
        sourceType: 'cli_log' as const,
        discoveredAt: '2026-06-30T00:00:00.000Z',
      };
      await repository.upsertRuns([run({ sources: [existingSource] })]);
      await repository.upsertEvents([event({})]);
      await repository.upsertRuns([
        run({
          appRunId: ' run-1 ',
          model: ' updated-model ',
          sources: [
            { ...existingSource, id: ' source-1 ', appRunId: ' run-1 ', parserVersion: ' 2 ' },
          ],
        }),
      ]);
      await repository.replaceRunsForSource('team_launch_state', [
        run({ appRunId: ' run-1 ', model: ' final-model ' }),
      ]);
      await repository.upsertEvents([
        event({
          id: ' event-1 ',
          appRunId: ' run-1 ',
          model: ' final-model ',
          tokens: { ...event({}).tokens, inputTokens: -1, totalTokens: 0 },
        }),
      ]);

      const snapshot = await new JsonTokenUsageLedgerRepository(filePath).readSnapshot();
      expect(snapshot.runs).toEqual([
        run({ model: 'final-model', sources: [{ ...existingSource, parserVersion: '2' }] }),
      ]);
      expect(snapshot.events).toEqual([
        event({
          model: 'final-model',
          tokens: { ...event({}).tokens, inputTokens: 0, totalTokens: 2 },
        }),
      ]);
      expect(JSON.parse(await readFile(filePath, 'utf8'))).toEqual({
        schemaVersion: 1,
        runs: { 'run-1': snapshot.runs[0] },
        events: { 'event-1': snapshot.events[0] },
        sourceStates: {},
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('replaces authoritative source runs while preserving runs that still have events', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'token-usage-ledger-'));
    try {
      const repository = new JsonTokenUsageLedgerRepository(path.join(root, 'ledger.json'));
      await repository.upsertRuns([
        run({ appRunId: 'stale-empty' }),
        run({ appRunId: 'stale-with-event' }),
        run({ appRunId: 'manual-run', source: 'manual_import' }),
      ]);
      await repository.upsertEvents([event({ appRunId: 'stale-with-event' })]);

      await repository.replaceRunsForSource('team_launch_state', [
        run({ appRunId: 'current-run', providerBackendId: 'api', billingMode: 'api' }),
      ]);

      const runs = await repository.listRuns();
      expect(runs.map((item) => item.appRunId).sort()).toEqual([
        'current-run',
        'manual-run',
        'stale-with-event',
      ]);
      expect(runs.find((item) => item.appRunId === 'current-run')).toEqual(
        expect.objectContaining({ providerBackendId: 'api', billingMode: 'api' })
      );
      expect(await repository.listEvents()).toEqual([
        expect.objectContaining({
          appRunId: 'stale-with-event',
          providerBackendId: 'codex-native',
          billingMode: 'subscription',
        }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('persists gateway events and source states together in one committed batch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'token-usage-ledger-'));
    try {
      const filePath = path.join(root, 'ledger.json');
      const repository = new JsonTokenUsageLedgerRepository(filePath);
      const state = sourceState({
        agentId: 'alpha:builder',
        watermarkDay: '2026-06-01',
        lastUsedAt: '2026-06-05T08:00:00.000Z',
        finalUsageDay: '2026-06-05',
        degraded: true,
        degradedReason: 'credential_changed',
        lastSuccessfulAt: '2026-06-01T00:00:00.000Z',
      });
      await repository.commitImportBatch({
        events: [
          event({
            usageSourceKind: 'gateway_exact',
            gatewayUsageRef: 'ref-1',
            gatewayDay: '2026-06-01',
            requestCount: 25,
          }),
        ],
        sourceStates: [state],
      });

      const saved = JSON.parse(await readFile(filePath, 'utf8')) as Record<string, unknown>;
      expect(saved).toMatchObject({
        schemaVersion: 1,
        runs: {},
        sourceStates: { 'ref-1': state },
      });
      expect(saved.events).toMatchObject({
        'event-1': { gatewayDay: '2026-06-01', requestCount: 25, usageSourceKind: 'gateway_exact' },
      });
      expect(await repository.readSnapshot()).toEqual({
        runs: [],
        events: [expect.objectContaining({ id: 'event-1', requestCount: 25 })],
        sourceStates: [state],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each(['gatewayUsageRef', 'teamName', 'agentName'] as const)(
    'preserves the durable ledger when a batch carries an invalid source state %s',
    async (invalidField) => {
      const root = await mkdtemp(path.join(tmpdir(), 'token-usage-ledger-'));
      try {
        const filePath = path.join(root, 'ledger.json');
        const repository = new JsonTokenUsageLedgerRepository(filePath);
        await repository.upsertRuns([run({})]);
        await repository.upsertEvents([event({})]);
        const saved = await readFile(filePath, 'utf8');
        const batch = {
          events: [event({ id: 'new-event' })],
          sourceStates: [sourceState({ [invalidField]: '   ' })],
        };

        await expect(repository.commitImportBatch(batch)).rejects.toThrow(
          'Invalid gateway usage source state'
        );
        expect(await readFile(filePath, 'utf8')).toBe(saved);
        const snapshot = await repository.readSnapshot();
        expect(snapshot.events.map((item) => item.id)).toEqual(['event-1']);
        expect(snapshot.sourceStates).toEqual([]);
      } finally {
        await rm(root, { recursive: true, force: true });
      }
    }
  );

  it('round-trips source states with watermark and degraded reason through readSnapshot', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'token-usage-ledger-'));
    try {
      const filePath = path.join(root, 'ledger.json');
      const repository = new JsonTokenUsageLedgerRepository(filePath);
      const states = [
        sourceState({
          watermarkDay: '2026-06-01',
          degraded: true,
          degradedReason: 'http_unavailable',
          lastSuccessfulAt: '2026-06-01T00:00:00.000Z',
        }),
        sourceState({
          gatewayUsageRef: 'ref-2',
          teamName: 'beta',
          agentName: 'reviewer',
          watermarkDay: '2026-06-03',
          finalUsageDay: '2026-06-05',
          degraded: true,
          degradedReason: 'credential_missing',
        }),
        sourceState({
          gatewayUsageRef: 'ref-3',
          degradedReason:
            'nonsense' as unknown as TokenUsageGatewaySourceStateDto['degradedReason'],
        }),
      ];
      await repository.commitImportBatch({ events: [], sourceStates: states });

      const snapshot = await new JsonTokenUsageLedgerRepository(filePath).readSnapshot();
      expect(snapshot.sourceStates).toEqual([
        states[0],
        states[1],
        sourceState({ gatewayUsageRef: 'ref-3' }),
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
