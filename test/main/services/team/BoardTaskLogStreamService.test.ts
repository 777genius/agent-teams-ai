import { afterEach, describe, expect, it, vi } from 'vitest';

import { BoardTaskLogStreamService } from '../../../../src/main/services/team/taskLogs/stream/BoardTaskLogStreamService';

import type { BoardTaskActivityRecord } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecord';
import type { BoardTaskExactLogBundleCandidate } from '../../../../src/main/services/team/taskLogs/exact/BoardTaskExactLogTypes';
import type { ParsedMessage } from '../../../../src/main/types';

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

  it('falls back to OpenCode runtime stream when transcript slices are empty', async () => {
    const runtimeFallbackSource = {
      getTaskLogStream: vi.fn(async () => ({
        participants: [
          {
            key: 'member:alice',
            label: 'alice',
            role: 'member' as const,
            isLead: false,
            isSidechain: true,
          },
        ],
        defaultFilter: 'member:alice',
        segments: [
          {
            id: 'opencode:segment-1',
            participantKey: 'member:alice',
            actor: {
              memberName: 'alice',
              role: 'member' as const,
              sessionId: 'session-opencode',
              isSidechain: true,
            },
            startTimestamp: '2026-04-21T10:00:00.000Z',
            endTimestamp: '2026-04-21T10:01:00.000Z',
            chunks: [{ id: 'chunk-1' }],
          },
        ],
        source: 'opencode_runtime_fallback' as const,
      })),
    };

    const service = new BoardTaskLogStreamService(
      {
        getTaskRecords: vi.fn(async () => []),
      } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      runtimeFallbackSource as never
    );

    const response = await service.getTaskLogStream('demo', 'task-a');

    expect(response.source).toBe('opencode_runtime_fallback');
    expect(response.segments).toHaveLength(1);
    expect(await service.getTaskLogStreamSummary('demo', 'task-a')).toEqual({
      segmentCount: 1,
    });
    expect(runtimeFallbackSource.getTaskLogStream).toHaveBeenCalledTimes(1);
  });

  it('dedupes concurrent OpenCode runtime fallback reads for the same task', async () => {
    let resolveFallback: (response: {
      participants: {
        key: string;
        label: string;
        role: 'member';
        isLead: false;
        isSidechain: true;
      }[];
      defaultFilter: string;
      segments: {
        id: string;
        participantKey: string;
        actor: {
          memberName: string;
          role: 'member';
          sessionId: string;
          isSidechain: true;
        };
        startTimestamp: string;
        endTimestamp: string;
        chunks: { id: string }[];
      }[];
      source: 'opencode_runtime_fallback';
    }) => void;
    const fallbackPromise = new Promise<{
      participants: {
        key: string;
        label: string;
        role: 'member';
        isLead: false;
        isSidechain: true;
      }[];
      defaultFilter: string;
      segments: {
        id: string;
        participantKey: string;
        actor: {
          memberName: string;
          role: 'member';
          sessionId: string;
          isSidechain: true;
        };
        startTimestamp: string;
        endTimestamp: string;
        chunks: { id: string }[];
      }[];
      source: 'opencode_runtime_fallback';
    }>((resolve) => {
      resolveFallback = resolve;
    });
    const runtimeFallbackSource = {
      getTaskLogStream: vi.fn(() => fallbackPromise),
    };

    const service = new BoardTaskLogStreamService(
      {
        getTaskRecords: vi.fn(async () => []),
      } as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      undefined as never,
      runtimeFallbackSource as never
    );

    const streamPromise = service.getTaskLogStream('demo', 'task-a');
    const summaryPromise = service.getTaskLogStreamSummary('demo', 'task-a');
    await vi.waitFor(() => {
      expect(runtimeFallbackSource.getTaskLogStream).toHaveBeenCalledTimes(1);
    });

    resolveFallback!({
      participants: [
        {
          key: 'member:alice',
          label: 'alice',
          role: 'member' as const,
          isLead: false,
          isSidechain: true,
        },
      ],
      defaultFilter: 'member:alice',
      segments: [
        {
          id: 'opencode:segment-1',
          participantKey: 'member:alice',
          actor: {
            memberName: 'alice',
            role: 'member' as const,
            sessionId: 'session-opencode',
            isSidechain: true,
          },
          startTimestamp: '2026-04-21T10:00:00.000Z',
          endTimestamp: '2026-04-21T10:01:00.000Z',
          chunks: [{ id: 'chunk-1' }],
        },
      ],
      source: 'opencode_runtime_fallback' as const,
    });

    const [stream, summary] = await Promise.all([streamPromise, summaryPromise]);
    expect(stream.segments).toHaveLength(1);
    expect(summary).toEqual({ segmentCount: 1 });
    expect(runtimeFallbackSource.getTaskLogStream).toHaveBeenCalledTimes(1);
  });

  it('merges OpenCode runtime stream using config provider when runtime meta has stale model only', async () => {
    const lead = {
      role: 'lead' as const,
      sessionId: 'session-lead',
      isSidechain: false,
    };
    const candidate = {
      ...makeCandidate('c1', '2026-04-12T16:00:00.000Z', lead, 'tool-board'),
      actionCategory: 'comment' as const,
      canonicalToolName: 'task_add_comment',
    };
    const runtimeFallbackSource = {
      getTaskLogStream: vi.fn(async () => ({
        participants: [
          {
            key: 'member:jack',
            label: 'jack',
            role: 'member' as const,
            isLead: false,
            isSidechain: true,
          },
        ],
        defaultFilter: 'member:jack',
        segments: [
          {
            id: 'opencode:demo:task-a:jack',
            participantKey: 'member:jack',
            actor: {
              memberName: 'jack',
              role: 'member' as const,
              sessionId: 'session-opencode',
              isSidechain: true,
            },
            startTimestamp: '2026-04-12T16:01:00.000Z',
            endTimestamp: '2026-04-12T16:02:00.000Z',
            chunks: [{ id: 'chunk-bash' }],
          },
        ],
        source: 'opencode_runtime_fallback' as const,
        runtimeProjection: {
          provider: 'opencode' as const,
          mode: 'heuristic' as const,
          attributionRecordCount: 0,
          projectedMessageCount: 2,
          fallbackReason: 'task_tool_markers' as const,
        },
      })),
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
        actor: lead,
        source: candidate.source,
        records: candidate.records,
        filteredMessages: [makeMessage('c1', '2026-04-12T16:00:00.000Z', 'board update')],
      })),
    };
    const taskReader = {
      getTasks: vi.fn(async () => [{ id: 'task-a', owner: 'jack' }]),
      getDeletedTasks: vi.fn(async () => []),
    };
    const membersMetaStore = {
      getMembers: vi.fn(async () => [{ name: 'jack', role: 'developer', model: 'gpt-5.5' }]),
    };
    const configReader = {
      getConfig: vi.fn(async () => ({
        name: 'demo',
        members: [{ name: 'jack', providerBackendId: 'opencode-cli', model: 'gpt-5.5' }],
      })),
    };
    const buildBundleChunks = vi.fn((messages: ParsedMessage[]) => [{ id: messages[0]?.uuid }]);

    const service = new BoardTaskLogStreamService(
      recordSource as never,
      summarySelector as never,
      strictParser as never,
      detailSelector as never,
      { buildBundleChunks } as never,
      taskReader as never,
      undefined as never,
      runtimeFallbackSource as never,
      membersMetaStore as never,
      configReader as never
    );

    const response = await service.getTaskLogStream('demo', 'task-a');

    expect(runtimeFallbackSource.getTaskLogStream).toHaveBeenCalledWith('demo', 'task-a');
    expect(response.defaultFilter).toBe('member:jack');
    expect(response.participants.map((participant) => participant.key)).toEqual([
      'member:jack',
      'lead',
    ]);
    expect(response.segments.map((segment) => segment.id)).toEqual([
      'lead:c1:c1',
      'opencode:demo:task-a:jack',
    ]);
    expect(response.runtimeProjection).toMatchObject({
      provider: 'opencode',
      projectedMessageCount: 2,
    });
  });

  it('does not suppress exact OpenCode fallback because of unrelated execution records', async () => {
    const lead = {
      role: 'lead' as const,
      sessionId: 'session-lead',
      isSidechain: false,
    };
    const baseCandidate = makeCandidate(
      'c1',
      '2026-04-12T16:00:00.000Z',
      lead,
      'tool-board'
    );
    const executionRecord: BoardTaskActivityRecord = {
      ...baseCandidate.records[0]!,
      linkKind: 'execution',
    };
    const candidate: BoardTaskExactLogBundleCandidate = {
      ...baseCandidate,
      records: [executionRecord],
      linkKinds: ['execution'],
    };
    const runtimeFallbackSource = {
      getTaskLogStream: vi.fn(async () => ({
        participants: [
          {
            key: 'member:jack',
            label: 'jack',
            role: 'member' as const,
            isLead: false,
            isSidechain: true,
          },
        ],
        defaultFilter: 'member:jack',
        segments: [
          {
            id: 'opencode:demo:task-a:jack:session-opencode',
            participantKey: 'member:jack',
            actor: {
              memberName: 'jack',
              role: 'member' as const,
              sessionId: 'session-opencode',
              isSidechain: true,
            },
            startTimestamp: '2026-04-12T16:01:00.000Z',
            endTimestamp: '2026-04-12T16:02:00.000Z',
            chunks: [{ id: 'chunk-exact-opencode' }],
          },
        ],
        source: 'opencode_runtime_attribution' as const,
        runtimeProjection: {
          provider: 'opencode' as const,
          mode: 'attribution' as const,
          attributionRecordCount: 1,
          projectedMessageCount: 2,
        },
      })),
    };
    const service = new BoardTaskLogStreamService(
      {
        getTaskRecords: vi.fn(async () => candidate.records),
      } as never,
      {
        selectSummaries: vi.fn(() => [candidate]),
      } as never,
      {
        parseFiles: vi.fn(async () => new Map([['/tmp/task.jsonl', []]])),
      } as never,
      {
        selectDetail: vi.fn(() => ({
          id: 'c1',
          timestamp: '2026-04-12T16:00:00.000Z',
          actor: lead,
          source: candidate.source,
          records: candidate.records,
          filteredMessages: [makeMessage('c1', '2026-04-12T16:00:00.000Z', 'lead execution')],
        })),
      } as never,
      {
        buildBundleChunks: vi.fn((messages: ParsedMessage[]) => [{ id: messages[0]?.uuid }]),
      } as never,
      {
        getTasks: vi.fn(async () => [{ id: 'task-a', owner: 'jack' }]),
        getDeletedTasks: vi.fn(async () => []),
      } as never,
      undefined as never,
      runtimeFallbackSource as never,
      {
        getMembers: vi.fn(async () => [{ name: 'jack', providerId: 'opencode' }]),
      } as never,
      {
        getConfig: vi.fn(async () => null),
      } as never
    );

    const response = await service.getTaskLogStream('demo', 'task-a');

    expect(runtimeFallbackSource.getTaskLogStream).toHaveBeenCalledWith('demo', 'task-a');
    expect(response.source).toBe('mixed_transcript_opencode_runtime');
    expect(response.segments.map((segment) => segment.id)).toEqual([
      'lead:c1:c1',
      'opencode:demo:task-a:jack:session-opencode',
    ]);
  });

  it('does not probe OpenCode runtime for non-OpenCode task owners', async () => {
    const lead = {
      role: 'lead' as const,
      sessionId: 'session-lead',
      isSidechain: false,
    };
    const candidate = makeCandidate('c1', '2026-04-12T16:00:00.000Z', lead, 'tool-board');
    const runtimeFallbackSource = {
      getTaskLogStream: vi.fn(async () => {
        throw new Error('should not be called');
      }),
    };
    const service = new BoardTaskLogStreamService(
      {
        getTaskRecords: vi.fn(async () => candidate.records),
      } as never,
      {
        selectSummaries: vi.fn(() => [candidate]),
      } as never,
      {
        parseFiles: vi.fn(async () => new Map([['/tmp/task.jsonl', []]])),
      } as never,
      {
        selectDetail: vi.fn(() => ({
          id: 'c1',
          timestamp: '2026-04-12T16:00:00.000Z',
          actor: lead,
          source: candidate.source,
          records: candidate.records,
          filteredMessages: [makeMessage('c1', '2026-04-12T16:00:00.000Z', 'board update')],
        })),
      } as never,
      {
        buildBundleChunks: vi.fn((messages: ParsedMessage[]) => [{ id: messages[0]?.uuid }]),
      } as never,
      {
        getTasks: vi.fn(async () => [{ id: 'task-a', owner: 'alice' }]),
        getDeletedTasks: vi.fn(async () => []),
      } as never,
      undefined as never,
      runtimeFallbackSource as never,
      {
        getMembers: vi.fn(async () => [{ name: 'alice', providerId: 'codex' }]),
      } as never,
      {
        getConfig: vi.fn(async () => null),
      } as never
    );

    await service.getTaskLogStream('demo', 'task-a');

    expect(runtimeFallbackSource.getTaskLogStream).not.toHaveBeenCalled();
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

  it('returns lightweight segment count without building stream chunks', async () => {
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
    const candidates = [
      makeCandidate('c1', '2026-04-12T16:00:00.000Z', tom, 'tool-1'),
      makeCandidate('c2', '2026-04-12T16:01:00.000Z', tom, 'tool-2'),
      makeCandidate('c3', '2026-04-12T16:02:00.000Z', alice, 'tool-3'),
      makeCandidate('c4', '2026-04-12T16:03:00.000Z', tom, 'tool-4'),
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

    await expect(service.getTaskLogStreamSummary('demo', 'task-a')).resolves.toEqual({
      segmentCount: 3,
    });
    expect(buildBundleChunks).not.toHaveBeenCalled();
  });

  it('shares concurrent summary and stream layout work', async () => {
    const tom = {
      memberName: 'tom',
      role: 'member' as const,
      sessionId: 'session-tom',
      agentId: 'agent-tom',
      isSidechain: true,
    };
    const candidates = [
      makeCandidate('c1', '2026-04-12T16:00:00.000Z', tom, 'tool-1'),
      makeCandidate('c2', '2026-04-12T16:01:00.000Z', tom, 'tool-2'),
    ];

    const recordSource = {
      getTaskRecords: vi.fn(async () => {
        await Promise.resolve();
        return candidates.flatMap((candidate) => candidate.records);
      }),
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
    const taskReader = {
      getTasks: vi.fn(async () => [
        {
          id: 'task-a',
          displayId: 'abcd1234',
          owner: 'tom',
          status: 'in_progress',
          createdAt: '2026-04-12T15:59:00.000Z',
          updatedAt: '2026-04-12T16:05:00.000Z',
        },
      ]),
      getDeletedTasks: vi.fn(async () => []),
    };
    const transcriptSourceLocator = {
      getGeneration: vi.fn(() => 0),
      getContext: vi.fn(async () => ({
        transcriptFiles: [],
        config: { members: [] },
      })),
    };

    const service = new BoardTaskLogStreamService(
      recordSource as never,
      summarySelector as never,
      strictParser as never,
      detailSelector as never,
      { buildBundleChunks } as never,
      taskReader as never,
      transcriptSourceLocator as never
    );

    const [summary, response] = await Promise.all([
      service.getTaskLogStreamSummary('demo', 'task-a'),
      service.getTaskLogStream('demo', 'task-a'),
    ]);

    expect(summary).toEqual({ segmentCount: 1 });
    expect(response.segments).toHaveLength(1);
    expect(recordSource.getTaskRecords).toHaveBeenCalledTimes(1);
    expect(strictParser.parseFiles).toHaveBeenCalledTimes(1);
    expect(transcriptSourceLocator.getContext).toHaveBeenCalledTimes(1);
  });

  it('does not cache a stream layout when transcript discovery changes during build', async () => {
    const tom = {
      memberName: 'tom',
      role: 'member' as const,
      sessionId: 'session-tom',
      agentId: 'agent-tom',
      isSidechain: true,
    };
    const baseCandidate = makeCandidate(
      'c1',
      '2026-04-12T16:00:00.000Z',
      tom,
      'tool-1'
    );
    const executionRecord: BoardTaskActivityRecord = {
      ...baseCandidate.records[0]!,
      linkKind: 'execution',
    };
    const candidate: BoardTaskExactLogBundleCandidate = {
      ...baseCandidate,
      records: [executionRecord],
      linkKinds: ['execution'],
    };
    let generation = 0;
    let recordReadCount = 0;
    const recordSource = {
      getTaskRecords: vi.fn(async () => {
        recordReadCount += 1;
        if (recordReadCount === 1) {
          generation += 1;
        }
        return candidate.records;
      }),
    };
    const summarySelector = {
      selectSummaries: vi.fn(() => [candidate]),
    };
    const strictParser = {
      parseFiles: vi.fn(async () => new Map([['/tmp/task.jsonl', []]])),
    };
    const detailSelector = {
      selectDetail: vi.fn(() => ({
        id: candidate.id,
        timestamp: candidate.timestamp,
        actor: candidate.actor,
        source: candidate.source,
        records: candidate.records,
        filteredMessages: [makeMessage(candidate.id, candidate.timestamp, 'native work')],
      })),
    };
    const transcriptSourceLocator = {
      getGeneration: vi.fn(() => generation),
      getContext: vi.fn(async () => null),
    };
    const buildBundleChunks = vi.fn((messages: ParsedMessage[]) => [{ id: messages[0]?.uuid }]);

    const service = new BoardTaskLogStreamService(
      recordSource as never,
      summarySelector as never,
      strictParser as never,
      detailSelector as never,
      { buildBundleChunks } as never,
      undefined as never,
      transcriptSourceLocator as never
    );

    await service.getTaskLogStream('demo', 'task-a');
    await service.getTaskLogStream('demo', 'task-a');
    await service.getTaskLogStream('demo', 'task-a');

    expect(recordSource.getTaskRecords).toHaveBeenCalledTimes(2);
    expect(buildBundleChunks).toHaveBeenCalledTimes(3);
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

  it('does not use read-only task readers as inferred execution participants', async () => {
    const alice = {
      memberName: 'alice',
      role: 'member' as const,
      sessionId: 'session-alice',
      isSidechain: false,
    };
    const readRecord = {
      ...makeRecord('alice-read', '2026-04-12T16:00:00.000Z', alice, 'tool-read'),
      action: {
        canonicalToolName: 'task_get',
        toolUseId: 'tool-read',
        category: 'read' as const,
      },
    };
    const readCandidate: BoardTaskExactLogBundleCandidate = {
      ...makeCandidate('alice-read', '2026-04-12T16:00:00.000Z', alice, 'tool-read'),
      records: [readRecord],
      actionCategory: 'read',
      canonicalToolName: 'task_get',
    };
    const aliceRuntimeMessage: ParsedMessage = {
      uuid: 'alice-bash',
      parentUuid: null,
      type: 'assistant',
      timestamp: new Date('2026-04-12T16:02:00.000Z'),
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tool-bash',
          name: 'Bash',
          input: { command: 'git diff' },
        } as never,
      ],
      toolCalls: [
        {
          id: 'tool-bash',
          name: 'Bash',
          input: { command: 'git diff' },
          isTask: false,
        },
      ],
      toolResults: [],
      sessionId: 'session-alice',
      agentName: 'alice',
      isSidechain: false,
      isMeta: false,
      isCompactSummary: false,
    };

    const recordSource = {
      getTaskRecords: vi.fn(async () => [readRecord]),
    };
    const summarySelector = {
      selectSummaries: vi.fn(() => [readCandidate]),
    };
    const strictParser = {
      parseFiles: vi.fn(async (filePaths: string[]) =>
        new Map(
          filePaths.map((filePath) => [
            filePath,
            filePath === '/tmp/alice.jsonl' ? [aliceRuntimeMessage] : [],
          ])
        )
      ),
    };
    const detailSelector = {
      selectDetail: vi.fn(() => ({
        id: 'alice-read',
        timestamp: '2026-04-12T16:00:00.000Z',
        actor: alice,
        source: readCandidate.source,
        records: [readRecord],
        filteredMessages: [makeMessage('alice-read-detail', '2026-04-12T16:00:00.000Z', 'read')],
      })),
    };
    const taskReader = {
      getTasks: vi.fn(async () => [
        {
          id: 'task-a',
          displayId: 'abcd1234',
          owner: 'tom',
          status: 'in_progress',
          createdAt: '2026-04-12T15:59:00.000Z',
          updatedAt: '2026-04-12T16:05:00.000Z',
        },
      ]),
      getDeletedTasks: vi.fn(async () => []),
    };
    const transcriptSourceLocator = {
      getContext: vi.fn(async () => ({
        transcriptFiles: ['/tmp/task.jsonl', '/tmp/alice.jsonl'],
        config: { members: [{ name: 'team-lead', agentType: 'team-lead' }] },
      })),
    };
    const runtimeFallbackSource = {
      getTaskLogStream: vi.fn(async () => null),
    };
    const buildBundleChunks = vi.fn((messages: ParsedMessage[]) => [{ id: messages[0]?.uuid }]);

    const service = new BoardTaskLogStreamService(
      recordSource as never,
      summarySelector as never,
      strictParser as never,
      detailSelector as never,
      { buildBundleChunks } as never,
      taskReader as never,
      transcriptSourceLocator as never,
      runtimeFallbackSource as never,
      { getMembers: vi.fn(async () => [{ name: 'tom', providerId: 'codex' }]) } as never,
      { getConfig: vi.fn(async () => null) } as never
    );

    const response = await service.getTaskLogStream('demo', 'task-a');

    expect(response.segments).toHaveLength(1);
    expect(response.segments[0]?.participantKey).toBe('member:alice');
    const mergedMessages = buildBundleChunks.mock.calls[0]?.[0] as ParsedMessage[];
    expect(mergedMessages.map((message) => message.uuid)).toEqual(['alice-read-detail']);
    expect(strictParser.parseFiles).toHaveBeenCalledTimes(1);
    expect(strictParser.parseFiles.mock.calls.flatMap((call) => call[0] as string[])).not.toContain(
      '/tmp/alice.jsonl'
    );
  });

  it('limits inferred native parsing to direct and same-session transcript candidates', async () => {
    const projectDir = '/tmp/task-log-project';
    const rootFile = `${projectDir}/session-alice.jsonl`;
    const subagentFile = `${projectDir}/session-alice/subagents/agent-worker.jsonl`;
    const unrelatedFiles = Array.from(
      { length: 300 },
      (_, index) => `${projectDir}/session-unrelated-${index}.jsonl`
    );
    const alice = {
      memberName: 'alice',
      role: 'member' as const,
      sessionId: 'session-alice',
      isSidechain: false,
    };
    const baseRecord = makeRecord(
      'alice-comment',
      '2026-04-12T16:00:00.000Z',
      alice,
      'tool-comment'
    );
    const commentRecord: BoardTaskActivityRecord = {
      ...baseRecord,
      action: {
        canonicalToolName: 'task_add_comment',
        toolUseId: 'tool-comment',
        category: 'comment',
      },
      source: {
        ...baseRecord.source,
        filePath: rootFile,
      },
    };
    const candidate: BoardTaskExactLogBundleCandidate = {
      ...makeCandidate('alice-comment', '2026-04-12T16:00:00.000Z', alice, 'tool-comment'),
      source: commentRecord.source,
      records: [commentRecord],
      actionCategory: 'comment',
      canonicalToolName: 'task_add_comment',
    };
    const nativeMessage: ParsedMessage = {
      uuid: 'alice-bash',
      parentUuid: null,
      type: 'assistant',
      timestamp: new Date('2026-04-12T16:01:00.000Z'),
      role: 'assistant',
      content: [
        {
          type: 'tool_use',
          id: 'tool-bash',
          name: 'Bash',
          input: { command: 'npm test' },
        } as never,
      ],
      toolCalls: [
        {
          id: 'tool-bash',
          name: 'Bash',
          input: { command: 'npm test' },
          isTask: false,
        },
      ],
      toolResults: [],
      sessionId: 'session-alice',
      agentName: 'alice',
      isSidechain: false,
      isMeta: false,
      isCompactSummary: false,
    };
    const recordSource = {
      getTaskRecords: vi.fn(async () => [commentRecord]),
    };
    const summarySelector = {
      selectSummaries: vi.fn(() => [candidate]),
    };
    const strictParser = {
      parseFiles: vi.fn(async (filePaths: string[]) =>
        new Map(
          filePaths.map((filePath) => [
            filePath,
            filePath === subagentFile ? [nativeMessage] : [],
          ])
        )
      ),
    };
    const detailSelector = {
      selectDetail: vi.fn(() => ({
        id: 'alice-comment',
        timestamp: '2026-04-12T16:00:00.000Z',
        actor: alice,
        source: candidate.source,
        records: [commentRecord],
        filteredMessages: [
          makeMessage('alice-comment-detail', '2026-04-12T16:00:00.000Z', 'comment'),
        ],
      })),
    };
    const taskReader = {
      getTasks: vi.fn(async () => [
        {
          id: 'task-a',
          displayId: 'abcd1234',
          owner: 'alice',
          status: 'in_progress',
          createdAt: '2026-04-12T15:59:00.000Z',
          updatedAt: '2026-04-12T16:05:00.000Z',
        },
      ]),
      getDeletedTasks: vi.fn(async () => []),
    };
    const transcriptSourceLocator = {
      getContext: vi.fn(async () => ({
        projectDir,
        transcriptFiles: [rootFile, subagentFile, ...unrelatedFiles],
        config: { members: [{ name: 'team-lead', agentType: 'team-lead' }] },
      })),
    };
    const buildBundleChunks = vi.fn((messages: ParsedMessage[]) => [{ id: messages[0]?.uuid }]);

    const service = new BoardTaskLogStreamService(
      recordSource as never,
      summarySelector as never,
      strictParser as never,
      detailSelector as never,
      { buildBundleChunks } as never,
      taskReader as never,
      transcriptSourceLocator as never,
      { getTaskLogStream: vi.fn(async () => null) } as never,
      { getMembers: vi.fn(async () => [{ name: 'alice', providerId: 'codex' }]) } as never,
      { getConfig: vi.fn(async () => null) } as never,
      { getTaskLogStream: vi.fn(async () => null) } as never
    );

    await service.getTaskLogStream('demo', 'task-a');

    expect(strictParser.parseFiles.mock.calls.map((call) => call[0])).toEqual([
      [rootFile],
      [subagentFile],
    ]);
    const parsedFiles = strictParser.parseFiles.mock.calls.flatMap((call) => call[0] as string[]);
    expect(parsedFiles).not.toEqual(expect.arrayContaining(unrelatedFiles));
    expect(buildBundleChunks.mock.calls[0]?.[0].map((message: ParsedMessage) => message.uuid)).toEqual([
      'alice-comment-detail',
      'alice-bash',
    ]);
  });

  it('limits historical board MCP recovery parsing to raw-probe candidate files', async () => {
    const hitFile = '/tmp/historical-hit.jsonl';
    const unrelatedFile = '/tmp/historical-unrelated.jsonl';
    const taskReader = {
      getTasks: vi.fn(async () => [
        {
          id: 'task-a',
          displayId: 'abcd1234',
          owner: 'tom',
          status: 'completed',
          createdAt: '2026-04-12T16:00:00.000Z',
          updatedAt: '2026-04-12T16:05:00.000Z',
        },
      ]),
      getDeletedTasks: vi.fn(async () => []),
    };
    const transcriptSourceLocator = {
      getContext: vi.fn(async () => ({
        transcriptFiles: [hitFile, unrelatedFile],
        config: {
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
      })),
    };
    const strictParser = {
      parseFiles: vi.fn(async () => new Map<string, ParsedMessage[]>([[hitFile, []]])),
    };
    const summarySelector = {
      selectSummaries: vi.fn(() => {
        throw new Error('empty parsed historical candidate should not create records');
      }),
    };
    const rawProbe = {
      findCandidateFiles: vi.fn(async () => ({
        filePaths: [hitFile],
        scannedFileCount: 2,
        hitCount: 1,
        elapsedMs: 0,
      })),
    };

    const service = new BoardTaskLogStreamService(
      { getTaskRecords: vi.fn(async () => []) } as never,
      summarySelector as never,
      strictParser as never,
      undefined as never,
      undefined as never,
      taskReader as never,
      transcriptSourceLocator as never,
      { getTaskLogStream: vi.fn(async () => null) } as never,
      undefined as never,
      undefined as never,
      { getTaskLogStream: vi.fn(async () => null) } as never,
      undefined as never,
      rawProbe as never
    );

    await expect(service.getTaskLogStream('demo', 'task-a')).resolves.toEqual({
      participants: [],
      defaultFilter: 'all',
      segments: [],
    });
    expect(rawProbe.findCandidateFiles).toHaveBeenCalledWith({
      task: expect.objectContaining({ id: 'task-a' }),
      transcriptFiles: [hitFile, unrelatedFile],
    });
    expect(strictParser.parseFiles).toHaveBeenCalledWith([hitFile]);
  });

  it('does not recover task_get logs from nested task refs in result payloads', async () => {
    const taskReader = {
      getTasks: vi.fn(async () => [
        {
          id: 'task-a',
          displayId: 'abcd1234',
          owner: 'tom',
          status: 'completed',
          createdAt: '2026-04-12T16:00:00.000Z',
          updatedAt: '2026-04-12T16:05:00.000Z',
        },
      ]),
      getDeletedTasks: vi.fn(async () => []),
    };
    const transcriptSourceLocator = {
      getContext: vi.fn(async () => ({
        transcriptFiles: ['/tmp/lead.jsonl'],
        config: {
          members: [{ name: 'team-lead', agentType: 'team-lead' }],
        },
      })),
    };
    const strictParser = {
      parseFiles: vi.fn(async () =>
        new Map<string, ParsedMessage[]>([
          [
            '/tmp/lead.jsonl',
            [
              {
                uuid: 'assistant-task-get',
                parentUuid: null,
                type: 'assistant' as const,
                timestamp: new Date('2026-04-12T16:01:00.000Z'),
                role: 'assistant',
                content: [
                  {
                    type: 'tool_use',
                    id: 'tool-task-get',
                    name: 'task_get',
                    input: { teamName: 'demo', taskId: 'parent-task' },
                  } as never,
                ],
                toolCalls: [
                  {
                    id: 'tool-task-get',
                    name: 'task_get',
                    input: { teamName: 'demo', taskId: 'parent-task' },
                    isTask: false,
                  },
                ],
                toolResults: [],
                isSidechain: false,
                isMeta: false,
                isCompactSummary: false,
              },
              {
                uuid: 'user-task-get-result',
                parentUuid: 'assistant-task-get',
                type: 'user' as const,
                timestamp: new Date('2026-04-12T16:01:01.000Z'),
                role: 'user',
                content: [
                  {
                    type: 'tool_result',
                    tool_use_id: 'tool-task-get',
                    content: JSON.stringify({
                      id: 'parent-task',
                      displayId: 'parent',
                      blockedBy: ['task-a'],
                    }),
                  } as never,
                ],
                toolCalls: [],
                toolResults: [
                  {
                    toolUseId: 'tool-task-get',
                    content: JSON.stringify({
                      id: 'parent-task',
                      displayId: 'parent',
                      blockedBy: ['task-a'],
                    }),
                    isError: false,
                  },
                ],
                sourceToolUseID: 'tool-task-get',
                sourceToolAssistantUUID: 'assistant-task-get',
                toolUseResult: {
                  toolUseId: 'tool-task-get',
                  content: JSON.stringify({
                    id: 'parent-task',
                    displayId: 'parent',
                    blockedBy: ['task-a'],
                  }),
                },
                isSidechain: false,
                isMeta: false,
                isCompactSummary: false,
              },
            ],
          ],
        ])
      ),
    };
    const summarySelector = {
      selectSummaries: vi.fn(() => {
        throw new Error('task_get result payload should not create recovered records');
      }),
    };
    const runtimeFallbackSource = {
      getTaskLogStream: vi.fn(async () => null),
    };

    const service = new BoardTaskLogStreamService(
      { getTaskRecords: vi.fn(async () => []) } as never,
      summarySelector as never,
      strictParser as never,
      undefined as never,
      undefined as never,
      taskReader as never,
      transcriptSourceLocator as never,
      runtimeFallbackSource as never
    );

    await expect(service.getTaskLogStream('demo', 'task-a')).resolves.toEqual({
      participants: [],
      defaultFilter: 'all',
      segments: [],
    });
    expect(summarySelector.selectSummaries).not.toHaveBeenCalled();
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

  it('sanitizes SendMessage json payloads into a concise human-readable result', async () => {
    const bob = {
      memberName: 'bob',
      role: 'member' as const,
      sessionId: 'session-bob',
      agentId: 'agent-bob',
      isSidechain: true,
    };
    const candidate = {
      ...makeCandidate('c1', '2026-04-12T16:00:00.000Z', bob, 'tool-send'),
      actionCategory: 'execution' as const,
      canonicalToolName: 'SendMessage',
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
        actor: bob,
        source: {
          filePath: '/tmp/task.jsonl',
          messageUuid: 'assistant-send',
          toolUseId: 'tool-send',
          sourceOrder: 1,
        },
        records: candidate.records,
        filteredMessages: [
          {
            uuid: 'assistant-send',
            parentUuid: null,
            type: 'assistant' as const,
            timestamp: new Date('2026-04-12T16:00:00.000Z'),
            role: 'assistant',
            content: [
              {
                type: 'tool_use',
                id: 'tool-send',
                name: 'SendMessage',
                input: { to: 'team-lead', summary: '#abc done' },
              } as never,
            ],
            toolCalls: [],
            toolResults: [],
            isSidechain: false,
            isMeta: false,
            isCompactSummary: false,
          },
          {
            uuid: 'user-send-result',
            parentUuid: 'assistant-send',
            type: 'user' as const,
            timestamp: new Date('2026-04-12T16:00:02.000Z'),
            role: 'user',
            content: [
              {
                type: 'tool_result',
                tool_use_id: 'tool-send',
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      message: "Message sent to team-lead's inbox",
                      routing: {
                        target: '@team-lead',
                        summary: '#abc done',
                        content: 'Detailed body that should not leak into the preview.',
                      },
                    }),
                  } as never,
                ],
              } as never,
            ],
            toolCalls: [],
            toolResults: [
              {
                toolUseId: 'tool-send',
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      success: true,
                      message: "Message sent to team-lead's inbox",
                      routing: {
                        target: '@team-lead',
                        summary: '#abc done',
                        content: 'Detailed body that should not leak into the preview.',
                      },
                    }),
                  },
                ],
                isError: false,
              },
            ],
            sourceToolUseID: 'tool-send',
            sourceToolAssistantUUID: 'assistant-send',
            toolUseResult: {
              success: true,
              message: "Message sent to team-lead's inbox",
              routing: {
                target: '@team-lead',
                summary: '#abc done',
                content: 'Detailed body that should not leak into the preview.',
              },
            },
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
    const toolResultMessage = mergedMessages.find((message) => message.uuid === 'user-send-result');
    const content = Array.isArray(toolResultMessage?.content) ? toolResultMessage.content : [];
    expect(content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'tool-send',
      content: "Message sent to team-lead's inbox - #abc done",
    });
    expect(toolResultMessage?.toolResults).toEqual([
      {
        toolUseId: 'tool-send',
        content: "Message sent to team-lead's inbox - #abc done",
        isError: false,
      },
    ]);
  });

  it('sanitizes MCP task_complete and message_send json payloads into readable results', async () => {
    const tom = {
      memberName: 'tom',
      role: 'member' as const,
      sessionId: 'session-tom',
      isSidechain: false,
    };
    const completeCandidate = {
      ...makeCandidate('c-complete', '2026-04-12T16:00:00.000Z', tom, 'tool-complete'),
      actionCategory: 'status' as const,
      canonicalToolName: 'task_complete',
    };
    const sendCandidate = {
      ...makeCandidate('c-send', '2026-04-12T16:00:01.000Z', tom, 'tool-send'),
      actionCategory: 'other' as const,
      canonicalToolName: 'mcp__agent-teams__message_send',
    };

    const recordSource = {
      getTaskRecords: vi.fn(async () => [
        ...completeCandidate.records,
        ...sendCandidate.records,
      ]),
    };
    const summarySelector = {
      selectSummaries: vi.fn(() => [completeCandidate, sendCandidate]),
    };
    const strictParser = {
      parseFiles: vi.fn(async () => new Map([['/tmp/task.jsonl', []]])),
    };
    const detailSelector = {
      selectDetail: vi.fn(({ candidate }: { candidate: BoardTaskExactLogBundleCandidate }) => {
        const isComplete = candidate.id === 'c-complete';
        const toolUseId = isComplete ? 'tool-complete' : 'tool-send';
        const toolName = isComplete ? 'task_complete' : 'mcp__agent-teams__message_send';
        const payload = isComplete
          ? { id: 'task-a', displayId: 'abcd1234', status: 'completed' }
          : {
              deliveredToInbox: true,
              message: {
                from: 'tom',
                to: 'team-lead',
                text: 'Detailed body',
                summary: '#abcd1234 done',
              },
            };

        return {
          id: candidate.id,
          timestamp: candidate.timestamp,
          actor: tom,
          source: candidate.source,
          records: candidate.records,
          filteredMessages: [
            {
              uuid: `${candidate.id}-assistant`,
              parentUuid: null,
              type: 'assistant' as const,
              timestamp: new Date(candidate.timestamp),
              role: 'assistant',
              content: [{ type: 'tool_use', id: toolUseId, name: toolName, input: {} } as never],
              toolCalls: [],
              toolResults: [],
              isSidechain: false,
              isMeta: false,
              isCompactSummary: false,
            },
            {
              uuid: `${candidate.id}-result`,
              parentUuid: `${candidate.id}-assistant`,
              type: 'user' as const,
              timestamp: new Date(candidate.timestamp),
              role: 'user',
              content: [
                {
                  type: 'tool_result',
                  tool_use_id: toolUseId,
                  content: [{ type: 'text', text: JSON.stringify(payload) } as never],
                } as never,
              ],
              toolCalls: [],
              toolResults: [
                {
                  toolUseId,
                  content: [{ type: 'text', text: JSON.stringify(payload) }],
                  isError: false,
                },
              ],
              sourceToolUseID: toolUseId,
              sourceToolAssistantUUID: `${candidate.id}-assistant`,
              toolUseResult: {
                toolUseId,
                content: JSON.stringify(payload),
              },
              isSidechain: false,
              isMeta: false,
              isCompactSummary: false,
            },
          ],
        };
      }),
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
    const completeResult = mergedMessages.find((message) => message.uuid === 'c-complete-result');
    const sendResult = mergedMessages.find((message) => message.uuid === 'c-send-result');
    expect(completeResult?.toolResults).toEqual([
      {
        toolUseId: 'tool-complete',
        content: 'Task abcd1234 completed',
        isError: false,
      },
    ]);
    expect(sendResult?.toolResults).toEqual([
      {
        toolUseId: 'tool-send',
        content: 'Message sent to team-lead - #abcd1234 done',
        isError: false,
      },
    ]);
  });
  it('merges Codex native trace fallback even when primary transcript has MCP execution records', async () => {
    const atlas = {
      memberName: 'atlas',
      role: 'member' as const,
      sessionId: 'session-atlas',
      agentId: 'agent-atlas',
      isSidechain: true,
    };
    const baseCandidate = makeCandidate(
      'c1',
      '2026-05-01T17:10:00.000Z',
      atlas,
      'mcp-tool-1'
    );
    const executionRecord: BoardTaskActivityRecord = {
      ...baseCandidate.records[0]!,
      linkKind: 'execution',
    };
    const candidate: BoardTaskExactLogBundleCandidate = {
      ...baseCandidate,
      records: [executionRecord],
      linkKinds: ['execution'],
    };
    const recordSource = {
      getTaskRecords: vi.fn(async () => candidate.records),
    };
    const summarySelector = {
      selectSummaries: vi.fn(() => [candidate]),
    };
    const strictParser = {
      parseFiles: vi.fn(async () => new Map([['/tmp/codex-task.jsonl', []]])),
    };
    const detailSelector = {
      selectDetail: vi.fn(() => ({
        id: candidate.id,
        timestamp: candidate.timestamp,
        actor: atlas,
        source: candidate.source,
        records: candidate.records,
        filteredMessages: [makeMessage('mcp-message', '2026-05-01T17:10:00.000Z', 'mcp task_start')],
      })),
    };
    const buildBundleChunks = vi.fn((messages: ParsedMessage[]) => [{ id: messages[0]?.uuid }]);
    const openCodeRuntimeFallbackSource = {
      getTaskLogStream: vi.fn(async () => {
        throw new Error('OpenCode fallback should stay behind OpenCode-only conditions');
      }),
    };
    const membersMetaStore = {
      getMembers: vi.fn(async () => [{ name: 'atlas', providerId: 'codex' }]),
    };
    const configReader = {
      getConfig: vi.fn(async () => null),
    };
    const codexNativeTraceFallbackSource = {
      getTaskLogStream: vi.fn(async () => ({
        participants: [
          {
            key: 'member:atlas',
            label: 'atlas',
            role: 'member' as const,
            isLead: false,
            isSidechain: true,
          },
        ],
        defaultFilter: 'member:atlas',
        segments: [
          {
            id: 'codex-native:demo:task-a:atlas',
            participantKey: 'member:atlas',
            actor: atlas,
            startTimestamp: '2026-05-01T17:10:02.000Z',
            endTimestamp: '2026-05-01T17:10:05.000Z',
            chunks: [{ id: 'bash-chunk' }],
          },
        ],
        source: 'codex_native_trace_fallback' as const,
        runtimeProjection: {
          provider: 'codex_native' as const,
          mode: 'trace' as const,
          attributionRecordCount: 0,
          projectedMessageCount: 2,
          nativeToolCount: 1,
          fallbackReason: 'codex_native_trace' as const,
          traceFileCount: 1,
          traceRunCount: 1,
          dedupedNativeToolCount: 0,
        },
      })),
    };

    const service = new BoardTaskLogStreamService(
      recordSource as never,
      summarySelector as never,
      strictParser as never,
      detailSelector as never,
      { buildBundleChunks } as never,
      undefined as never,
      undefined as never,
      openCodeRuntimeFallbackSource as never,
      membersMetaStore as never,
      configReader as never,
      codexNativeTraceFallbackSource as never
    );

    const response = await service.getTaskLogStream('demo', 'task-a');

    expect(openCodeRuntimeFallbackSource.getTaskLogStream).not.toHaveBeenCalled();
    expect(codexNativeTraceFallbackSource.getTaskLogStream).toHaveBeenCalledWith(
      'demo',
      'task-a',
      { excludeNativeToolSignatures: expect.any(Set) }
    );
    expect(response.source).toBe('mixed_transcript_codex_native_trace');
    expect(response.participants.map((participant) => participant.key)).toEqual(['member:atlas']);
    expect(response.segments.map((segment) => segment.id)).toEqual([
      'member:atlas:c1:c1',
      'codex-native:demo:task-a:atlas',
    ]);
    expect(response.runtimeProjection).toMatchObject({
      provider: 'codex_native',
      nativeToolCount: 1,
    });
  });

});
