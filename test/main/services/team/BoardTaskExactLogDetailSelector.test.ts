import { describe, expect, it } from 'vitest';

import { BoardTaskExactLogDetailSelector } from '../../../../src/main/services/team/taskLogs/exact/BoardTaskExactLogDetailSelector';

import type { ParsedMessage } from '../../../../src/main/types';
import type { BoardTaskActivityRecord } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecord';
import type { BoardTaskExactLogBundleCandidate } from '../../../../src/main/services/team/taskLogs/exact/BoardTaskExactLogTypes';

function makeRecord(): BoardTaskActivityRecord {
  return {
    id: 'record-1',
    timestamp: '2026-04-12T16:00:00.000Z',
    task: {
      locator: { ref: 'abcd1234', refKind: 'display', canonicalId: 'task-a' },
      resolution: 'resolved',
    },
    linkKind: 'board_action',
    targetRole: 'subject',
    actor: {
      memberName: 'alice',
      role: 'member',
      sessionId: 'session-1',
      agentId: 'agent-1',
      isSidechain: true,
    },
    actorContext: { relation: 'same_task' },
    action: {
      canonicalToolName: 'task_add_comment',
      toolUseId: 'tool-1',
      category: 'comment',
    },
    source: {
      filePath: '/tmp/task.jsonl',
      messageUuid: 'assistant-1',
      toolUseId: 'tool-1',
      sourceOrder: 1,
    },
  };
}

function makeCandidate(records: BoardTaskActivityRecord[]): BoardTaskExactLogBundleCandidate {
  return {
    id: 'tool:/tmp/task.jsonl:tool-1',
    timestamp: '2026-04-12T16:00:00.000Z',
    actor: records[0]!.actor,
    source: {
      filePath: '/tmp/task.jsonl',
      messageUuid: 'assistant-1',
      toolUseId: 'tool-1',
      sourceOrder: 1,
    },
    records,
    anchor: {
      kind: 'tool',
      filePath: '/tmp/task.jsonl',
      messageUuid: 'assistant-1',
      toolUseId: 'tool-1',
    },
    actionLabel: 'Added a comment',
    actionCategory: 'comment',
    canonicalToolName: 'task_add_comment',
    linkKinds: ['board_action'],
    targetRoles: ['subject'],
    canLoadDetail: true,
    sourceGeneration: 'gen-1',
  };
}

