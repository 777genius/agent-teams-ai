import { appendFile, mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { TokenUsageAnalyticsService } from '../../../core/application';
import { CodexJsonlUsageImporter } from '../CodexJsonlUsageImporter';
import { JsonTokenUsageLedgerRepository } from '../JsonTokenUsageLedgerRepository';

import type { TokenUsageRunDto } from '../../../contracts';

function run(overrides: Partial<TokenUsageRunDto> = {}): TokenUsageRunDto {
  return {
    appRunId: 'app-run-1',
    teamName: 'alpha',
    agentId: 'alpha:probe',
    agentName: 'probe',
    runtimeKind: 'codex',
    providerId: 'codex',
    providerBackendId: 'codex-native',
    billingMode: 'subscription',
    model: 'gpt-5.4-mini',
    commandId: 'team-launch:alpha',
    commandInvocationId: 'team-launch:alpha:session-1',
    startedAt: '2026-06-30T00:00:00.000Z',
    status: 'completed',
    source: 'team_launch_state',
    sources: [
      {
        id: 'source-1',
        appRunId: 'app-run-1',
        sourceType: 'runtime_trace',
        nativeSessionId: 'session-1',
        discoveredAt: '2026-06-30T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function codexAssistantLine(): string {
  return JSON.stringify({
    type: 'assistant',
    uuid: 'assistant-uuid-1',
    timestamp: '2026-06-30T00:01:00.000Z',
    sessionId: 'session-1',
    message: {
      id: 'message-1',
      model: '<synthetic>',
      usage: {
        input_tokens: 1000,
        cache_read_input_tokens: 200,
        output_tokens: 50,
      },
    },
  });
}

function codexTurnCompletedLine(usage: Record<string, number>): string {
  return JSON.stringify({
    type: 'turn.completed',
    turn_id: 'turn-1',
    timestamp: '2026-06-30T00:01:00.000Z',
    session_id: 'session-1',
    model: 'gpt-5.4-mini',
    usage,
  });
}

function runWithLogPath(nativeLogPath: string): TokenUsageRunDto {
  const value = run();
  return { ...value, sources: [{ ...value.sources[0], nativeLogPath }] };
}

describe('CodexJsonlUsageImporter', () => {
  it('marks an oversized log refresh degraded while retaining prior usage and its freshness time', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'token-usage-codex-log-limit-'));
    try {
      const logPath = path.join(root, 'session-1.jsonl');
      await writeFile(
        logPath,
        `${codexTurnCompletedLine({ input_tokens: 1000, output_tokens: 100 })}\n`
      );
      const ledger = new JsonTokenUsageLedgerRepository(path.join(root, 'ledger.json'));
      const warn = vi.fn();
      const importer = new CodexJsonlUsageImporter({
        projectsBasePath: root,
        maxLogBytes: 512,
        logger: { warn },
      });
      let now = new Date('2026-06-30T00:05:00.000Z');
      const otherImporter = { importUsage: vi.fn(async () => []) };
      const service = new TokenUsageAnalyticsService({
        ledger,
        discovery: { discoverAppRuns: async () => [runWithLogPath(logPath)] },
        importers: [importer, otherImporter],
        clock: { now: () => now },
      });
      const initial = await service.refreshSnapshot();
      expect(initial.degraded).toBe(false);
      expect(initial.summary.totalTokens).toBe(1100);
      const previous = await ledger.readSnapshot();
      const updatedAt = (await service.getBudgetStatus()).usageUpdatedAt;
      expect(updatedAt).toBe(now.toISOString());

      await appendFile(
        logPath,
        JSON.stringify({
          type: 'turn.completed',
          turn_id: 'turn-2',
          timestamp: '2026-06-30T00:06:00.000Z',
          usage: { input_tokens: 2000, output_tokens: 200 },
          detail: 'x'.repeat(512),
        }) + '\n'
      );
      now = new Date('2026-06-30T00:10:00.000Z');
      const incomplete = await service.refreshSnapshot();
      expect(incomplete.degraded).toBe(true);
      expect(incomplete.summary.totalTokens).toBe(1100);
      expect((await ledger.readSnapshot()).events).toEqual(previous.events);
      expect(await service.getBudgetStatus()).toMatchObject({
        degraded: true,
        usageUpdatedAt: updatedAt,
      });
      expect(otherImporter.importUsage).toHaveBeenCalledTimes(2);
      expect(warn).toHaveBeenCalledWith('Failed to parse Codex token usage JSONL', {
        logPath,
        error: expect.objectContaining({ message: expect.stringContaining('size limit') }),
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('corrects inclusive native cache usage in place without charging reasoning twice', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'token-usage-codex-native-'));
    try {
      const logPath = path.join(root, 'session-1.jsonl');
      await writeFile(
        logPath,
        `${codexTurnCompletedLine({
          input_tokens: 1000,
          cached_input_tokens: 800,
          output_tokens: 100,
          reasoning_output_tokens: 40,
        })}\n`
      );
      const importer = new CodexJsonlUsageImporter({ projectsBasePath: root });
      const events = await importer.importUsage([runWithLogPath(logPath)]);

      expect(events).toHaveLength(1);
      const event = events[0]!;
      expect(event.tokens).toEqual({
        inputTokens: 200,
        outputTokens: 100,
        cacheReadTokens: 800,
        cacheCreationTokens: 0,
        reasoningTokens: 0,
        audioTokens: 0,
        imageTokens: 0,
        totalTokens: 1100,
      });
      expect(event.rawUsageJson).toMatchObject({ reasoningOutputTokens: 40 });
      expect(event.cost.apiEquivalentUsd).toBeCloseTo(0.00066, 10);
      // Retain the pre-fix identity so reimport replaces the stored overcount.
      const existingId = '30755669ef5884332a09334cd45a453cb31c46c56127bdb7f1531482b90f6633';
      expect(event.id).toBe(existingId);
      const repository = new JsonTokenUsageLedgerRepository(path.join(root, 'ledger.json'));
      await repository.upsertRuns([runWithLogPath(logPath)]);
      await repository.upsertEvents([
        {
          ...event,
          id: existingId,
          tokens: { ...event.tokens, inputTokens: 1000, totalTokens: 1900 },
          cost: { ...event.cost, estimatedUsd: 0.00126, apiEquivalentUsd: 0.00126 },
        },
      ]);
      await repository.upsertEvents(events);
      await repository.upsertEvents(await importer.importUsage([runWithLogPath(logPath)]));
      const snapshot = await repository.readSnapshot();
      expect(snapshot.events).toHaveLength(1);
      expect(snapshot.events[0]?.tokens).toEqual(event.tokens);
      expect(snapshot.events[0]?.cost).toEqual(event.cost);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it.each([
    { name: 'without caching', cached: undefined, input: 1000, cache: 0 },
    { name: 'with zero cached input', cached: 0, input: 1000, cache: 0 },
    { name: 'with fully cached input', cached: 1000, input: 0, cache: 1000 },
    { name: 'with an inconsistent cache count', cached: 1200, input: 0, cache: 1000 },
  ])('preserves native totals $name', async ({ cached, input, cache }) => {
    const root = await mkdtemp(path.join(tmpdir(), 'token-usage-codex-cache-'));
    try {
      const logPath = path.join(root, 'session-1.jsonl');
      await writeFile(
        logPath,
        `${codexTurnCompletedLine({
          input_tokens: 1000,
          output_tokens: 100,
          ...(cached === undefined ? {} : { cached_input_tokens: cached }),
        })}\n`
      );
      const importer = new CodexJsonlUsageImporter({ projectsBasePath: root });
      const events = await importer.importUsage([runWithLogPath(logPath)]);
      expect(events).toHaveLength(1);
      expect(events[0]?.tokens).toMatchObject({
        inputTokens: input,
        cacheReadTokens: cache,
        outputTokens: 100,
        totalTokens: 1100,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('imports Codex native JSONL usage and falls back from synthetic model to run model', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'token-usage-codex-jsonl-'));
    try {
      const logPath = path.join(root, 'session-1.jsonl');
      await writeFile(logPath, `${codexAssistantLine()}\n`);

      const importer = new CodexJsonlUsageImporter({ projectsBasePath: root });
      const events = await importer.importUsage([
        {
          ...run(),
          sources: [
            {
              ...run().sources[0],
              nativeLogPath: logPath,
            },
          ],
        },
      ]);

      expect(events).toHaveLength(1);
      expect(events[0]).toEqual(
        expect.objectContaining({
          appRunId: 'app-run-1',
          agentName: 'probe',
          runtimeKind: 'codex',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          billingMode: 'subscription',
          model: 'gpt-5.4-mini',
          nativeSessionId: 'session-1',
          nativeLogPath: logPath,
          usageSourceKind: 'log_parsed',
        })
      );
      expect(events[0]?.tokens).toEqual(
        expect.objectContaining({
          inputTokens: 1000,
          cacheReadTokens: 200,
          outputTokens: 50,
          totalTokens: 1250,
        })
      );
      expect(events[0]?.cost.apiEquivalentUsd).toBeGreaterThan(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finds Codex JSONL logs by native session id when nativeLogPath is absent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'token-usage-codex-jsonl-index-'));
    try {
      const projectDir = path.join(root, '-sandbox-project');
      await mkdir(projectDir, { recursive: true });
      await writeFile(path.join(projectDir, 'session-1.jsonl'), `${codexAssistantLine()}\n`);

      const importer = new CodexJsonlUsageImporter({ projectsBasePath: root });
      const events = await importer.importUsage([run()]);

      expect(events).toHaveLength(1);
      expect(events[0]?.nativeLogPath).toBe(path.join(projectDir, 'session-1.jsonl'));
      expect(events[0]?.model).toBe('gpt-5.4-mini');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
