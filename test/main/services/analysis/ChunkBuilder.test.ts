/**
 * Tests for ChunkBuilder service.
 *
 * Tests chunk building from parsed messages:
 * - UserChunk creation from user messages
 * - AIChunk creation from assistant messages (with tool grouping)
 * - SystemChunk creation from command output
 * - Subagent linking to AIChunks
 */

import { describe, expect, it } from 'vitest';

import { ChunkBuilder } from '../../../../src/main/services/analysis/ChunkBuilder';
import { isAIChunk, isCompactChunk, isSystemChunk, isUserChunk } from '../../../../src/main/types';
import type { ParsedMessage, Process } from '../../../../src/main/types';

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

/**
 * Creates a minimal Process (subagent) for testing.
 */
function createSubagent(overrides: Partial<Process>): Process {
  return {
    id: `agent-${Math.random().toString(36).slice(2, 11)}`,
    filePath: '/path/to/agent.jsonl',
    parentTaskId: 'task-1',
    description: 'Test subagent',
    startTime: new Date(),
    endTime: new Date(),
    durationMs: 1000,
    isOngoing: false,
    isParallel: false,
    messages: [],
    metrics: {
      inputTokens: 100,
      outputTokens: 50,
      cacheReadTokens: 0,
      cacheCreationTokens: 0,
      totalTokens: 150,
      messageCount: 2,
      durationMs: 1000,
    },
    ...overrides,
  };
}

// =============================================================================
// Tests
// =============================================================================