describe('BoardTaskExactLogDetailSelector', () => {
  it('keeps the matched tool flow, preserves anchor output, and deduplicates assistant streaming rows anchor-aware', () => {
    const records = [makeRecord()];
    const candidate = makeCandidate(records);
    const parsedMessagesByFile = new Map<string, ParsedMessage[]>([
      [
        '/tmp/task.jsonl',
        [
          {
            uuid: 'assistant-0',
            parentUuid: null,
            type: 'assistant',
            timestamp: new Date('2026-04-12T16:00:00.000Z'),
            role: 'assistant',
            content: [
              { type: 'thinking', thinking: 'draft' } as never,
              { type: 'text', text: 'old tool draft' } as never,
              { type: 'tool_use', id: 'tool-1', name: 'task_add_comment', input: { taskId: 'x' } } as never,
            ],
            toolCalls: [],
            toolResults: [],
            requestId: 'req-1',
            isSidechain: true,
            isMeta: false,
            isCompactSummary: false,
          },
          {
            uuid: 'assistant-1',
            parentUuid: null,
            type: 'assistant',
            timestamp: new Date('2026-04-12T16:00:01.000Z'),
            role: 'assistant',
            content: [
              { type: 'text', text: 'stream tail without anchor tool call' } as never,
              { type: 'tool_use', id: 'tool-2', name: 'task_get', input: { taskId: 'y' } } as never,
            ],
            toolCalls: [],
            toolResults: [],
            requestId: 'req-1',
            isSidechain: true,
            isMeta: false,
            isCompactSummary: false,
          },
          {
            uuid: 'user-1',
            parentUuid: null,
            type: 'user',
            timestamp: new Date('2026-04-12T16:00:02.000Z'),
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' } as never,
              { type: 'tool_result', tool_use_id: 'tool-2', content: 'ignore' } as never,
            ],
            toolCalls: [],
            toolResults: [],
            sourceToolUseID: 'tool-1',
            sourceToolAssistantUUID: 'assistant-1',
            toolUseResult: { output: 'kept' },
            requestId: 'req-1',
            isSidechain: true,
            isMeta: false,
            isCompactSummary: false,
          },
          {
            uuid: 'assistant-2',
            parentUuid: null,
            type: 'assistant',
            timestamp: new Date('2026-04-12T16:00:03.000Z'),
            role: 'assistant',
            content: [{ type: 'text', text: 'comment saved' } as never],
            toolCalls: [],
            toolResults: [],
            sourceToolUseID: 'tool-1',
            requestId: 'req-2',
            isSidechain: true,
            isMeta: false,
            isCompactSummary: false,
          },
        ],
      ],
    ]);

    const detail = new BoardTaskExactLogDetailSelector().selectDetail({
      candidate,
      records,
      parsedMessagesByFile,
    });

    expect(detail).not.toBeNull();
    expect(detail?.filteredMessages).toHaveLength(3);
    expect(detail?.filteredMessages[0]?.uuid).toBe('assistant-0');
    expect(detail?.filteredMessages[1]?.uuid).toBe('user-1');
    expect(detail?.filteredMessages[2]?.uuid).toBe('assistant-2');
    expect(detail?.filteredMessages[0]?.toolCalls).toHaveLength(1);
    expect(detail?.filteredMessages[1]?.toolResults).toHaveLength(1);
    expect(detail?.filteredMessages[1]?.toolUseResult).toEqual({ output: 'kept' });
    expect(detail?.filteredMessages[1]?.sourceToolAssistantUUID).toBeUndefined();
    expect(detail?.filteredMessages[2]?.sourceToolUseID).toBe('tool-1');
  });

  it('drops stale derived tool metadata when a message-linked row survives filtering', () => {
    const record = {
      ...makeRecord(),
      id: 'record-message-1',
      source: {
        filePath: '/tmp/task.jsonl',
        messageUuid: 'user-2',
        sourceOrder: 2,
      },
      action: undefined,
    } satisfies BoardTaskActivityRecord;
    const candidate: BoardTaskExactLogBundleCandidate = {
      id: 'message:/tmp/task.jsonl:user-2',
      timestamp: '2026-04-12T16:01:00.000Z',
      actor: record.actor,
      source: {
        filePath: '/tmp/task.jsonl',
        messageUuid: 'user-2',
        sourceOrder: 2,
      },
      records: [record],
      anchor: {
        kind: 'message',
        filePath: '/tmp/task.jsonl',
        messageUuid: 'user-2',
      },
      actionLabel: 'Worked on task',
      linkKinds: ['execution'],
      targetRoles: ['subject'],
      canLoadDetail: true,
      sourceGeneration: 'gen-2',
    };
    const parsedMessagesByFile = new Map<string, ParsedMessage[]>([
      [
        '/tmp/task.jsonl',
        [
          {
            uuid: 'user-2',
            parentUuid: null,
            type: 'user',
            timestamp: new Date('2026-04-12T16:01:00.000Z'),
            role: 'user',
            content: [
              { type: 'text', text: 'status update' } as never,
              { type: 'tool_result', tool_use_id: 'other-tool', content: 'stale tool result' } as never,
            ],
            toolCalls: [],
            toolResults: [],
            sourceToolUseID: 'other-tool',
            sourceToolAssistantUUID: 'assistant-other',
            toolUseResult: { output: 'stale' },
            requestId: 'req-2',
            isSidechain: true,
            isMeta: false,
            isCompactSummary: false,
          },
        ],
      ],
    ]);

    const detail = new BoardTaskExactLogDetailSelector().selectDetail({
      candidate,
      records: [record],
      parsedMessagesByFile,
    });

    expect(detail).not.toBeNull();
    expect(detail?.filteredMessages).toHaveLength(1);
    expect(detail?.filteredMessages[0]?.content).toEqual([{ type: 'text', text: 'status update' }]);
    expect(detail?.filteredMessages[0]?.toolResults).toEqual([]);
    expect(detail?.filteredMessages[0]?.sourceToolUseID).toBeUndefined();
    expect(detail?.filteredMessages[0]?.sourceToolAssistantUUID).toBeUndefined();
    expect(detail?.filteredMessages[0]?.toolUseResult).toBeUndefined();
  });

  it('preserves toolUseResult for a matched tool_result even when sourceToolUseID is absent', () => {
    const records = [makeRecord()];
    const candidate = makeCandidate(records);
    const parsedMessagesByFile = new Map<string, ParsedMessage[]>([
      [
        '/tmp/task.jsonl',
        [
          {
            uuid: 'assistant-1',
            parentUuid: null,
            type: 'assistant',
            timestamp: new Date('2026-04-12T16:00:00.000Z'),
            role: 'assistant',
            content: [
              { type: 'tool_use', id: 'tool-1', name: 'task_add_comment', input: { taskId: 'x' } } as never,
            ],
            toolCalls: [],
            toolResults: [],
            requestId: 'req-1',
            isSidechain: true,
            isMeta: false,
            isCompactSummary: false,
          },
          {
            uuid: 'user-1',
            parentUuid: null,
            type: 'user',
            timestamp: new Date('2026-04-12T16:00:01.000Z'),
            role: 'user',
            content: [
              { type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' } as never,
            ],
            toolCalls: [],
            toolResults: [],
            toolUseResult: {
              toolUseId: 'tool-1',
              content: 'ok',
            },
            requestId: 'req-1',
            isSidechain: true,
            isMeta: false,
            isCompactSummary: false,
          },
        ],
      ],
    ]);

    const detail = new BoardTaskExactLogDetailSelector().selectDetail({
      candidate,
      records,
      parsedMessagesByFile,
    });

    expect(detail).not.toBeNull();
    expect(detail?.filteredMessages).toHaveLength(2);
    expect(detail?.filteredMessages[1]?.sourceToolUseID).toBe('tool-1');
    expect(detail?.filteredMessages[1]?.toolUseResult).toEqual({
      toolUseId: 'tool-1',
      content: 'ok',
    });
  });
});
