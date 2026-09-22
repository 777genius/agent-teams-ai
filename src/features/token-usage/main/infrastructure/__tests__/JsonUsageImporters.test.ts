import { describe, expect, it } from 'vitest';

import { StaticJsonUsageImporter } from '../JsonUsageImporters';

import type { TokenUsageRunDto } from '../../../contracts';

function run(): TokenUsageRunDto {
  return {
    appRunId: 'app-run-1',
    teamName: 'alpha',
    agentId: 'alpha:builder',
    agentName: 'builder',
    runtimeKind: 'anthropic',
    providerId: 'anthropic',
    billingMode: 'subscription',
    model: 'claude-sonnet',
    commandId: 'launch-team',
    commandInvocationId: 'launch-team-invocation-1',
    startedAt: '2026-06-30T00:00:00.000Z',
    status: 'running',
    source: 'team_launch_state',
    sources: [
      {
        id: 'source-1',
        appRunId: 'app-run-1',
        sourceType: 'cli_log',
        nativeSessionId: 'native-session-1',
        discoveredAt: '2026-06-30T00:00:00.000Z',
      },
    ],
  };
}

describe('StaticJsonUsageImporter', () => {
  it('imports only records that match mapped native session ids', async () => {
    const importer = new StaticJsonUsageImporter('ccusage', async () => ({
      data: [
        {
          sessionId: 'native-session-1',
          model: 'claude-sonnet',
          inputTokens: 12,
          outputTokens: 18,
          cacheCreationTokens: 3,
          cacheReadTokens: 4,
          totalTokens: 37,
          costUsd: 0.025,
          timestamp: '2026-06-30T00:03:00.000Z',
        },
        {
          sessionId: 'unmapped-session',
          totalTokens: 999,
        },
      ],
    }));

    const events = await importer.importUsage([run()]);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        appRunId: 'app-run-1',
        teamName: 'alpha',
        agentId: 'alpha:builder',
        commandId: 'launch-team',
        commandInvocationId: 'launch-team-invocation-1',
        nativeSessionId: 'native-session-1',
        usageSourceKind: 'log_parsed',
        occurredAt: '2026-06-30T00:03:00.000Z',
      })
    );
    expect(events[0]?.tokens).toEqual(
      expect.objectContaining({
        inputTokens: 12,
        outputTokens: 18,
        cacheCreationTokens: 3,
        cacheReadTokens: 4,
        totalTokens: 37,
      })
    );
    expect(events[0]).toEqual(
      expect.objectContaining({
        billingMode: 'subscription',
      })
    );
    expect(events[0]?.cost).toEqual(
      expect.objectContaining({
        estimatedUsd: 0.025,
        apiEquivalentUsd: 0.025,
        billableUsd: 0,
        source: 'pricing_table',
        billingMode: 'subscription',
      })
    );
  });

  it('supports tokscale session_id records', async () => {
    const importer = new StaticJsonUsageImporter('tokscale', async () => [
      {
        session_id: 'native-session-1',
        model: 'claude-sonnet',
        input_tokens: 5,
        output_tokens: 7,
        total_tokens: 12,
      },
    ]);

    const events = await importer.importUsage([run()]);

    expect(events).toHaveLength(1);
    expect(events[0]?.nativeSessionId).toBe('native-session-1');
    expect(events[0]?.tokens.totalTokens).toBe(12);
  });

  it('estimates cost from pricing table when raw usage has no positive cost', async () => {
    const importer = new StaticJsonUsageImporter('tokscale', async () => [
      {
        session_id: 'native-session-1',
        model: 'gpt-5.4-mini',
        input_tokens: 100_000,
        output_tokens: 10_000,
        cacheRead: 50_000,
      },
    ]);

    const events = await importer.importUsage([
      { ...run(), runtimeKind: 'codex', providerId: 'codex', model: 'gpt-5.4-mini' },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]?.cost.source).toBe('pricing_table');
    expect(events[0]?.cost.estimatedUsd).toBeGreaterThan(0);
    expect(events[0]?.cost.billableUsd).toBe(0);
  });

  it('marks cost unknown when neither raw cost nor model pricing is available', async () => {
    const importer = new StaticJsonUsageImporter('tokscale', async () => [
      {
        session_id: 'native-session-1',
        model: 'gpt-5.5',
        input_tokens: 100_000,
        output_tokens: 10_000,
        cost: 0,
      },
    ]);

    const events = await importer.importUsage([
      { ...run(), runtimeKind: 'codex', providerId: 'codex', model: 'gpt-5.5' },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]?.cost).toEqual(
      expect.objectContaining({
        estimatedUsd: 0,
        apiEquivalentUsd: 0,
        billableUsd: 0,
        source: 'unknown',
      })
    );
  });

  it('imports real ccusage session records and expands model breakdowns', async () => {
    const importer = new StaticJsonUsageImporter('ccusage', async () => ({
      session: [
        {
          period: 'native-session-1',
          inputTokens: 100,
          outputTokens: 50,
          cacheCreationTokens: 10,
          cacheReadTokens: 20,
          totalTokens: 180,
          totalCost: 1.5,
          metadata: {
            lastActivity: '2026-06-30T00:07:00.000Z',
          },
          modelBreakdowns: [
            {
              modelName: 'claude-opus',
              inputTokens: 60,
              outputTokens: 25,
              cacheCreationTokens: 10,
              cacheReadTokens: 20,
              cost: 0.9,
            },
            {
              modelName: 'claude-sonnet',
              inputTokens: 40,
              outputTokens: 25,
              cacheCreationTokens: 0,
              cacheReadTokens: 0,
              cost: 0.6,
            },
          ],
        },
      ],
    }));

    const events = await importer.importUsage([run()]);

    expect(events).toHaveLength(2);
    expect(events.map((event) => event.model).sort()).toEqual(['claude-opus', 'claude-sonnet']);
    expect(events.reduce((sum, event) => sum + event.tokens.totalTokens, 0)).toBe(180);
    expect(events.reduce((sum, event) => sum + event.cost.estimatedUsd, 0)).toBeCloseTo(1.5);
    expect(events[0]?.occurredAt).toBe('2026-06-30T00:07:00.000Z');
  });

  it('matches ccusage slash-style periods by the last path segment', async () => {
    const importer = new StaticJsonUsageImporter('ccusage', async () => ({
      session: [
        {
          period: '/Users/example/.claude/projects/native-session-1',
          inputTokens: 8,
          outputTokens: 4,
          totalTokens: 12,
        },
      ],
    }));

    const events = await importer.importUsage([run()]);

    expect(events).toHaveLength(1);
    expect(events[0]?.nativeSessionId).toBe('native-session-1');
    expect(events[0]?.occurredAt).toBe('2026-06-30T00:00:00.000Z');
  });

  it('imports real tokscale entries and computes totals from token parts', async () => {
    const importer = new StaticJsonUsageImporter('tokscale', async () => ({
      entries: [
        {
          sessionId: 'native-session-1',
          provider: 'anthropic',
          model: 'claude-sonnet',
          input: 5,
          output: 7,
          cacheRead: 11,
          cacheWrite: 13,
          reasoning: 17,
          cost: 0.42,
        },
      ],
    }));

    const events = await importer.importUsage([run()]);

    expect(events).toHaveLength(1);
    expect(events[0]?.providerId).toBe('anthropic');
    expect(events[0]?.model).toBe('claude-sonnet');
    expect(events[0]?.tokens).toEqual(
      expect.objectContaining({
        inputTokens: 5,
        outputTokens: 7,
        cacheReadTokens: 11,
        cacheCreationTokens: 13,
        reasoningTokens: 17,
        totalTokens: 53,
      })
    );
    expect(events[0]?.cost).toEqual(
      expect.objectContaining({
        estimatedUsd: 0.42,
        apiEquivalentUsd: 0.42,
        billableUsd: 0,
        source: 'pricing_table',
      })
    );
  });

  it('preserves API billing mode while treating importer costs as API-equivalent estimates', async () => {
    const importer = new StaticJsonUsageImporter('tokscale', async () => ({
      entries: [
        {
          sessionId: 'native-session-1',
          model: 'claude-sonnet',
          input: 5,
          output: 7,
          cost: 0.42,
        },
      ],
    }));

    const events = await importer.importUsage([
      { ...run(), providerBackendId: 'api', billingMode: 'api' },
    ]);

    expect(events).toHaveLength(1);
    expect(events[0]).toEqual(
      expect.objectContaining({
        providerBackendId: 'api',
        billingMode: 'api',
      })
    );
    expect(events[0]?.cost).toEqual(
      expect.objectContaining({
        apiEquivalentUsd: 0.42,
        billableUsd: 0,
        billingMode: 'api',
        source: 'pricing_table',
      })
    );
  });

  it('uses source-agnostic stable event ids for overlapping imports', async () => {
    const ccusageImporter = new StaticJsonUsageImporter('ccusage', async () => ({
      session: [
        {
          period: 'native-session-1',
          modelsUsed: ['claude-sonnet'],
          inputTokens: 5,
          outputTokens: 7,
          totalTokens: 12,
        },
      ],
    }));
    const tokscaleImporter = new StaticJsonUsageImporter('tokscale', async () => ({
      entries: [
        {
          sessionId: 'native-session-1',
          model: 'claude-sonnet',
          input: 5,
          output: 7,
        },
      ],
    }));

    const [ccusageEvent] = await ccusageImporter.importUsage([run()]);
    const [tokscaleEvent] = await tokscaleImporter.importUsage([run()]);

    expect(ccusageEvent?.id).toBe(tokscaleEvent?.id);
    expect(ccusageEvent?.id).toBeDefined();
  });
});
