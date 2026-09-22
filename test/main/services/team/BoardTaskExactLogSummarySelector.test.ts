import { describe, expect, it } from 'vitest';

import { BoardTaskExactLogSummarySelector } from '../../../../src/main/services/team/taskLogs/exact/BoardTaskExactLogSummarySelector';

import type { BoardTaskActivityRecord } from '../../../../src/main/services/team/taskLogs/activity/BoardTaskActivityRecord';

function makeRecord(
  id: string,
  overrides: Partial<BoardTaskActivityRecord> = {}
): BoardTaskActivityRecord {
  return {
    id,
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
      sourceOrder: 1,
    },
    ...overrides,
  };
}

describe('BoardTaskExactLogSummarySelector', () => {
  it('prefers tool anchors over message anchors within one message group', () => {
    const selector = new BoardTaskExactLogSummarySelector();
    const records = [
      makeRecord('r1', { source: { filePath: '/tmp/task.jsonl', messageUuid: 'msg-1', sourceOrder: 1 } }),
      makeRecord('r2', {
        source: {
          filePath: '/tmp/task.jsonl',
          messageUuid: 'msg-1',
          toolUseId: 'tool-1',
          sourceOrder: 2,
        },
      }),
    ];

    const summaries = selector.selectSummaries({
      records,
      fileVersionsByPath: new Map([
        ['/tmp/task.jsonl', { filePath: '/tmp/task.jsonl', mtimeMs: 1000, size: 42 }],
      ]),
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.id).toBe('tool:/tmp/task.jsonl:tool-1');
    expect(summaries[0]?.source.toolUseId).toBe('tool-1');
    expect(summaries[0]?.anchor.kind).toBe('tool');
    expect(summaries[0]?.actionLabel).toBe('Added a comment');
    expect(summaries[0]?.actionCategory).toBe('comment');
    expect(summaries[0]?.canonicalToolName).toBe('task_add_comment');
    expect(summaries[0]?.records).toHaveLength(2);
    expect(summaries[0]?.canLoadDetail).toBe(true);
  });

  it('marks summaries as non-expandable when file version metadata is missing', () => {
    const selector = new BoardTaskExactLogSummarySelector();
    const summaries = selector.selectSummaries({
      records: [makeRecord('r1')],
      fileVersionsByPath: new Map(),
    });

    expect(summaries).toHaveLength(1);
    expect(summaries[0]?.canLoadDetail).toBe(false);
  });

  it('builds distinct action labels for multiple tool-linked bundles from the same actor', () => {
    const selector = new BoardTaskExactLogSummarySelector();
    const records = [
      makeRecord('r1', {
        source: {
          filePath: '/tmp/task.jsonl',
          messageUuid: 'msg-1',
          toolUseId: 'tool-comment',
          sourceOrder: 1,
        },
        action: {
          canonicalToolName: 'task_add_comment',
          toolUseId: 'tool-comment',
          category: 'comment',
        },
      }),
      makeRecord('r2', {
        source: {
          filePath: '/tmp/task.jsonl',
          messageUuid: 'msg-2',
          toolUseId: 'tool-review',
          sourceOrder: 2,
        },
        action: {
          canonicalToolName: 'review_request',
          toolUseId: 'tool-review',
          category: 'review',
          details: { reviewer: 'tom' },
        },
      }),
      makeRecord('r3', {
        source: {
          filePath: '/tmp/task.jsonl',
          messageUuid: 'msg-3',
          toolUseId: 'tool-read',
          sourceOrder: 3,
        },
        action: {
          canonicalToolName: 'task_get',
          toolUseId: 'tool-read',
          category: 'read',
        },
      }),
    ];

    const summaries = selector.selectSummaries({
      records,
      fileVersionsByPath: new Map([
        ['/tmp/task.jsonl', { filePath: '/tmp/task.jsonl', mtimeMs: 1000, size: 42 }],
      ]),
    });

    expect(summaries).toHaveLength(3);
    expect(summaries.map((summary) => summary.actionLabel)).toEqual([
      'Added a comment',
      'Requested review from tom',
      'Viewed task',
    ]);
  });
});
