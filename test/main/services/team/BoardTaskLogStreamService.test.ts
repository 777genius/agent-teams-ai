import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoardTaskLogStreamService } from '../../../../src/main/services/team/taskLogs/stream/BoardTaskLogStreamService';

import type { ParsedMessage } from '../../../../src/main/types';
import type { BoardTaskActivityRecord } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecord';
import type { BoardTaskExactLogBundleCandidate } from '../../../../src/main/services/team/taskLogs/exact/BoardTaskExactLogTypes';

function makeRecord(
  id: string,
  timestamp: string,
  actor: BoardTaskActivityRecord['actor'],
  toolUseId?: string,
): BoardTaskActivityRecord {
  return {
    id,
    timestamp,
    task: {
      locator: { ref: 'abcd1234', refKind: 'display', canonicalId: 'task-a' },
      resolution: 'resolved',
    },
    linkKind: 'board_action',
    targetRole: 'subject',
    actor,
    actorContext: { relation: 'same_task' },
    source: {
      filePath: '/tmp/task.jsonl',
      messageUuid: `${id}-msg`,
      ...(toolUseId ? { toolUseId } : {}),
      sourceOrder: 1,
    },
  };
}

function makeCandidate(
  id: string,
  timestamp: string,
  actor: BoardTaskActivityRecord['actor'],
  toolUseId?: string,
): BoardTaskExactLogBundleCandidate {
  const record = makeRecord(id, timestamp, actor, toolUseId);
  return {
    id,
    timestamp,
    actor,
    source: {
      filePath: '/tmp/task.jsonl',
      messageUuid: `${id}-msg`,
      ...(toolUseId ? { toolUseId } : {}),
      sourceOrder: 1,
    },
    records: [record],
    anchor: toolUseId
      ? {
          kind: 'tool',
          filePath: '/tmp/task.jsonl',
          messageUuid: `${id}-msg`,
          toolUseId,
        }
      : {
          kind: 'message',
          filePath: '/tmp/task.jsonl',
          messageUuid: `${id}-msg`,
        },
    actionLabel: 'Worked on task',
    linkKinds: ['board_action'],
    targetRoles: ['subject'],
    canLoadDetail: true,
    sourceGeneration: 'gen-1',
  };
}

function makeMessage(uuid: string, timestamp: string, text: string): ParsedMessage {
  return {
    uuid,
    parentUuid: null,
    type: 'assistant',
    timestamp: new Date(timestamp),
    role: 'assistant',
    content: [{ type: 'text', text } as never],
    toolCalls: [],
    toolResults: [],
    isSidechain: true,
    isMeta: false,
    isCompactSummary: false,
  };
}

