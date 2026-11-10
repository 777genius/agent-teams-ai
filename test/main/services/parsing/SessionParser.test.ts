/**
 * Tests for SessionParser service.
 *
 * Tests parsing functionality:
 * - Message type grouping
 * - Sidechain vs main thread separation
 * - Task call extraction
 * - Tool result linking
 * - Time range calculation
 */

import { LocalFileSystemProvider } from '@main/services/infrastructure/LocalFileSystemProvider';
import {
  type ParsedSession,
  SessionParser,
} from '@main/services/parsing/SessionParser';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { ParsedMessage } from '@main/types';

// =============================================================================
// Mock ProjectScanner
// =============================================================================

const mockProjectScanner = {
  scan: vi.fn(),
  getSessionPath: vi.fn(),
  listSessionsPaginated: vi.fn(),
  listSessions: vi.fn(),
  listSubagentFiles: vi.fn(),
  getSession: vi.fn(),
  listWorktreeSessions: vi.fn(),
  scanWithWorktreeGrouping: vi.fn(),
  getFileSystemProvider: vi.fn().mockReturnValue(new LocalFileSystemProvider()),
};

// =============================================================================
// Test Helpers
// =============================================================================

/**
 * Creates a minimal ParsedMessage for testing.
 */
function createMessage(overrides: Partial<ParsedMessage>): ParsedMessage {
  return {
    uuid: `msg-${Math.random().toString(36).slice(2, 11)}`,
    parentUuid: null,
    type: 'user',
    timestamp: new Date(),
    content: '',
    isSidechain: false,
    isMeta: false,
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('SessionParser', () => {
  let parser: SessionParser;

  beforeEach(() => {
    vi.clearAllMocks();
    // @ts-expect-error - Using partial mock
    parser = new SessionParser(mockProjectScanner);
  });

  describe('processMessages (via public methods)', () => {
    // Since processMessages is private, we test its behavior through the query methods

    describe('message type grouping', () => {
      it('should group user messages correctly', () => {
        const messages = [
          createMessage({ type: 'user', content: 'User message 1' }),
          createMessage({ type: 'assistant', content: [{ type: 'text', text: 'Response' }] }),
          createMessage({ type: 'user', content: 'User message 2' }),
        ];

        // Access processMessages result through getUserMessages
        const processedResult = {
          messages,
          metrics: {
            durationMs: 0,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            messageCount: messages.length,
          },
          taskCalls: [],
          byType: {
            user: messages.filter((m) => m.type === 'user'),
            realUser: messages.filter((m) => m.type === 'user' && !m.isMeta),
            internalUser: messages.filter((m) => m.type === 'user' && m.isMeta),
            assistant: messages.filter((m) => m.type === 'assistant'),
            system: [],
            other: [],
          },
          sidechainMessages: [],
          mainMessages: messages,
        };

        const userMessages = parser.getUserMessages(processedResult);
        expect(userMessages).toHaveLength(2);
      });

      it('should separate real user vs internal user messages', () => {
        const messages = [
          createMessage({ type: 'user', content: 'Real user input', isMeta: false }),
          createMessage({
            type: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'result' }],
            isMeta: true,
          }),
        ];

        const processedResult: ParsedSession = {
          messages,
          metrics: {
            durationMs: 0,
            totalTokens: 0,
            inputTokens: 0,
            outputTokens: 0,
            cacheReadTokens: 0,
            cacheCreationTokens: 0,
            messageCount: messages.length,
          },
          taskCalls: [],
          byType: {
            user: messages.filter((m) => m.type === 'user'),
            realUser: messages.filter((m) => m.type === 'user' && !m.isMeta),
            internalUser: messages.filter((m) => m.type === 'user' && m.isMeta),
            assistant: [],
            system: [],
            other: [],
          },
          sidechainMessages: [],
          mainMessages: messages,
        };

        expect(processedResult.byType.realUser).toHaveLength(1);
        expect(processedResult.byType.internalUser).toHaveLength(1);
      });
    });

    describe('sidechain separation', () => {
      it('should separate sidechain from main thread messages', () => {
        const messages = [
          createMessage({ type: 'user', content: 'Main', isSidechain: false }),
          createMessage({
            type: 'assistant',
            content: [{ type: 'text', text: 'Sidechain' }],
            isSidechain: true,
          }),
          createMessage({
            type: 'assistant',
            content: [{ type: 'text', text: 'Main' }],
            isSidechain: false,
          }),
        ];

        const sidechainMessages = messages.filter((m) => m.isSidechain);
        const mainMessages = messages.filter((m) => !m.isSidechain);

        expect(sidechainMessages).toHaveLength(1);
        expect(mainMessages).toHaveLength(2);
      });
    });
  });

  describe('parseSessionFile', () => {
    it('keeps codex-native projected assistant usage and modern system warnings parseable', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-parser-native-'));
      const filePath = path.join(tempDir, 'native-session.jsonl');

      try {
        fs.writeFileSync(
          filePath,
          [
            JSON.stringify({
              parentUuid: null,
              isSidechain: false,
              userType: 'external',
              cwd: '/tmp/project',
              sessionId: 'session-native-parse',
              version: '1.0.0',
              gitBranch: 'main',
              type: 'system',
              uuid: 'system-native-warning-1',
              timestamp: '2026-04-19T10:00:00.000Z',
              subtype: 'codex_native_warning',
              level: 'warning',
              isMeta: false,
              content: 'native stderr warning',
              codexNativeWarningSource: 'process',
            }),
            JSON.stringify({
              parentUuid: 'user-native-1',
              isSidechain: false,
              userType: 'external',
              cwd: '/tmp/project',
              sessionId: 'session-native-parse',
              version: '1.0.0',
              gitBranch: 'main',
              type: 'assistant',
              uuid: 'assistant-native-1',
              requestId: 'native-request-1',
              timestamp: '2026-04-19T10:00:01.000Z',
              message: {
                role: 'assistant',
                model: 'gpt-5.4-mini',
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
          ].join('\n'),
          'utf8',
        );

        const parsed = await parser.parseSessionFile(filePath);

        expect(parsed.byType.system).toMatchObject([
          {
            uuid: 'system-native-warning-1',
            content: 'native stderr warning',
            level: 'warning',
            subtype: 'codex_native_warning',
            codexNativeWarningSource: 'process',
          },
        ]);
        expect(parsed.byType.assistant).toMatchObject([
          {
            uuid: 'assistant-native-1',
            requestId: 'native-request-1',
            usage: {
              input_tokens: 12,
              cache_read_input_tokens: 4,
              output_tokens: 2,
            },
          },
        ]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it('keeps codex-native execution summary metadata parseable for replay and history truth', async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'session-parser-native-summary-'));
      const filePath = path.join(tempDir, 'native-summary-session.jsonl');

      try {
        fs.writeFileSync(
          filePath,
          [
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
              timestamp: '2026-04-19T10:00:02.000Z',
              subtype: 'codex_native_execution_summary',
              level: 'info',
              isMeta: false,
              content:
                'Codex native execution summary: thread=thread-persistent, completion=persistent, history=explicit-hydration-required, usageAuthority=live-turn-completed, binary=codex-cli 0.117.0',
              codexNativeThreadId: 'thread-persistent',
              codexNativeCompletionPolicy: 'persistent',
              codexNativeHistoryCompleteness: 'explicit-hydration-required',
              codexNativeFinalUsageAuthority: 'live-turn-completed',
              codexNativeExecutablePath: '/usr/local/bin/codex',
              codexNativeExecutableSource: 'system-path',
              codexNativeExecutableVersion: 'codex-cli 0.117.0',
            }),
          ].join('\n'),
          'utf8',
        );

        const parsed = await parser.parseSessionFile(filePath);

        expect(parsed.byType.system).toMatchObject([
          {
            uuid: 'system-native-summary-1',
            subtype: 'codex_native_execution_summary',
            codexNativeThreadId: 'thread-persistent',
            codexNativeCompletionPolicy: 'persistent',
            codexNativeHistoryCompleteness: 'explicit-hydration-required',
            codexNativeExecutableSource: 'system-path',
            codexNativeExecutableVersion: 'codex-cli 0.117.0',
          },
        ]);
      } finally {
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    });
  });

  describe('getResponses', () => {
    it('should get assistant responses after user message', () => {
      const userMsgUuid = 'user-1';
      const messages = [
        createMessage({ uuid: userMsgUuid, type: 'user', content: 'Question' }),
        createMessage({
          uuid: 'asst-1',
          type: 'assistant',
          content: [{ type: 'text', text: 'Answer 1' }],
        }),
        createMessage({
          uuid: 'asst-2',
          type: 'assistant',
          content: [{ type: 'text', text: 'Answer 2' }],
        }),
        createMessage({ uuid: 'user-2', type: 'user', content: 'Next question' }),
      ];

      const responses = parser.getResponses(messages, userMsgUuid);
      expect(responses).toHaveLength(2);
      expect(responses[0].uuid).toBe('asst-1');
      expect(responses[1].uuid).toBe('asst-2');
    });

    it('should stop at next user message', () => {
      const userMsgUuid = 'user-1';
      const messages = [
        createMessage({ uuid: userMsgUuid, type: 'user', content: 'Q1' }),
        createMessage({
          uuid: 'asst-1',
          type: 'assistant',
          content: [{ type: 'text', text: 'A1' }],
        }),
        createMessage({ uuid: 'user-2', type: 'user', content: 'Q2' }),
        createMessage({
          uuid: 'asst-2',
          type: 'assistant',
          content: [{ type: 'text', text: 'A2' }],
        }),
      ];

      const responses = parser.getResponses(messages, userMsgUuid);
      expect(responses).toHaveLength(1);
      expect(responses[0].uuid).toBe('asst-1');
    });

    it('should not stop at structured non-human user-role messages', () => {
      const userMsgUuid = 'user-1';
      const messages = [
        createMessage({ uuid: userMsgUuid, type: 'user', content: 'Q1' }),
        createMessage({
          uuid: 'protocol-1',
          type: 'user',
          content: '<teammate-message teammate_id="alice">Looks good</teammate-message>',
          protocolKind: 'teammate-message',
          origin: { kind: 'teammate' },
          isSynthetic: true,
        }),
        createMessage({
          uuid: 'asst-1',
          type: 'assistant',
          content: [{ type: 'text', text: 'A1' }],
        }),
        createMessage({
          uuid: 'coordinator-1',
          type: 'user',
          content: 'queued coordination update',
          origin: { kind: 'coordinator' },
          isMeta: true,
          isSynthetic: true,
        }),
        createMessage({
          uuid: 'asst-2',
          type: 'assistant',
          content: [{ type: 'text', text: 'A2' }],
        }),
        createMessage({ uuid: 'user-2', type: 'user', content: 'Q2' }),
        createMessage({
          uuid: 'asst-3',
          type: 'assistant',
          content: [{ type: 'text', text: 'A3' }],
        }),
      ];

      const responses = parser.getResponses(messages, userMsgUuid);
      expect(responses.map((message) => message.uuid)).toEqual(['asst-1', 'asst-2']);
    });

    it('should return empty for non-existent message', () => {
      const messages = [createMessage({ uuid: 'user-1', type: 'user', content: 'Q' })];

      const responses = parser.getResponses(messages, 'non-existent');
      expect(responses).toEqual([]);
    });
  });

  describe('getTaskCalls', () => {
    it('should extract Task tool calls from messages', () => {
      const messages = [
        createMessage({
          type: 'assistant',
          content: [
            { type: 'text', text: 'Spawning agent' },
            {
              type: 'tool_use',
              id: 'task-1',
              name: 'Task',
              input: { prompt: 'Do something', subagent_type: 'explore' },
            },
          ],
          toolCalls: [
            {
              id: 'task-1',
              name: 'Task',
              input: { prompt: 'Do something', subagent_type: 'explore' },
              isTask: true,
              taskDescription: 'Do something',
              taskSubagentType: 'explore',
            },
          ],
        }),
        createMessage({
          type: 'assistant',
          content: [
            { type: 'tool_use', id: 'read-1', name: 'Read', input: { file_path: 'test.ts' } },
          ],
          toolCalls: [
            { id: 'read-1', name: 'Read', input: { file_path: 'test.ts' }, isTask: false },
          ],
        }),
      ];

      const taskCalls = parser.getTaskCalls(messages);
      expect(taskCalls).toHaveLength(1);
      expect(taskCalls[0].name).toBe('Task');
      expect(taskCalls[0].isTask).toBe(true);
    });
  });

  describe('getToolCallsByName', () => {
    it('should get tool calls by name', () => {
      const messages = [
        createMessage({
          type: 'assistant',
          toolCalls: [
            { id: 'read-1', name: 'Read', input: { file_path: 'a.ts' }, isTask: false },
            {
              id: 'write-1',
              name: 'Write',
              input: { file_path: 'b.ts', content: '' },
              isTask: false,
            },
            { id: 'read-2', name: 'Read', input: { file_path: 'c.ts' }, isTask: false },
          ],
        }),
      ];

      const readCalls = parser.getToolCallsByName(messages, 'Read');
      expect(readCalls).toHaveLength(2);
      expect(readCalls[0].id).toBe('read-1');
      expect(readCalls[1].id).toBe('read-2');
    });
  });

  describe('findToolResult', () => {
    it('should find tool result by tool call ID', () => {
      const toolCallId = 'tool-1';
      const messages = [
        createMessage({
          type: 'user',
          isMeta: true,
          toolResults: [{ toolUseId: toolCallId, content: 'result content', isError: false }],
        }),
      ];

      const found = parser.findToolResult(messages, toolCallId);
      expect(found).not.toBeNull();
      expect(found?.result.toolUseId).toBe(toolCallId);
      expect(found?.result.content).toBe('result content');
    });

    it('should return null for non-existent tool call', () => {
      const messages = [
        createMessage({
          type: 'user',
          isMeta: true,
          toolResults: [{ toolUseId: 'other-id', content: '', isError: false }],
        }),
      ];

      const found = parser.findToolResult(messages, 'non-existent');
      expect(found).toBeNull();
    });
  });

  describe('getTimeRange', () => {
    it('should calculate time range correctly', () => {
      const start = new Date('2024-01-01T10:00:00Z');
      const end = new Date('2024-01-01T10:05:00Z');
      const messages = [
        createMessage({ timestamp: start }),
        createMessage({ timestamp: new Date('2024-01-01T10:02:00Z') }),
        createMessage({ timestamp: end }),
      ];

      const range = parser.getTimeRange(messages);
      expect(range.start.getTime()).toBe(start.getTime());
      expect(range.end.getTime()).toBe(end.getTime());
      expect(range.durationMs).toBe(5 * 60 * 1000); // 5 minutes
    });

    it('should handle empty messages', () => {
      const range = parser.getTimeRange([]);
      expect(range.durationMs).toBe(0);
    });

    it('should handle single message', () => {
      const timestamp = new Date('2024-01-01T10:00:00Z');
      const messages = [createMessage({ timestamp })];

      const range = parser.getTimeRange(messages);
      expect(range.start.getTime()).toBe(timestamp.getTime());
      expect(range.end.getTime()).toBe(timestamp.getTime());
      expect(range.durationMs).toBe(0);
    });
  });

  describe('buildMessageTree', () => {
    it('should build parent-child tree', () => {
      const messages = [
        createMessage({ uuid: 'root', parentUuid: null }),
        createMessage({ uuid: 'child1', parentUuid: 'root' }),
        createMessage({ uuid: 'child2', parentUuid: 'root' }),
        createMessage({ uuid: 'grandchild', parentUuid: 'child1' }),
      ];

      const tree = parser.buildMessageTree(messages);

      expect(tree.get('root')?.map((m) => m.uuid)).toContain('child1');
      expect(tree.get('root')?.map((m) => m.uuid)).toContain('child2');
      expect(tree.get('child1')?.map((m) => m.uuid)).toContain('grandchild');
    });
  });

  describe('getChildMessages', () => {
    it('should get direct children', () => {
      const messages = [
        createMessage({ uuid: 'parent', parentUuid: null }),
        createMessage({ uuid: 'child1', parentUuid: 'parent' }),
        createMessage({ uuid: 'child2', parentUuid: 'parent' }),
        createMessage({ uuid: 'other', parentUuid: 'other-parent' }),
      ];

      const children = parser.getChildMessages(messages, 'parent');
      expect(children).toHaveLength(2);
      expect(children.map((m) => m.uuid)).toContain('child1');
      expect(children.map((m) => m.uuid)).toContain('child2');
    });
  });

  describe('extractText', () => {
    it('should extract text from string content', () => {
      const message = createMessage({ content: 'Hello world' });
      expect(parser.extractText(message)).toBe('Hello world');
    });
  });

  describe('getMessagePreview', () => {
    it('should truncate long messages', () => {
      const longText = 'A'.repeat(200);
      const message = createMessage({ content: longText });

      const preview = parser.getMessagePreview(message, 50);
      expect(preview.length).toBe(53); // 50 chars + '...'
      expect(preview.endsWith('...')).toBe(true);
    });

    it('should not truncate short messages', () => {
      const message = createMessage({ content: 'Short' });
      const preview = parser.getMessagePreview(message, 50);
      expect(preview).toBe('Short');
    });
  });
});
