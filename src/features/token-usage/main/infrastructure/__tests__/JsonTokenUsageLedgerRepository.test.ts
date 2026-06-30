import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { JsonTokenUsageLedgerRepository } from '../JsonTokenUsageLedgerRepository';

import type { TokenUsageEventDto, TokenUsageRunDto } from '../../../contracts';

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

describe('JsonTokenUsageLedgerRepository', () => {
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
});
