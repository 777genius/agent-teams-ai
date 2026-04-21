import { describe, expect, it } from 'vitest';

import { buildReviewDecisionScopeToken } from '../../../src/renderer/utils/reviewDecisionScope';

describe('buildReviewDecisionScopeToken', () => {
  it('includes task request signature so filtered task variants do not collide', () => {
    const baseChangeSet = {
      teamName: 'demo',
      taskId: 'task-1',
      files: [],
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      totalFiles: 0,
      confidence: 'high' as const,
      computedAt: '2026-04-21T10:00:00.000Z',
      scope: {
        taskId: 'task-1',
        memberName: 'alice',
        startLine: 0,
        endLine: 0,
        startTimestamp: '',
        endTimestamp: '',
        toolUseIds: [],
        filePaths: [],
        confidence: { tier: 1 as const, label: 'high' as const, reason: 'ok' },
      },
      warnings: [],
      provenance: {
        sourceKind: 'ledger' as const,
        sourceFingerprint: 'fp-1',
      },
    };

    const tokenA = buildReviewDecisionScopeToken({
      mode: 'task',
      taskId: 'task-1',
      requestSignature: '{"status":"in_progress"}',
      changeSet: baseChangeSet,
    });
    const tokenB = buildReviewDecisionScopeToken({
      mode: 'task',
      taskId: 'task-1',
      requestSignature: '{"status":"completed"}',
      changeSet: baseChangeSet,
    });

    expect(tokenA).not.toBe(tokenB);
  });
});
