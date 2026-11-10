import { describe, expect, it } from 'vitest';

import { buildInitialReviewFileScrollKey } from '@renderer/components/team/review/initialReviewFileScroll';

import type { TaskChangeSetV2 } from '@shared/types';

function makeChangeSet(sourceFingerprint: string): TaskChangeSetV2 {
  return {
    teamName: 'team-a',
    taskId: 'task-1',
    files: [],
    totalFiles: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    confidence: 'high',
    computedAt: '2026-04-20T10:00:00.000Z',
    scope: {
      taskId: 'task-1',
      memberName: 'alice',
      startLine: 0,
      endLine: 0,
      startTimestamp: '',
      endTimestamp: '',
      toolUseIds: [],
      filePaths: [],
      confidence: { tier: 1, label: 'high', reason: 'ledger' },
    },
    warnings: [],
    provenance: {
      sourceKind: 'ledger',
      sourceFingerprint,
    },
  };
}

describe('buildInitialReviewFileScrollKey', () => {
  it('changes when the change set identity changes even if the initial file path is unchanged', () => {
    const path = '/repo/src/shared.ts';

    expect(buildInitialReviewFileScrollKey(makeChangeSet('fp-a'), path)).not.toBe(
      buildInitialReviewFileScrollKey(makeChangeSet('fp-b'), path)
    );
  });

  it('does not produce a key without a change set or file path', () => {
    expect(buildInitialReviewFileScrollKey(null, '/repo/src/file.ts')).toBeNull();
    expect(buildInitialReviewFileScrollKey(makeChangeSet('fp'), undefined)).toBeNull();
  });
});
