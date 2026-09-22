import { describe, expect, it, vi } from 'vitest';

import { BoardTaskExactLogDetailService } from '../../../../src/main/services/team/taskLogs/exact/BoardTaskExactLogDetailService';

import type { BoardTaskActivityRecord } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecord';
import type {
  BoardTaskExactLogBundleCandidate,
  BoardTaskExactLogDetailCandidate,
} from '../../../../src/main/services/team/taskLogs/exact/BoardTaskExactLogTypes';

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
      messageUuid: 'msg-1',
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
      messageUuid: 'msg-1',
      toolUseId: 'tool-1',
      sourceOrder: 1,
    },
    records,
    anchor: {
      kind: 'tool',
      filePath: '/tmp/task.jsonl',
      messageUuid: 'msg-1',
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

describe('BoardTaskExactLogDetailService', () => {
  it('returns missing when the exact-log read flag is disabled', async () => {
    vi.stubEnv('CLAUDE_TEAM_BOARD_TASK_EXACT_LOGS_READ_ENABLED', 'false');
    const recordSource = { getTaskRecords: vi.fn(async () => []) };
    const service = new BoardTaskExactLogDetailService(
      recordSource as never,
      { selectSummaries: vi.fn() } as never,
      { parseFiles: vi.fn() } as never,
      { selectDetail: vi.fn() } as never,
      { buildBundleChunks: vi.fn() } as never
    );

    await expect(
      service.getTaskExactLogDetail('demo', 'task-a', 'tool:/tmp/task.jsonl:tool-1', 'gen-1')
    ).resolves.toEqual({ status: 'missing' });
    expect(recordSource.getTaskRecords).not.toHaveBeenCalled();
    vi.unstubAllEnvs();
  });

  it('returns stale when the expected source generation no longer matches', async () => {
    const records = [makeRecord()];
    const recordSource = { getTaskRecords: vi.fn(async () => records) };
    const summarySelector = {
      selectSummaries: vi.fn(() => [makeCandidate(records)]),
    };

    const service = new BoardTaskExactLogDetailService(
      recordSource as never,
      summarySelector as never,
      { parseFiles: vi.fn() } as never,
      { selectDetail: vi.fn() } as never,
      { buildBundleChunks: vi.fn() } as never
    );

    const result = await service.getTaskExactLogDetail('demo', 'task-a', 'tool:/tmp/task.jsonl:tool-1', 'gen-old');

    expect(result).toEqual({ status: 'stale' });
  });

  it('returns ok when a matching detail bundle is reconstructed', async () => {
    const records = [makeRecord()];
    const candidate = makeCandidate(records);
    const detailCandidate: BoardTaskExactLogDetailCandidate = {
      id: candidate.id,
      timestamp: candidate.timestamp,
      actor: candidate.actor,
      source: candidate.source,
      records,
      filteredMessages: [],
    };

    const recordSource = { getTaskRecords: vi.fn(async () => records) };
    const summarySelector = {
      selectSummaries: vi.fn(() => [candidate]),
    };
    const strictParser = {
      parseFiles: vi.fn(async () => new Map([['/tmp/task.jsonl', []]])),
    };
    const detailSelector = {
      selectDetail: vi.fn(() => detailCandidate),
    };
    const chunkBuilder = {
      buildBundleChunks: vi.fn(() => []),
    };

    const service = new BoardTaskExactLogDetailService(
      recordSource as never,
      summarySelector as never,
      strictParser as never,
      detailSelector as never,
      chunkBuilder as never
    );

    const result = await service.getTaskExactLogDetail(
      'demo',
      'task-a',
      candidate.id,
      'gen-1'
    );

    expect(result).toEqual({
      status: 'ok',
      detail: {
        id: candidate.id,
        chunks: [],
      },
    });
  });

  it('returns missing for non-expandable summaries without parsing transcript content', async () => {
    const records = [makeRecord()];
    const nonExpandableCandidate: BoardTaskExactLogBundleCandidate = {
      ...makeCandidate(records),
      canLoadDetail: false,
    };
    const recordSource = { getTaskRecords: vi.fn(async () => records) };
    const summarySelector = {
      selectSummaries: vi.fn(() => [nonExpandableCandidate]),
    };
    const strictParser = {
      parseFiles: vi.fn(async () => new Map()),
    };

    const service = new BoardTaskExactLogDetailService(
      recordSource as never,
      summarySelector as never,
      strictParser as never,
      { selectDetail: vi.fn() } as never,
      { buildBundleChunks: vi.fn() } as never
    );

    const result = await service.getTaskExactLogDetail('demo', 'task-a', nonExpandableCandidate.id, 'gen-1');

    expect(result).toEqual({ status: 'missing' });
    expect(strictParser.parseFiles).not.toHaveBeenCalled();
  });

  it('returns missing when strict detail reconstruction fails for malformed transcript data', async () => {
    const records = [makeRecord()];
    const candidate = makeCandidate(records);
    const strictParser = {
      parseFiles: vi.fn(async () => new Map([['/tmp/task.jsonl', []]])),
    };
    const detailSelector = {
      selectDetail: vi.fn(() => null),
    };

    const service = new BoardTaskExactLogDetailService(
      { getTaskRecords: vi.fn(async () => records) } as never,
      { selectSummaries: vi.fn(() => [candidate]) } as never,
      strictParser as never,
      detailSelector as never,
      { buildBundleChunks: vi.fn() } as never
    );

    const result = await service.getTaskExactLogDetail('demo', 'task-a', candidate.id, 'gen-1');

    expect(result).toEqual({ status: 'missing' });
    expect(strictParser.parseFiles).toHaveBeenCalledWith(['/tmp/task.jsonl']);
    expect(detailSelector.selectDetail).toHaveBeenCalled();
  });
});
