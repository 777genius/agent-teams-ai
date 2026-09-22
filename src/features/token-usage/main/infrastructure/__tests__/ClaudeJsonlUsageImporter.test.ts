import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';

import { ClaudeJsonlUsageImporter } from '../ClaudeJsonlUsageImporter';

import type { TokenUsageRunDto } from '../../../contracts';

function run(overrides: Partial<TokenUsageRunDto> = {}): TokenUsageRunDto {
  return {
    appRunId: 'app-run-1',
    teamName: 'alpha',
    agentId: 'alpha:auditor',
    agentName: 'auditor',
    runtimeKind: 'anthropic',
    providerId: 'anthropic',
    billingMode: 'subscription',
    model: 'claude-haiku-4-5-20251001',
    commandId: 'team-launch:alpha',
    commandInvocationId: 'team-launch:alpha:session-1',
    startedAt: '2026-06-30T00:00:00.000Z',
    status: 'unknown',
    source: 'team_launch_state',
    sources: [
      {
        id: 'source-1',
        appRunId: 'app-run-1',
        sourceType: 'cli_log',
        nativeSessionId: 'session-1',
        discoveredAt: '2026-06-30T00:00:00.000Z',
      },
    ],
    ...overrides,
  };
}

function assistantLine(input: {
  requestId: string;
  messageId: string;
  outputTokens: number;
  timestamp: string;
}): string {
  return JSON.stringify({
    type: 'assistant',
    sessionId: 'session-1',
    requestId: input.requestId,
    timestamp: input.timestamp,
    message: {
      id: input.messageId,
      model: 'claude-haiku-4-5-20251001',
      usage: {
        input_tokens: 10,
        cache_creation_input_tokens: 20,
        cache_read_input_tokens: 30,
        output_tokens: input.outputTokens,
      },
    },
  });
}

describe('ClaudeJsonlUsageImporter', () => {
  it('imports Claude JSONL usage once per request using the final usage record', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'token-usage-claude-jsonl-'));
    try {
      const logPath = path.join(root, 'session-1.jsonl');
      await writeFile(
        logPath,
        [
          assistantLine({
            requestId: 'req-1',
            messageId: 'msg-1',
            outputTokens: 1,
            timestamp: '2026-06-30T00:00:01.000Z',
          }),
          assistantLine({
            requestId: 'req-1',
            messageId: 'msg-1',
            outputTokens: 25,
            timestamp: '2026-06-30T00:00:02.000Z',
          }),
          assistantLine({
            requestId: 'req-2',
            messageId: 'msg-2',
            outputTokens: 3,
            timestamp: '2026-06-30T00:00:03.000Z',
          }),
        ].join('\n')
      );

      const importer = new ClaudeJsonlUsageImporter({ projectsBasePath: root });
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

      expect(events).toHaveLength(2);
      expect(events[0]).toEqual(
        expect.objectContaining({
          requestId: 'req-1',
          teamName: 'alpha',
          agentName: 'auditor',
          billingMode: 'subscription',
          model: 'claude-haiku-4-5-20251001',
          nativeSessionId: 'session-1',
          nativeLogPath: logPath,
          usageSourceKind: 'log_parsed',
        })
      );
      expect(events[0]?.tokens).toEqual(
        expect.objectContaining({
          inputTokens: 10,
          cacheCreationTokens: 20,
          cacheReadTokens: 30,
          outputTokens: 25,
          totalTokens: 85,
        })
      );
      expect(events[0]?.cost.apiEquivalentUsd).toBeGreaterThan(0);
      expect(events[0]?.cost.billableUsd).toBe(0);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('finds Claude JSONL logs by session id when nativeLogPath is absent', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'token-usage-claude-jsonl-index-'));
    try {
      const projectDir = path.join(root, '-sandbox-project');
      await mkdir(projectDir, { recursive: true });
      await writeFile(
        path.join(projectDir, 'session-1.jsonl'),
        `${assistantLine({
          requestId: 'req-1',
          messageId: 'msg-1',
          outputTokens: 4,
          timestamp: '2026-06-30T00:00:01.000Z',
        })}\n`
      );

      const importer = new ClaudeJsonlUsageImporter({ projectsBasePath: root });
      const events = await importer.importUsage([run()]);

      expect(events).toHaveLength(1);
      expect(events[0]?.requestId).toBe('req-1');
      expect(events[0]?.nativeLogPath).toBe(path.join(projectDir, 'session-1.jsonl'));
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