describe('BoardTaskLogStreamService', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns empty when the stream read flag is disabled', async () => {
    vi.stubEnv('CLAUDE_TEAM_BOARD_TASK_EXACT_LOGS_READ_ENABLED', 'false');
    const recordSource = {
      getTaskRecords: vi.fn(async () => {
        throw new Error('should not be called');
      }),
    };

    const service = new BoardTaskLogStreamService(recordSource as never);
    await expect(service.getTaskLogStream('demo', 'task-a')).resolves.toEqual({
      participants: [],
      defaultFilter: 'all',
      segments: [],
    });
    expect(recordSource.getTaskRecords).not.toHaveBeenCalled();
  });

  it('groups contiguous slices into participant segments and excludes lead slices when member slices exist', async () => {
    const tom = {
      memberName: 'tom',
      role: 'member' as const,
      sessionId: 'session-tom',
      agentId: 'agent-tom',
      isSidechain: true,
    };
    const alice = {
      memberName: 'alice',
      role: 'member' as const,
      sessionId: 'session-alice',
      agentId: 'agent-alice',
      isSidechain: true,
    };
    const lead = {
      role: 'lead' as const,
      sessionId: 'session-lead',
      isSidechain: false,
    };
    const candidates = [
      makeCandidate('c1', '2026-04-12T16:00:00.000Z', tom, 'tool-1'),
      makeCandidate('c2', '2026-04-12T16:01:00.000Z', tom, 'tool-2'),
      makeCandidate('c3', '2026-04-12T16:02:00.000Z', alice, 'tool-3'),
      makeCandidate('c4', '2026-04-12T16:03:00.000Z', lead),
      makeCandidate('c5', '2026-04-12T16:04:00.000Z', tom, 'tool-4'),
    ];

    const recordSource = {
      getTaskRecords: vi.fn(async () => candidates.flatMap((candidate) => candidate.records)),
    };
    const summarySelector = {
      selectSummaries: vi.fn(() => candidates),
    };
    const strictParser = {
      parseFiles: vi.fn(async () => new Map([['/tmp/task.jsonl', []]])),
    };
    const detailSelector = {
      selectDetail: vi.fn(({ candidate }: { candidate: BoardTaskExactLogBundleCandidate }) => ({
        id: candidate.id,
        timestamp: candidate.timestamp,
        actor: candidate.actor,
        source: candidate.source,
        records: candidate.records,
        filteredMessages: [makeMessage(candidate.id, candidate.timestamp, candidate.id)],
      })),
    };
    const buildBundleChunks = vi.fn((messages: ParsedMessage[]) => [{ id: messages[0]?.uuid }]);

    const service = new BoardTaskLogStreamService(
      recordSource as never,
      summarySelector as never,
      strictParser as never,
      detailSelector as never,
      { buildBundleChunks } as never,
    );

    const response = await service.getTaskLogStream('demo', 'task-a');

    expect(response.defaultFilter).toBe('all');
    expect(response.participants.map((participant) => participant.key)).toEqual([
      'member:tom',
      'member:alice',
    ]);
    expect(response.segments.map((segment) => segment.participantKey)).toEqual([
      'member:tom',
      'member:alice',
      'member:tom',
    ]);
    expect(buildBundleChunks).toHaveBeenCalledTimes(3);
    expect(buildBundleChunks.mock.calls[0]?.[0]).toHaveLength(2);
  });

  it('merges duplicate message uuids inside one participant segment before chunk building', async () => {
    const tom = {
      memberName: 'tom',
      role: 'member' as const,
      sessionId: 'session-tom',
      agentId: 'agent-tom',
      isSidechain: true,
    };
    const candidates = [
      makeCandidate('c1', '2026-04-12T16:00:00.000Z', tom, 'tool-1'),
      makeCandidate('c2', '2026-04-12T16:00:10.000Z', tom, 'tool-2'),
    ];

    const sharedMessage = {
      uuid: 'assistant-shared',
      parentUuid: null,
      type: 'assistant' as const,
      timestamp: new Date('2026-04-12T16:00:00.000Z'),
      role: 'assistant',
      toolCalls: [],
      toolResults: [],
      isSidechain: true,
      isMeta: false,
      isCompactSummary: false,
    };

    const recordSource = {
      getTaskRecords: vi.fn(async () => candidates.flatMap((candidate) => candidate.records)),
    };
    const summarySelector = {
      selectSummaries: vi.fn(() => candidates),
    };
    const strictParser = {
      parseFiles: vi.fn(async () => new Map([['/tmp/task.jsonl', []]])),
    };
    const detailSelector = {
      selectDetail: vi
        .fn()
        .mockImplementationOnce(() => ({
          id: 'c1',
          timestamp: '2026-04-12T16:00:00.000Z',
          actor: tom,
          source: { filePath: '/tmp/task.jsonl', messageUuid: 'assistant-shared', sourceOrder: 1 },
          records: candidates[0]!.records,
          filteredMessages: [
            {
              ...sharedMessage,
              content: [{ type: 'tool_use', id: 'tool-1', name: 'task_get', input: {} } as never],
            },
          ],
        }))
        .mockImplementationOnce(() => ({
          id: 'c2',
          timestamp: '2026-04-12T16:00:10.000Z',
          actor: tom,
          source: { filePath: '/tmp/task.jsonl', messageUuid: 'assistant-shared', sourceOrder: 2 },
          records: candidates[1]!.records,
          filteredMessages: [
            {
              ...sharedMessage,
              content: [{ type: 'text', text: 'task looked up' } as never],
            },
          ],
        })),
    };
    const buildBundleChunks = vi.fn((messages: ParsedMessage[]) => [{ id: messages[0]?.uuid }]);

    const service = new BoardTaskLogStreamService(
      recordSource as never,
      summarySelector as never,
      strictParser as never,
      detailSelector as never,
      { buildBundleChunks } as never,
    );

    await service.getTaskLogStream('demo', 'task-a');

    expect(buildBundleChunks).toHaveBeenCalledTimes(1);
    const mergedMessages = buildBundleChunks.mock.calls[0]?.[0] as ParsedMessage[];
    expect(mergedMessages).toHaveLength(1);
    expect(mergedMessages[0]?.toolCalls).toHaveLength(1);
    expect(Array.isArray(mergedMessages[0]?.content)).toBe(true);
    expect(mergedMessages[0]?.content).toHaveLength(2);
  });

  it('drops tool-anchored assistant output-only messages to avoid noisy raw result blocks', async () => {
    const tom = {
      memberName: 'tom',
      role: 'member' as const,
      sessionId: 'session-tom',
      agentId: 'agent-tom',
      isSidechain: true,
    };
    const candidate = makeCandidate('c1', '2026-04-12T16:00:00.000Z', tom, 'tool-1');

    const recordSource = {
      getTaskRecords: vi.fn(async () => candidate.records),
    };
    const summarySelector = {
      selectSummaries: vi.fn(() => [candidate]),
    };
    const strictParser = {
      parseFiles: vi.fn(async () => new Map([['/tmp/task.jsonl', []]])),
    };
    const detailSelector = {
      selectDetail: vi.fn(() => ({
        id: 'c1',
        timestamp: '2026-04-12T16:00:00.000Z',
        actor: tom,
        source: { filePath: '/tmp/task.jsonl', messageUuid: 'assistant-tool', toolUseId: 'tool-1', sourceOrder: 1 },
        records: candidate.records,
        filteredMessages: [
          {
            uuid: 'assistant-tool',
            parentUuid: null,
            type: 'assistant' as const,
            timestamp: new Date('2026-04-12T16:00:00.000Z'),
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'task_get', input: {} } as never],
            toolCalls: [],
            toolResults: [],
            isSidechain: true,
            isMeta: false,
            isCompactSummary: false,
          },
          {
            uuid: 'assistant-output',
            parentUuid: 'assistant-tool',
            type: 'assistant' as const,
            timestamp: new Date('2026-04-12T16:00:01.000Z'),
            role: 'assistant',
            content: [{ type: 'text', text: '[{\"type\":\"text\",\"text\":\"{\\n  \\\"id\\\": \\\"task-a\\\"\\n}\"}]' } as never],
            toolCalls: [],
            toolResults: [],
            sourceToolUseID: 'tool-1',
            sourceToolAssistantUUID: 'assistant-tool',
            isSidechain: true,
            isMeta: false,
            isCompactSummary: false,
          },
          {
            uuid: 'user-result',
            parentUuid: 'assistant-tool',
            type: 'user' as const,
            timestamp: new Date('2026-04-12T16:00:02.000Z'),
            role: 'user',
            content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' } as never],
            toolCalls: [],
            toolResults: [],
            sourceToolUseID: 'tool-1',
            sourceToolAssistantUUID: 'assistant-tool',
            toolUseResult: { toolUseId: 'tool-1', content: 'ok' },
            isSidechain: true,
            isMeta: false,
            isCompactSummary: false,
          },
        ],
      })),
    };
    const buildBundleChunks = vi.fn((messages: ParsedMessage[]) => [{ id: messages[0]?.uuid }]);

    const service = new BoardTaskLogStreamService(
      recordSource as never,
      summarySelector as never,
      strictParser as never,
      detailSelector as never,
      { buildBundleChunks } as never,
    );

    await service.getTaskLogStream('demo', 'task-a');

    expect(buildBundleChunks).toHaveBeenCalledTimes(1);
    const mergedMessages = buildBundleChunks.mock.calls[0]?.[0] as ParsedMessage[];
    expect(mergedMessages.map((message) => message.uuid)).toEqual(['assistant-tool', 'user-result']);
  });

  it('defaults to the single named participant and excludes unnamed lead noise when named task logs exist', async () => {
    const tom = {
      memberName: 'tom',
      role: 'lead' as const,
      sessionId: 'session-tom',
      isSidechain: false,
    };
    const unknownLead = {
      role: 'unknown' as const,
      sessionId: 'session-lead',
      isSidechain: false,
    };
    const candidates = [
      makeCandidate('c1', '2026-04-12T16:00:00.000Z', tom, 'tool-1'),
      makeCandidate('c2', '2026-04-12T16:01:00.000Z', unknownLead, 'tool-2'),
    ];

    const recordSource = {
      getTaskRecords: vi.fn(async () => candidates.flatMap((candidate) => candidate.records)),
    };
    const summarySelector = {
      selectSummaries: vi.fn(() => candidates),
    };
    const strictParser = {
      parseFiles: vi.fn(async () => new Map([['/tmp/task.jsonl', []]])),
    };
    const detailSelector = {
      selectDetail: vi.fn(({ candidate }: { candidate: BoardTaskExactLogBundleCandidate }) => ({
        id: candidate.id,
        timestamp: candidate.timestamp,
        actor: candidate.actor,
        source: candidate.source,
        records: candidate.records,
        filteredMessages: [makeMessage(candidate.id, candidate.timestamp, candidate.id)],
      })),
    };
    const buildBundleChunks = vi.fn((messages: ParsedMessage[]) => [{ id: messages[0]?.uuid }]);

    const service = new BoardTaskLogStreamService(
      recordSource as never,
      summarySelector as never,
      strictParser as never,
      detailSelector as never,
      { buildBundleChunks } as never,
    );

    const response = await service.getTaskLogStream('demo', 'task-a');

    expect(response.participants.map((participant) => participant.key)).toEqual(['member:tom']);
    expect(response.defaultFilter).toBe('member:tom');
    expect(response.segments.map((segment) => segment.participantKey)).toEqual(['member:tom']);
  });

  it('drops empty json-like task_get tool result messages after sanitization', async () => {
    const tom = {
      memberName: 'tom',
      role: 'member' as const,
      sessionId: 'session-tom',
      agentId: 'agent-tom',
      isSidechain: true,
    };
    const candidate = makeCandidate('c1', '2026-04-12T16:00:00.000Z', tom, 'tool-1');

    const recordSource = {
      getTaskRecords: vi.fn(async () => candidate.records),
    };
    const summarySelector = {
      selectSummaries: vi.fn(() => [candidate]),
    };
    const strictParser = {
      parseFiles: vi.fn(async () => new Map([['/tmp/task.jsonl', []]])),
    };
    const detailSelector = {
      selectDetail: vi.fn(() => ({
        id: 'c1',
        timestamp: '2026-04-12T16:00:00.000Z',
        actor: tom,
        source: { filePath: '/tmp/task.jsonl', messageUuid: 'assistant-tool', toolUseId: 'tool-1', sourceOrder: 1 },
        records: candidate.records,
        filteredMessages: [
          {
            uuid: 'assistant-tool',
            parentUuid: null,
            type: 'assistant' as const,
            timestamp: new Date('2026-04-12T16:00:00.000Z'),
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'task_get', input: {} } as never],
            toolCalls: [],
            toolResults: [],
            isSidechain: true,
            isMeta: false,
            isCompactSummary: false,
          },
          {
            uuid: 'user-result',
            parentUuid: 'assistant-tool',
            type: 'user' as const,
            timestamp: new Date('2026-04-12T16:00:02.000Z'),
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: [{ type: 'text', text: '{\n  \"id\": \"task-a\"\n}' } as never],
              } as never,
            ],
            toolCalls: [],
            toolResults: [],
            sourceToolUseID: 'tool-1',
            sourceToolAssistantUUID: 'assistant-tool',
            toolUseResult: { toolUseId: 'tool-1', content: '{\n  \"id\": \"task-a\"\n}' },
            isSidechain: true,
            isMeta: false,
            isCompactSummary: false,
          },
        ],
      })),
    };
    const buildBundleChunks = vi.fn((messages: ParsedMessage[]) => [{ id: messages[0]?.uuid }]);

    const service = new BoardTaskLogStreamService(
      recordSource as never,
      summarySelector as never,
      strictParser as never,
      detailSelector as never,
      { buildBundleChunks } as never,
    );

    await service.getTaskLogStream('demo', 'task-a');

    const mergedMessages = buildBundleChunks.mock.calls[0]?.[0] as ParsedMessage[];
    const toolResultMessage = mergedMessages.find((message) => message.uuid === 'user-result');
    expect(toolResultMessage).toBeUndefined();
    expect(mergedMessages.map((message) => message.uuid)).toEqual(['assistant-tool']);
  });

  it('drops read-only slices when the same participant has more meaningful task logs', async () => {
    const tom = {
      memberName: 'tom',
      role: 'lead' as const,
      sessionId: 'session-tom',
      isSidechain: false,
    };
    const readCandidate = { ...makeCandidate('c1', '2026-04-12T16:00:00.000Z', tom, 'tool-1'), actionCategory: 'read' as const, canonicalToolName: 'task_get' };
    const commentCandidate = { ...makeCandidate('c2', '2026-04-12T16:01:00.000Z', tom, 'tool-2'), actionCategory: 'comment' as const, canonicalToolName: 'task_add_comment' };

    const recordSource = {
      getTaskRecords: vi.fn(async () => [...readCandidate.records, ...commentCandidate.records]),
    };
    const summarySelector = {
      selectSummaries: vi.fn(() => [readCandidate, commentCandidate]),
    };
    const strictParser = {
      parseFiles: vi.fn(async () => new Map([['/tmp/task.jsonl', []]])),
    };
    const detailSelector = {
      selectDetail: vi.fn(({ candidate }: { candidate: BoardTaskExactLogBundleCandidate }) => ({
        id: candidate.id,
        timestamp: candidate.timestamp,
        actor: candidate.actor,
        source: candidate.source,
        records: candidate.records,
        filteredMessages: [makeMessage(candidate.id, candidate.timestamp, candidate.id)],
      })),
    };
    const buildBundleChunks = vi.fn((messages: ParsedMessage[]) => [{ id: messages[0]?.uuid }]);

    const service = new BoardTaskLogStreamService(
      recordSource as never,
      summarySelector as never,
      strictParser as never,
      detailSelector as never,
      { buildBundleChunks } as never,
    );

    const response = await service.getTaskLogStream('demo', 'task-a');

    expect(response.segments).toHaveLength(1);
    expect(buildBundleChunks).toHaveBeenCalledTimes(1);
    const mergedMessages = buildBundleChunks.mock.calls[0]?.[0] as ParsedMessage[];
    expect(mergedMessages.map((message) => message.uuid)).toEqual(['c2']);
  });

  it('extracts task_add_comment text from json-like tool result payload', async () => {
    const tom = {
      memberName: 'tom',
      role: 'lead' as const,
      sessionId: 'session-tom',
      isSidechain: false,
    };
    const candidate = {
      ...makeCandidate('c1', '2026-04-12T16:00:00.000Z', tom, 'tool-1'),
      actionCategory: 'comment' as const,
      canonicalToolName: 'task_add_comment',
    };

    const recordSource = {
      getTaskRecords: vi.fn(async () => candidate.records),
    };
    const summarySelector = {
      selectSummaries: vi.fn(() => [candidate]),
    };
    const strictParser = {
      parseFiles: vi.fn(async () => new Map([['/tmp/task.jsonl', []]])),
    };
    const detailSelector = {
      selectDetail: vi.fn(() => ({
        id: 'c1',
        timestamp: '2026-04-12T16:00:00.000Z',
        actor: tom,
        source: { filePath: '/tmp/task.jsonl', messageUuid: 'assistant-tool', toolUseId: 'tool-1', sourceOrder: 1 },
        records: candidate.records,
        filteredMessages: [
          {
            uuid: 'assistant-tool',
            parentUuid: null,
            type: 'assistant' as const,
            timestamp: new Date('2026-04-12T16:00:00.000Z'),
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'tool-1', name: 'task_add_comment', input: {} } as never],
            toolCalls: [],
            toolResults: [],
            isSidechain: false,
            isMeta: false,
            isCompactSummary: false,
          },
          {
            uuid: 'user-result',
            parentUuid: 'assistant-tool',
            type: 'user' as const,
            timestamp: new Date('2026-04-12T16:00:02.000Z'),
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-1',
                content: [{ type: 'text', text: '{\"comment\":{\"text\":\"useful comment\"}}' } as never],
              } as never,
            ],
            toolCalls: [],
            toolResults: [],
            sourceToolUseID: 'tool-1',
            sourceToolAssistantUUID: 'assistant-tool',
            toolUseResult: { toolUseId: 'tool-1', content: '{"comment":{"text":"useful comment"}}' },
            isSidechain: false,
            isMeta: false,
            isCompactSummary: false,
          },
        ],
      })),
    };
    const buildBundleChunks = vi.fn((messages: ParsedMessage[]) => [{ id: messages[0]?.uuid }]);

    const service = new BoardTaskLogStreamService(
      recordSource as never,
      summarySelector as never,
      strictParser as never,
      detailSelector as never,
      { buildBundleChunks } as never,
    );

    await service.getTaskLogStream('demo', 'task-a');

    const mergedMessages = buildBundleChunks.mock.calls[0]?.[0] as ParsedMessage[];
    const toolResultMessage = mergedMessages.find((message) => message.uuid === 'user-result');
    const content = Array.isArray(toolResultMessage?.content) ? toolResultMessage.content : [];
    expect(content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tool-1',
      content: 'useful comment',
    });
    expect(toolResultMessage?.toolUseResult).toEqual({ toolUseId: 'tool-1', content: 'useful comment' });
  });
});
