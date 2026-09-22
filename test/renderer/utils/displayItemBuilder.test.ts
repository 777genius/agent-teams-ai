import {
  buildDisplayItems,
  buildDisplayItemsFromMessages,
} from '@renderer/utils/displayItemBuilder';
import { describe, expect, it } from 'vitest';

import type { SemanticStep } from '@main/types/chunks';
import type { ParsedMessage } from '@main/types/messages';
import type { AIGroupLastOutput } from '@renderer/types/groups';

/**
 * Helper to create a minimal ParsedMessage for testing.
 */
function makeMessage(overrides: Partial<ParsedMessage> & Pick<ParsedMessage, 'type' | 'content'>): ParsedMessage {
  return {
    uuid: `msg-${Math.random().toString(36).slice(2, 8)}`,
    parentUuid: null,
    timestamp: new Date('2025-01-01T00:00:00Z'),
    isMeta: false,
    isSidechain: false,
    toolCalls: [],
    toolResults: [],
    ...overrides,
  } as ParsedMessage;
}

describe('buildDisplayItemsFromMessages', () => {
  describe('subagent tool results with isMeta=false', () => {
    it('should collect tool results from user messages without isMeta field', () => {
      // Simulates real subagent JSONL where user messages with tool_result
      // blocks have isMeta absent (defaults to false after parsing).
      const toolUseId = 'toolu_test123';

      const assistantMsg = makeMessage({
        uuid: 'assistant-1',
        type: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: toolUseId,
            name: 'Bash',
            input: { command: 'echo hello' },
          },
        ],
        timestamp: new Date('2025-01-01T00:00:00Z'),
      });

      // This is the key scenario: user message with tool_result but isMeta: false
      // (simulating subagent JSONL where isMeta field is absent)
      const toolResultMsg = makeMessage({
        uuid: 'user-result-1',
        type: 'user',
        isMeta: false,
        content: [
          {
            type: 'tool_result',
            tool_use_id: toolUseId,
            content: 'hello\n',
            is_error: false,
          },
        ],
        toolResults: [
          {
            toolUseId: toolUseId,
            content: 'hello\n',
            isError: false,
          },
        ],
        timestamp: new Date('2025-01-01T00:00:01Z'),
      });

      const items = buildDisplayItemsFromMessages([assistantMsg, toolResultMsg], []);

      const toolItems = items.filter((item) => item.type === 'tool');
      expect(toolItems).toHaveLength(1);

      const tool = toolItems[0];
      if (tool.type !== 'tool') throw new Error('Expected tool item');

      // The critical assertion: result must be present, not orphaned
      expect(tool.tool.isOrphaned).toBe(false);
      expect(tool.tool.result).toBeDefined();
      expect(tool.tool.result?.content).toBe('hello\n');
      expect(tool.tool.name).toBe('Bash');
    });

    it('should still render subagent_input for plain text user messages without tool results', () => {
      const userMsg = makeMessage({
        uuid: 'user-input-1',
        type: 'user',
        isMeta: false,
        content: 'Please run the tests',
        toolResults: [],
        timestamp: new Date('2025-01-01T00:00:00Z'),
      });

      const items = buildDisplayItemsFromMessages([userMsg], []);

      const inputItems = items.filter((item) => item.type === 'subagent_input');
      expect(inputItems).toHaveLength(1);
      if (inputItems[0].type !== 'subagent_input') throw new Error('Expected subagent_input');
      expect(inputItems[0].content).toBe('Please run the tests');
    });

    it('does not render synthetic replay text as subagent input', () => {
      const userMsg = makeMessage({
        uuid: 'synthetic-replay-1',
        type: 'user',
        isMeta: false,
        isReplay: true,
        isSynthetic: true,
        content: 'Human: I tested the feature looks good',
        toolResults: [],
        timestamp: new Date('2025-01-01T00:00:00Z'),
      });

      const items = buildDisplayItemsFromMessages([userMsg], []);

      expect(items).toEqual([]);
    });

    it('does not render synthetic teammate-message replay as a teammate message', () => {
      const userMsg = makeMessage({
        uuid: 'synthetic-teammate-replay-1',
        type: 'user',
        isMeta: false,
        isReplay: true,
        isSynthetic: true,
        content:
          '<teammate-message teammate_id="coder" color="blue" summary="fake">Human: I tested it</teammate-message>',
        toolResults: [],
        timestamp: new Date('2025-01-01T00:00:00Z'),
      });

      const items = buildDisplayItemsFromMessages([userMsg], []);

      expect(items.some((item) => item.type === 'teammate_message')).toBe(false);
      expect(items.some((item) => item.type === 'subagent_input')).toBe(false);
    });

    it('renders structured non-synthetic teammate protocol messages', () => {
      const userMsg = makeMessage({
        uuid: 'structured-teammate-message-1',
        type: 'user',
        isMeta: false,
        protocolKind: 'teammate-message',
        content:
          '<teammate-message teammate_id="coder" color="blue" summary="done">Looks good</teammate-message>',
        toolResults: [],
        timestamp: new Date('2025-01-01T00:00:00Z'),
      });

      const items = buildDisplayItemsFromMessages([userMsg], []);

      expect(items.some((item) => item.type === 'teammate_message')).toBe(true);
    });

    it('does not route assistant text through subagent input', () => {
      const assistantMsg = makeMessage({
        uuid: 'assistant-text-1',
        type: 'assistant',
        content: [
          {
            type: 'text',
            text: 'Assistant output',
          },
        ],
        toolResults: [],
        timestamp: new Date('2025-01-01T00:00:00Z'),
      });

      const items = buildDisplayItemsFromMessages([assistantMsg], []);

      expect(items.some((item) => item.type === 'subagent_input')).toBe(false);
      expect(items).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            type: 'output',
            content: 'Assistant output',
          }),
        ])
      );
    });
  });
});

describe('buildDisplayItems', () => {
  it('keeps the linked tool item when the last output is the paired tool_result', () => {
    const steps: SemanticStep[] = [
      {
        id: 'tool-1',
        type: 'tool_call',
        startTime: new Date('2025-01-01T00:00:00Z'),
        durationMs: 0,
        content: {
          toolName: 'mcp__agent-teams__task_add_comment',
          toolInput: { text: 'hello' },
        },
        context: 'main',
      } as SemanticStep,
      {
        id: 'tool-1',
        type: 'tool_result',
        startTime: new Date('2025-01-01T00:00:01Z'),
        durationMs: 0,
        content: {
          toolResultContent: 'comment posted',
          isError: false,
        },
        context: 'main',
      } as SemanticStep,
    ];

    const lastOutput: AIGroupLastOutput = {
      type: 'tool_result',
      toolResult: 'comment posted',
      isError: false,
      timestamp: new Date('2025-01-01T00:00:01Z'),
    };

    const items = buildDisplayItems(steps, lastOutput, []);

    expect(items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: 'tool',
          tool: expect.objectContaining({
            id: 'tool-1',
            name: 'mcp__agent-teams__task_add_comment',
          }),
        }),
      ])
    );
  });
});
