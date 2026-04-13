import { describe, expect, it, vi } from 'vitest';

import { BoardTaskActivityDetailService } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityDetailService';

import type { BoardTaskActivityRecord } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecord';
import type { BoardTaskExactLogDetailCandidate } from '../../../../src/main/services/team/taskLogs/exact/BoardTaskExactLogTypes';

function makeRecord(overrides: Partial<BoardTaskActivityRecord> = {}): BoardTaskActivityRecord {
  return {
    id: 'record-1',
    timestamp: '2026-04-13T10:35:00.000Z',
    task: {
      locator: { ref: 'abc12345', refKind: 'display', canonicalId: 'task-a' },
      resolution: 'resolved',
      taskRef: {
        taskId: 'task-a',
        displayId: 'abc12345',
        teamName: 'demo',
      },
    },
    linkKind: 'board_action',
    targetRole: 'subject',
    actor: {
      memberName: 'bob',
      role: 'member',
      sessionId: 'session-1',
      agentId: 'agent-1',
      isSidechain: true,
    },
    actorContext: {
      relation: 'other_active_task',
      activePhase: 'work',
      activeTask: {
        locator: { ref: 'peer12345', refKind: 'display', canonicalId: 'task-b' },
        resolution: 'resolved',
        taskRef: {
          taskId: 'task-b',
          displayId: 'peer12345',
          teamName: 'demo',
        },
      },
    },
    action: {
      canonicalToolName: 'task_add_comment',
      toolUseId: 'tool-1',
      category: 'comment',
      details: {
        commentId: '42',
      },
    },
    source: {
      filePath: '/tmp/task.jsonl',
      messageUuid: 'msg-1',
      toolUseId: 'tool-1',
      sourceOrder: 1,
    },
    ...overrides,
  };
}

