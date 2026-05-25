import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { describe, expect, it } from 'vitest';

import {
  analyzeSessionFileMetadata,
  calculateMetrics,
  countJsonlFileWithStats,
  parseJsonlFile,
  parseJsonlFileWithStats,
  parseJsonlLine,
} from '../../../src/main/utils/jsonl';

import type { ParsedMessage } from '../../../src/main/types';

// Helper to create a minimal ParsedMessage
function createMessage(overrides: Partial<ParsedMessage> = {}): ParsedMessage {
  return {
    uuid: 'test-uuid',
    parentUuid: null,
    type: 'assistant',
    timestamp: new Date('2024-01-01T10:00:00Z'),
    content: '',
    isSidechain: false,
    isMeta: false,
    isCompactSummary: false,
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

describe('jsonl', () => {
  describe('calculateMetrics', () => {
    it('should return empty metrics for empty messages array', () => {
      const result = calculateMetrics([]);
      expect(result.durationMs).toBe(0);
      expect(result.totalTokens).toBe(0);
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.messageCount).toBe(0);
    });

    it('should calculate total tokens from usage', () => {
      const messages = [
        createMessage({
          usage: {
            input_tokens: 100,
            output_tokens: 50,
          },
        }),
      ];

      const result = calculateMetrics(messages);
      expect(result.inputTokens).toBe(100);
      expect(result.outputTokens).toBe(50);
      expect(result.totalTokens).toBe(150);
    });

    it('should sum tokens across multiple messages', () => {
      const messages = [
        createMessage({
          usage: { input_tokens: 100, output_tokens: 50 },
        }),
        createMessage({
          usage: { input_tokens: 200, output_tokens: 100 },
        }),
      ];

      const result = calculateMetrics(messages);
      expect(result.inputTokens).toBe(300);
      expect(result.outputTokens).toBe(150);
      expect(result.totalTokens).toBe(450);
    });

    it('should handle cache tokens', () => {
      const messages = [
        createMessage({
          usage: {
            input_tokens: 100,
            output_tokens: 50,
            cache_read_input_tokens: 25,
            cache_creation_input_tokens: 10,
          },
        }),
      ];

      const result = calculateMetrics(messages);
      expect(result.cacheReadTokens).toBe(25);
      expect(result.cacheCreationTokens).toBe(10);
      expect(result.totalTokens).toBe(185); // 100 + 50 + 25 + 10
    });

    it('should calculate duration from timestamps', () => {
      const messages = [
        createMessage({ timestamp: new Date('2024-01-01T10:00:00Z') }),
        createMessage({ timestamp: new Date('2024-01-01T10:01:00Z') }),
        createMessage({ timestamp: new Date('2024-01-01T10:02:00Z') }),
      ];

      const result = calculateMetrics(messages);
      expect(result.durationMs).toBe(120000); // 2 minutes in ms
    });

    it('should count messages', () => {
      const messages = [createMessage(), createMessage(), createMessage()];

      const result = calculateMetrics(messages);
      expect(result.messageCount).toBe(3);
    });

    it('should handle messages without usage', () => {
      const messages = [
        createMessage({ type: 'user', content: 'Hello' }),
        createMessage({ type: 'system' }),
      ];

      const result = calculateMetrics(messages);
      expect(result.totalTokens).toBe(0);
      expect(result.messageCount).toBe(2);
    });

    it('should handle single message duration', () => {
      const messages = [createMessage({ timestamp: new Date('2024-01-01T10:00:00Z') })];

      const result = calculateMetrics(messages);
      expect(result.durationMs).toBe(0); // min === max
    });

    it('should handle undefined token values', () => {
      const messages = [
        createMessage({
          usage: {
            input_tokens: undefined as unknown as number,
            output_tokens: 50,
          },
        }),
      ];

      const result = calculateMetrics(messages);
      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(50);
    });
  });

  describe('analyzeSessionFileMetadata', () => {
    it('should extract first message, count, ongoing state, and git branch in one pass', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-meta-'));
      try {
        const filePath = path.join(tempDir, 'session.jsonl');
        const lines = [
          JSON.stringify({
            type: 'user',
            uuid: 'u1',
            timestamp: '2026-01-01T00:00:00.000Z',
            gitBranch: 'feature/test',
            message: { role: 'user', content: 'hello world' },
            isMeta: false,
          }),
          JSON.stringify({
            type: 'assistant',
            uuid: 'a1',
            timestamp: '2026-01-01T00:00:01.000Z',
            message: {
              role: 'assistant',
              content: [{ type: 'thinking', thinking: 'thinking...' }],
            },
          }),
        ];
        fs.writeFileSync(filePath, `${lines.join('\n')}\n`, 'utf8');

        const result = await analyzeSessionFileMetadata(filePath);

        expect(result.firstUserMessage?.text).toBe('hello world');
        expect(result.firstUserMessage?.timestamp).toBe('2026-01-01T00:00:00.000Z');
        expect(result.messageCount).toBe(2);
        expect(result.isOngoing).toBe(true);
        expect(result.gitBranch).toBe('feature/test');
      } finally {
        try {
          fs.rmSync(tempDir, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 200,
          });
        } catch {
          // Best-effort cleanup; ignore ENOTEMPTY on Windows when dir is in use
        }
      }
    });
  });

  describe('tolerant parsing', () => {
    it('counts parseable entries without retaining messages', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-count-'));
      try {
        const filePath = path.join(tempDir, 'session.jsonl');
        const validAssistant = JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
          },
        });
        const validSystem = JSON.stringify({
          type: 'system',
          uuid: 's1',
          timestamp: '2026-01-01T00:00:02.000Z',
          content: 'system line',
        });
        const invalidMissingMessage = JSON.stringify({
          type: 'assistant',
          uuid: 'bad-assistant',
        });
        const unknownType = JSON.stringify({
          type: 'unknown',
          uuid: 'unknown-1',
        });
        const partialJson =
          '{"type":"assistant","uuid":"a2","timestamp":"2026-01-01T00:00:03.000Z","message":{"role":"assistant","content":[{"type":"text","text":"partial"';

        fs.writeFileSync(
          filePath,
          [
            validAssistant,
            validSystem,
            invalidMissingMessage,
            unknownType,
            'not json',
            partialJson,
          ].join('\n'),
          'utf8'
        );

        const parsed = await parseJsonlFileWithStats(filePath);
        const counted = await countJsonlFileWithStats(filePath);

        expect(parsed.messages.map((message) => message.uuid)).toEqual(['a1', 's1']);
        expect(counted.parsedLineCount).toBe(parsed.parsedLineCount);
        expect(counted.consumedBytes).toBe(parsed.consumedBytes);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('skips non-JSON garbage and ignores a partial trailing object', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'jsonl-tolerant-'));
      try {
        const filePath = path.join(tempDir, 'session.jsonl');
        const validLine = JSON.stringify({
          type: 'assistant',
          uuid: 'a1',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'hello' }],
          },
        });
        const nonJsonGarbage = '╨╕┬аAI-╤А╨░╨╖╤А╨░╨▒';
        const partialJson =
          '{"type":"assistant","uuid":"a2","timestamp":"2026-01-01T00:00:02.000Z","message":{"role":"assistant","content":[{"type":"text","text":"partial"';

        fs.writeFileSync(filePath, `${validLine}\n${nonJsonGarbage}\n${partialJson}`, 'utf8');

        const result = await parseJsonlFile(filePath);

        expect(result).toHaveLength(1);
        expect(result[0]?.uuid).toBe('a1');
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('strips a UTF-8 BOM before parsing an object line', () => {
      const parsed = parseJsonlLine(
        `\ufeff${JSON.stringify({
          type: 'assistant',
          uuid: 'bom-1',
          timestamp: '2026-01-01T00:00:01.000Z',
          message: {
            role: 'assistant',
            content: [{ type: 'text', text: 'bom' }],
          },
        })}`
      );

      expect(parsed?.uuid).toBe('bom-1');
    });

    it('preserves real transcript metadata needed by task-log fallback selection', () => {
      const parsed = parseJsonlLine(
        JSON.stringify({
          parentUuid: 'assistant-1',
          isSidechain: false,
          userType: 'external',
          cwd: '/tmp/project',
          sessionId: 'session-real-1',
          version: '1.0.0',
          gitBranch: 'main',
          type: 'user',
          uuid: 'user-real-1',
          timestamp: '2026-04-12T15:36:14.250Z',
          agentName: 'tom',
          isMeta: true,
          sourceToolAssistantUUID: 'assistant-1',
          sourceToolUseID: 'call-bash-real',
          toolUseResult: {
            toolUseId: 'call-bash-real',
            stdout: 'tests ok',
            exitCode: 0,
          },
          message: {
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'call-bash-real',
                content: 'tests ok',
              },
            ],
          },
        }),
      );

      expect(parsed?.sessionId).toBe('session-real-1');
      expect(parsed?.agentName).toBe('tom');
      expect(parsed?.isMeta).toBe(true);
      expect(parsed?.sourceToolAssistantUUID).toBe('assistant-1');
      expect(parsed?.sourceToolUseID).toBe('call-bash-real');
      expect(parsed?.toolResults[0]?.toolUseId).toBe('call-bash-real');
    });

    it('parses codex-native projected assistant rows with usage intact', () => {
      const parsed = parseJsonlLine(
        JSON.stringify({
          parentUuid: 'user-1',
          isSidechain: false,
          userType: 'external',
          cwd: '/tmp/project',
          sessionId: 'session-native-1',
          version: '1.0.0',
          gitBranch: 'main',
          type: 'assistant',
          uuid: 'assistant-native-1',
          requestId: 'native-request-1',
          timestamp: '2026-04-19T10:00:00.000Z',
          message: {
            role: 'assistant',
            model: 'gpt-5-codex',
            id: 'msg-native-1',
            type: 'message',
            stop_reason: 'end_turn',
            stop_sequence: null,
            usage: {
              input_tokens: 12,
              cache_read_input_tokens: 4,
              output_tokens: 2,
            },
            content: [{ type: 'text', text: 'OK' }],
          },
        }),
      );

      expect(parsed).toMatchObject({
        uuid: 'assistant-native-1',
        type: 'assistant',
        content: [{ type: 'text', text: 'OK' }],
        requestId: 'native-request-1',
        usage: {
          input_tokens: 12,
          cache_read_input_tokens: 4,
          output_tokens: 2,
        },
      });
    });

    it('parses modern system warning rows without dropping content or severity', () => {
      const parsed = parseJsonlLine(
        JSON.stringify({
          parentUuid: null,
          isSidechain: false,
          userType: 'external',
          cwd: '/tmp/project',
          sessionId: 'session-native-1',
          version: '1.0.0',
          gitBranch: 'main',
          type: 'system',
          uuid: 'system-native-warning-1',
          timestamp: '2026-04-19T10:00:01.000Z',
          subtype: 'informational',
          level: 'warning',
          isMeta: false,
          content: 'native stderr warning',
        }),
      );

      expect(parsed).toMatchObject({
        uuid: 'system-native-warning-1',
        type: 'system',
        content: 'native stderr warning',
        level: 'warning',
        subtype: 'informational',
        isMeta: false,
      });
    });

    it('parses codex-native execution-summary and warning metadata from projected system rows', () => {
      const warningParsed = parseJsonlLine(
        JSON.stringify({
          parentUuid: null,
          isSidechain: false,
          userType: 'external',
          cwd: '/tmp/project',
          sessionId: 'session-native-warning',
          version: '1.0.0',
          gitBranch: 'main',
          type: 'system',
          uuid: 'system-native-warning-2',
          timestamp: '2026-04-19T10:00:02.000Z',
          subtype: 'codex_native_warning',
          level: 'warning',
          isMeta: false,
          content: 'thread/read failed while backfilling turn items for turn completion',
          codexNativeWarningSource: 'history',
        }),
      );

      expect(warningParsed).toMatchObject({
        uuid: 'system-native-warning-2',
        subtype: 'codex_native_warning',
        codexNativeWarningSource: 'history',
      });

      const summaryParsed = parseJsonlLine(
        JSON.stringify({
          parentUuid: null,
          isSidechain: false,
          userType: 'external',
          cwd: '/tmp/project',
          sessionId: 'session-native-summary',
          version: '1.0.0',
          gitBranch: 'main',
          type: 'system',
          uuid: 'system-native-summary-1',
          timestamp: '2026-04-19T10:00:03.000Z',
          subtype: 'codex_native_execution_summary',
          level: 'info',
          isMeta: false,
          content:
            'Codex native execution summary: thread=thread-ephemeral, completion=ephemeral, history=live-only, usageAuthority=live-turn-completed, binary=codex-cli 0.117.0',
          codexNativeThreadId: 'thread-ephemeral',
          codexNativeCompletionPolicy: 'ephemeral',
          codexNativeHistoryCompleteness: 'live-only',
          codexNativeFinalUsageAuthority: 'live-turn-completed',
          codexNativeExecutablePath: '/usr/local/bin/codex',
          codexNativeExecutableSource: 'system-path',
          codexNativeExecutableVersion: 'codex-cli 0.117.0',
        }),
      );

      expect(summaryParsed).toMatchObject({
        uuid: 'system-native-summary-1',
        subtype: 'codex_native_execution_summary',
        codexNativeThreadId: 'thread-ephemeral',
        codexNativeCompletionPolicy: 'ephemeral',
        codexNativeHistoryCompleteness: 'live-only',
        codexNativeFinalUsageAuthority: 'live-turn-completed',
        codexNativeExecutableSource: 'system-path',
        codexNativeExecutableVersion: 'codex-cli 0.117.0',
      });
    });
  });
});