describe('ChunkBuilder', () => {
  const builder = new ChunkBuilder();

  describe('buildChunks', () => {
    it('should return empty array for empty input', () => {
      const chunks = builder.buildChunks([]);
      expect(chunks).toEqual([]);
    });

    it('should filter out sidechain messages', () => {
      const messages = [
        createMessage({
          type: 'user',
          content: 'Main thread message',
          isMeta: false,
          isSidechain: false,
        }),
        createMessage({
          type: 'assistant',
          content: [{ type: 'text', text: 'Sidechain response' }],
          isSidechain: true,
        }),
      ];

      const chunks = builder.buildChunks(messages);
      // Only the main thread user message should create a chunk
      expect(chunks).toHaveLength(1);
      expect(isUserChunk(chunks[0])).toBe(true);
    });

    it('should include sidechain messages when requested (subagent files)', () => {
      const messages = [
        createMessage({
          type: 'user',
          content: 'Subagent input',
          isSidechain: true,
        }),
        createMessage({
          type: 'assistant',
          content: [{ type: 'text', text: 'Subagent output' }],
          isSidechain: true,
        }),
      ];

      const chunks = builder.buildChunks(messages, [], { includeSidechain: true });
      expect(chunks.length).toBeGreaterThan(0);
      expect(chunks.some((c) => isUserChunk(c))).toBe(true);
      expect(chunks.some((c) => isAIChunk(c))).toBe(true);
    });

    describe('UserChunk creation', () => {
      it('should create UserChunk from real user message', () => {
        const messages = [
          createMessage({
            type: 'user',
            content: 'Help me debug this',
            isMeta: false,
          }),
        ];

        const chunks = builder.buildChunks(messages);
        expect(chunks).toHaveLength(1);
        expect(isUserChunk(chunks[0])).toBe(true);

        if (isUserChunk(chunks[0])) {
          expect(chunks[0].userMessage.content).toBe('Help me debug this');
        }
      });

      it('should create UserChunk with array content', () => {
        const messages = [
          createMessage({
            type: 'user',
            content: [{ type: 'text', text: 'Hello world' }],
            isMeta: false,
          }),
        ];

        const chunks = builder.buildChunks(messages);
        expect(chunks).toHaveLength(1);
        expect(isUserChunk(chunks[0])).toBe(true);
      });
    });

    describe('AIChunk creation', () => {
      it('should create AIChunk from assistant message', () => {
        const messages = [
          createMessage({
            type: 'assistant',
            content: [{ type: 'text', text: "Here's how to fix it" }],
          }),
        ];

        const chunks = builder.buildChunks(messages);
        expect(chunks).toHaveLength(1);
        expect(isAIChunk(chunks[0])).toBe(true);

        if (isAIChunk(chunks[0])) {
          expect(chunks[0].responses).toHaveLength(1);
        }
      });

      it('should group consecutive assistant messages into one AIChunk', () => {
        const messages = [
          createMessage({
            type: 'assistant',
            content: [{ type: 'text', text: 'First response' }],
          }),
          createMessage({
            type: 'assistant',
            content: [{ type: 'text', text: 'Second response' }],
          }),
        ];

        const chunks = builder.buildChunks(messages);
        expect(chunks).toHaveLength(1);
        expect(isAIChunk(chunks[0])).toBe(true);

        if (isAIChunk(chunks[0])) {
          expect(chunks[0].responses).toHaveLength(2);
        }
      });

      it('should include tool results in AIChunk', () => {
        const messages = [
          createMessage({
            type: 'assistant',
            content: [
              { type: 'text', text: 'Reading file' },
              { type: 'tool_use', id: 't1', name: 'Read', input: { file_path: 'test.ts' } },
            ],
            toolCalls: [{ id: 't1', name: 'Read', input: { file_path: 'test.ts' }, isTask: false }],
          }),
          createMessage({
            type: 'user',
            content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file contents' }],
            isMeta: true,
          }),
          createMessage({
            type: 'assistant',
            content: [{ type: 'text', text: 'Found the issue' }],
          }),
        ];

        const chunks = builder.buildChunks(messages);
        // All should be in one AIChunk
        expect(chunks).toHaveLength(1);
        expect(isAIChunk(chunks[0])).toBe(true);

        if (isAIChunk(chunks[0])) {
          // 2 assistant messages + 1 tool result
          expect(chunks[0].responses.length).toBeGreaterThanOrEqual(2);
        }
      });
    });

    describe('SystemChunk creation', () => {
      it('should create SystemChunk from command output', () => {
        const messages = [
          createMessage({
            type: 'user',
            content: '<local-command-stdout>Model set to sonnet</local-command-stdout>',
            isMeta: false,
          }),
        ];

        const chunks = builder.buildChunks(messages);
        expect(chunks).toHaveLength(1);
        expect(isSystemChunk(chunks[0])).toBe(true);

        if (isSystemChunk(chunks[0])) {
          expect(chunks[0].commandOutput).toContain('Model set to sonnet');
        }
      });
    });

    describe('CompactChunk creation', () => {
      it('should create CompactChunk from compact summary', () => {
        const messages = [
          createMessage({
            type: 'user',
            content: 'Summary of conversation...',
            isCompactSummary: true,
          }),
        ];

        const chunks = builder.buildChunks(messages);
        expect(chunks).toHaveLength(1);
        expect(isCompactChunk(chunks[0])).toBe(true);
      });
    });

    describe('hardNoise filtering', () => {
      it('should filter out system messages', () => {
        const messages = [
          createMessage({
            type: 'system',
            content: 'System prompt',
          }),
        ];

        const chunks = builder.buildChunks(messages);
        expect(chunks).toHaveLength(0);
      });

      it('should filter out synthetic assistant messages', () => {
        const messages = [
          createMessage({
            type: 'assistant',
            content: '',
            model: '<synthetic>',
          }),
        ];

        const chunks = builder.buildChunks(messages);
        expect(chunks).toHaveLength(0);
      });

      it('should filter out caveat messages', () => {
        const messages = [
          createMessage({
            type: 'user',
            content: '<local-command-caveat>This is a caveat</local-command-caveat>',
          }),
        ];

        const chunks = builder.buildChunks(messages);
        expect(chunks).toHaveLength(0);
      });
    });

    describe('AIChunk flushing', () => {
      it('should flush AIChunk buffer when user message arrives', () => {
        const messages = [
          createMessage({
            type: 'assistant',
            content: [{ type: 'text', text: 'Response 1' }],
          }),
          createMessage({
            type: 'user',
            content: 'New question',
            isMeta: false,
          }),
          createMessage({
            type: 'assistant',
            content: [{ type: 'text', text: 'Response 2' }],
          }),
        ];

        const chunks = builder.buildChunks(messages);
        expect(chunks).toHaveLength(3);
        expect(isAIChunk(chunks[0])).toBe(true);
        expect(isUserChunk(chunks[1])).toBe(true);
        expect(isAIChunk(chunks[2])).toBe(true);
      });

      it('should flush AIChunk buffer when system message arrives', () => {
        const messages = [
          createMessage({
            type: 'assistant',
            content: [{ type: 'text', text: 'Response' }],
          }),
          createMessage({
            type: 'user',
            content: '<local-command-stdout>Output</local-command-stdout>',
            isMeta: false,
          }),
        ];

        const chunks = builder.buildChunks(messages);
        expect(chunks).toHaveLength(2);
        expect(isAIChunk(chunks[0])).toBe(true);
        expect(isSystemChunk(chunks[1])).toBe(true);
      });
    });

    describe('subagent linking', () => {
      it('should link subagent to AIChunk containing Task call', () => {
        const taskId = 'task-123';
        const messages = [
          createMessage({
            type: 'assistant',
            content: [
              { type: 'text', text: 'Spawning agent' },
              {
                type: 'tool_use',
                id: taskId,
                name: 'Task',
                input: { prompt: 'Do something', subagent_type: 'explore' },
              },
            ],
            toolCalls: [
              {
                id: taskId,
                name: 'Task',
                input: { prompt: 'Do something', subagent_type: 'explore' },
                isTask: true,
                taskDescription: 'Do something',
                taskSubagentType: 'explore',
              },
            ],
          }),
        ];

        const subagent = createSubagent({
          parentTaskId: taskId,
        });

        const chunks = builder.buildChunks(messages, [subagent]);
        expect(chunks).toHaveLength(1);
        expect(isAIChunk(chunks[0])).toBe(true);

        if (isAIChunk(chunks[0])) {
          expect(chunks[0].processes).toHaveLength(1);
          expect(chunks[0].processes[0].id).toBe(subagent.id);
        }
      });
    });
  });

  describe('getTotalChunkMetrics', () => {
    it('should return empty metrics for empty chunks', () => {
      const metrics = builder.getTotalChunkMetrics([]);
      expect(metrics.totalTokens).toBe(0);
      expect(metrics.durationMs).toBe(0);
      expect(metrics.messageCount).toBe(0);
    });
  });

  describe('buildSessionDetail', () => {
    it('should build complete session detail', () => {
      const session = {
        id: 'session-1',
        projectId: 'project-1',
        projectPath: '/path/to/project',
        filePath: '/path/to/session.jsonl',
        timestamp: new Date(),
        lastModified: new Date(),
        isOngoing: false,
        hasSubagents: false,
        messageCount: 0,
        createdAt: Date.now(),
      };

      const messages = [
        createMessage({
          type: 'user',
          content: 'Hello',
          isMeta: false,
        }),
        createMessage({
          type: 'assistant',
          content: [{ type: 'text', text: 'Hi' }],
        }),
      ];

      const detail = builder.buildSessionDetail(session, messages, []);

      expect(detail.session).toBe(session);
      expect(detail.messages).toBe(messages);
      expect(detail.chunks.length).toBeGreaterThan(0);
      expect(detail.processes).toEqual([]);
      expect(detail.metrics).toBeDefined();
    });
  });

  describe('buildWaterfallData', () => {
    it('should build sorted waterfall items from chunks and subagents', () => {
      const start = new Date('2026-01-01T00:00:00.000Z');
      const end = new Date('2026-01-01T00:00:10.000Z');

      const messages = [
        createMessage({
          type: 'assistant',
          timestamp: start,
          content: [{ type: 'text', text: 'Running tools' }],
          toolCalls: [{ id: 'tool-1', name: 'Read', input: {}, isTask: false }],
        }),
        createMessage({
          type: 'user',
          timestamp: end,
          isMeta: true,
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'done' }],
        }),
      ];

      const subagent = createSubagent({
        id: 'agent-1',
        startTime: new Date('2026-01-01T00:00:03.000Z'),
        endTime: new Date('2026-01-01T00:00:08.000Z'),
        durationMs: 5000,
      });

      const chunks = builder.buildChunks(messages, [subagent]);
      const waterfall = builder.buildWaterfallData(chunks, [subagent]);

      expect(waterfall.items.length).toBeGreaterThan(0);
      expect(waterfall.totalDurationMs).toBeGreaterThanOrEqual(0);
      expect(waterfall.minTime.getTime()).toBeLessThanOrEqual(waterfall.maxTime.getTime());
      expect(waterfall.items.some((item) => item.type === 'subagent')).toBe(true);
    });
  });
});