describe('BoardTaskActivityDetailService', () => {
  it('returns structured metadata and focused log detail for tool-backed activity', async () => {
    const record = makeRecord();
    const detailCandidate: BoardTaskExactLogDetailCandidate = {
      id: 'activity:record-1',
      timestamp: record.timestamp,
      actor: record.actor,
      source: record.source,
      records: [record],
      filteredMessages: [
        {
          uuid: 'msg-1',
          parentUuid: null,
          type: 'user',
          timestamp: new Date(record.timestamp),
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'Posted comment' }],
          isSidechain: true,
          isMeta: true,
          toolCalls: [],
          toolResults: [{ toolUseId: 'tool-1', content: 'Posted comment', isError: false }],
          toolUseResult: { content: 'Posted comment' },
        } as never,
      ],
    };

    const service = new BoardTaskActivityDetailService(
      { getTaskRecords: vi.fn(async () => [record]) } as never,
      { parseFiles: vi.fn(async () => new Map([['/tmp/task.jsonl', []]])) } as never,
      { selectDetail: vi.fn(() => detailCandidate) } as never,
      {
        buildBundleChunks: vi.fn(() => [
          {
            id: 'chunk-1',
            chunkType: 'ai',
            toolExecutions: [
              {
                toolCall: {
                  id: 'tool-1',
                  name: 'task_add_comment',
                  input: {},
                  isTask: false,
                },
                startTime: new Date(record.timestamp),
              },
            ],
            semanticSteps: [{ id: 'step-1', type: 'tool_call' }],
          },
        ]),
      } as never
    );

    const result = await service.getTaskActivityDetail('demo', 'task-a', 'record-1');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('expected ok detail');
    }
    expect(result.detail.summaryLabel).toBe('Added a comment');
    expect(result.detail.actorLabel).toBe('bob');
    expect(result.detail.contextLines).toContain('while working on #peer12345');
    expect(result.detail.metadataRows).toEqual(
      expect.arrayContaining([
        { label: 'Task', value: '#abc12345' },
        { label: 'Tool', value: 'task_add_comment' },
        { label: 'Comment', value: '42' },
      ])
    );
    expect(result.detail.logDetail?.chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'chunk-1',
          chunkType: 'ai',
        }),
      ])
    );
  });

  it('keeps lifecycle tool-backed activity renderable when focused detail contains a tool execution', async () => {
    const record = makeRecord({
      id: 'record-complete',
      linkKind: 'lifecycle',
      action: {
        canonicalToolName: 'task_complete',
        toolUseId: 'tool-complete',
        category: 'status',
      },
      source: {
        filePath: '/tmp/task.jsonl',
        messageUuid: 'msg-complete',
        toolUseId: 'tool-complete',
        sourceOrder: 9,
      },
    });

    const service = new BoardTaskActivityDetailService(
      { getTaskRecords: vi.fn(async () => [record]) } as never,
      { parseFiles: vi.fn(async () => new Map([['/tmp/task.jsonl', []]])) } as never,
      {
        selectDetail: vi.fn(() => ({
          id: 'activity:record-complete',
          timestamp: record.timestamp,
          actor: record.actor,
          source: record.source,
          records: [record],
          filteredMessages: [
            {
              uuid: 'msg-complete-assistant',
              parentUuid: null,
              type: 'assistant',
              timestamp: new Date(record.timestamp),
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'tool-complete', name: 'task_complete', input: {} }],
              isSidechain: true,
              isMeta: false,
              toolCalls: [{ id: 'tool-complete', name: 'task_complete', input: {}, isTask: false }],
              toolResults: [],
            } as never,
            {
              uuid: 'msg-complete-user',
              parentUuid: 'msg-complete-assistant',
              type: 'user',
              timestamp: new Date(record.timestamp),
              role: 'user',
              content: [{ type: 'tool_result', tool_use_id: 'tool-complete', content: '' }],
              isSidechain: true,
              isMeta: true,
              toolCalls: [],
              toolResults: [{ toolUseId: 'tool-complete', content: '', isError: false }],
              toolUseResult: { content: '' },
            } as never,
          ],
        })),
      } as never,
      {
        buildBundleChunks: vi.fn(() => [
          {
            id: 'chunk-complete',
            chunkType: 'ai',
            toolExecutions: [
              {
                toolCall: {
                  id: 'tool-complete',
                  name: 'task_complete',
                  input: {},
                  isTask: false,
                },
                startTime: new Date(record.timestamp),
              },
            ],
            semanticSteps: [
              { id: 'step-complete-call', type: 'tool_call' },
              { id: 'step-complete-result', type: 'tool_result' },
            ],
          },
        ]),
      } as never
    );

    const result = await service.getTaskActivityDetail('demo', 'task-a', 'record-complete');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('expected ok detail');
    }
    expect(result.detail.summaryLabel).toBe('Completed task');
    expect(result.detail.logDetail?.chunks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: 'chunk-complete',
          chunkType: 'ai',
        }),
      ])
    );
  });

  it('returns metadata only for non-tool-backed activity without parsing transcript content', async () => {
    const record = makeRecord({
      id: 'record-2',
      source: {
        filePath: '/tmp/task.jsonl',
        messageUuid: 'msg-2',
        sourceOrder: 2,
      },
      action: {
        canonicalToolName: 'task_set_owner',
        category: 'assignment',
        details: {
          owner: 'alice',
        },
      },
    });
    const strictParser = { parseFiles: vi.fn(async () => new Map()) };
    const service = new BoardTaskActivityDetailService(
      { getTaskRecords: vi.fn(async () => [record]) } as never,
      strictParser as never,
      { selectDetail: vi.fn() } as never,
      { buildBundleChunks: vi.fn() } as never
    );

    const result = await service.getTaskActivityDetail('demo', 'task-a', 'record-2');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('expected ok detail');
    }
    expect(result.detail.metadataRows).toEqual(
      expect.arrayContaining([{ label: 'Owner', value: 'alice' }])
    );
    expect(result.detail.logDetail).toBeUndefined();
    expect(strictParser.parseFiles).not.toHaveBeenCalled();
  });

  it('keeps read-only task activity metadata-only even when toolUseId exists', async () => {
    const record = makeRecord({
      id: 'record-read',
      action: {
        canonicalToolName: 'task_get',
        category: 'read',
      },
      source: {
        filePath: '/tmp/task.jsonl',
        messageUuid: 'msg-read',
        toolUseId: 'tool-read',
        sourceOrder: 3,
      },
    });
    const strictParser = { parseFiles: vi.fn(async () => new Map()) };
    const service = new BoardTaskActivityDetailService(
      { getTaskRecords: vi.fn(async () => [record]) } as never,
      strictParser as never,
      { selectDetail: vi.fn() } as never,
      { buildBundleChunks: vi.fn() } as never
    );

    const result = await service.getTaskActivityDetail('demo', 'task-a', 'record-read');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('expected ok detail');
    }
    expect(result.detail.summaryLabel).toBe('Viewed task');
    expect(result.detail.logDetail).toBeUndefined();
    expect(strictParser.parseFiles).not.toHaveBeenCalled();
  });

  it('drops log detail when focused chunks degrade into empty success snapshots', async () => {
    const record = makeRecord({
      id: 'record-start',
      action: {
        canonicalToolName: 'task_start',
        category: 'status',
      },
      source: {
        filePath: '/tmp/task.jsonl',
        messageUuid: 'msg-start',
        toolUseId: 'tool-start',
        sourceOrder: 4,
      },
    });

    const service = new BoardTaskActivityDetailService(
      { getTaskRecords: vi.fn(async () => [record]) } as never,
      { parseFiles: vi.fn(async () => new Map([['/tmp/task.jsonl', []]])) } as never,
      {
        selectDetail: vi.fn(() => ({
          id: 'activity:record-start',
          timestamp: record.timestamp,
          actor: record.actor,
          source: record.source,
          records: [record],
          filteredMessages: [
            {
              uuid: 'msg-start-assistant',
              parentUuid: null,
              type: 'assistant',
              timestamp: new Date(record.timestamp),
              role: 'assistant',
              content: [{ type: 'tool_use', id: 'tool-start', name: 'task_start', input: {} }],
              isSidechain: true,
              isMeta: false,
              toolCalls: [{ id: 'tool-start', name: 'task_start', input: {}, isTask: false }],
              toolResults: [],
              sourceToolUseID: 'tool-start',
            } as never,
            {
              uuid: 'msg-start-user',
              parentUuid: 'msg-start-assistant',
              type: 'user',
              timestamp: new Date(record.timestamp),
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: 'tool-start',
                  content:
                    '[{\"type\":\"text\",\"text\":\"{\\n  \\\"id\\\": \\\"task-a\\\",\\n  \\\"status\\\": \\\"in_progress\\\"\\n}\"}]',
                },
              ],
              isSidechain: true,
              isMeta: true,
              toolCalls: [],
              toolResults: [
                {
                  toolUseId: 'tool-start',
                  content:
                    '[{\"type\":\"text\",\"text\":\"{\\n  \\\"id\\\": \\\"task-a\\\",\\n  \\\"status\\\": \\\"in_progress\\\"\\n}\"}]',
                  isError: false,
                },
              ],
              toolUseResult: {
                content:
                  '[{\"type\":\"text\",\"text\":\"{\\n  \\\"id\\\": \\\"task-a\\\",\\n  \\\"status\\\": \\\"in_progress\\\"\\n}\"}]',
              },
            } as never,
          ],
        })),
      } as never,
      {
        buildBundleChunks: vi.fn(() => [
          {
            chunkType: 'ai',
            toolExecutions: [],
            semanticSteps: [],
          },
        ]),
      } as never
    );

    const result = await service.getTaskActivityDetail('demo', 'task-a', 'record-start');

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') {
      throw new Error('expected ok detail');
    }
    expect(result.detail.summaryLabel).toBe('Started work');
    expect(result.detail.logDetail).toBeUndefined();
  });

  it('returns missing when the activity id does not exist', async () => {
    const service = new BoardTaskActivityDetailService(
      { getTaskRecords: vi.fn(async () => [makeRecord()]) } as never,
      { parseFiles: vi.fn() } as never,
      { selectDetail: vi.fn() } as never,
      { buildBundleChunks: vi.fn() } as never
    );

    await expect(service.getTaskActivityDetail('demo', 'task-a', 'missing-id')).resolves.toEqual({
      status: 'missing',
    });
  });
});
