import { describe, expect, it } from 'vitest';

import { DEFAULT_MEMBER_LOG_STREAM_BUDGET } from '../../../core/domain/models/MemberLogStreamBudget';
import { applyMemberLogMessageBudget } from '../memberLogMessageBudget';

import type { MemberLogStreamBudget } from '../../../core/domain/models/MemberLogStreamBudget';
import type { ParsedMessage } from '@main/types';

function budget(overrides: Partial<MemberLogStreamBudget>): MemberLogStreamBudget {
  return { ...DEFAULT_MEMBER_LOG_STREAM_BUDGET, ...overrides };
}

function message(overrides: Partial<ParsedMessage>): ParsedMessage {
  return {
    uuid: overrides.uuid ?? 'msg-1',
    parentUuid: null,
    type: 'assistant',
    timestamp: new Date('2026-04-01T00:00:00.000Z'),
    content: '',
    isSidechain: true,
    isMeta: false,
    toolCalls: [],
    toolResults: [],
    ...overrides,
  };
}

describe('applyMemberLogMessageBudget', () => {
  it('truncates oversized toolUseResult content, preserves ids, and reports content limiting', () => {
    const result = applyMemberLogMessageBudget(
      [
        message({
          type: 'user',
          role: 'user',
          isMeta: true,
          sourceToolUseID: 'tool-1',
          toolUseResult: {
            toolUseId: 'tool-1',
            content: 'x'.repeat(200),
            stdout: 'y'.repeat(200),
          },
        }),
      ],
      budget({
        maxToolResultContentChars: 80,
        maxTotalContentChars: 120,
      })
    );

    const toolUseResult = result.messages[0]?.toolUseResult;

    expect(result.contentLimited).toBe(true);
    expect(toolUseResult?.toolUseId).toBe('tool-1');
    expect(String(toolUseResult?.content)).toContain(
      '[content truncated by member log stream budget]'
    );
    expect(String(toolUseResult?.stdout)).toContain(
      '[content truncated by member log stream budget]'
    );
  });

  it('drops orphan tool results after window trimming instead of rendering unpaired results', () => {
    const result = applyMemberLogMessageBudget(
      [
        message({
          uuid: 'assistant-1',
          toolCalls: [{ id: 'tool-1', name: 'Bash', input: {}, isTask: false }],
        }),
        message({
          uuid: 'result-1',
          type: 'user',
          role: 'user',
          isMeta: true,
          sourceToolUseID: 'tool-1',
          toolResults: [{ toolUseId: 'tool-1', content: 'done', isError: false }],
        }),
      ],
      budget({ maxMessagesPerSegment: 1 })
    );

    expect(result.segmentWindowLimited).toBe(true);
    expect(result.messages).toEqual([]);
    expect(result.droppedMessageCount).toBe(2);
  });

  it('keeps JSON-looking output visible when it does not exceed the content budget', () => {
    const result = applyMemberLogMessageBudget(
      [message({ content: '{"status":"ok","value":42}' })],
      budget({
        maxMessageContentChars: 1_000,
        maxTotalContentChars: 1_000,
      })
    );

    expect(result.contentLimited).toBe(false);
    expect(result.messages[0]?.content).toBe('{"status":"ok","value":42}');
  });
});
