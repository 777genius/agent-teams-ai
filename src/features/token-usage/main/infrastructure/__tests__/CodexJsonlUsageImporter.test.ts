import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { CodexJsonlUsageImporter } from '../CodexJsonlUsageImporter';

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

describe('CodexJsonlUsageImporter', () => {
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
