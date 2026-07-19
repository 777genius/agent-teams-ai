import { describe, expect, it } from 'vitest';

import {
  buildReviewDecisionScopeToken,
  fingerprintReviewChangeSet,
  reviewChangeSetMatchesScope,
} from '../../../src/renderer/utils/reviewDecisionScope';

describe('buildReviewDecisionScopeToken', () => {
  it('rejects stale change sets from another team or review target', () => {
    const changeSet = {
      teamName: 'team-a',
      memberName: 'alice',
      files: [],
      totalLinesAdded: 0,
      totalLinesRemoved: 0,
      totalFiles: 0,
      computedAt: '2026-07-19T00:00:00.000Z',
    };

    expect(
      reviewChangeSetMatchesScope(changeSet, { teamName: 'team-a', memberName: 'alice' })
    ).toBe(true);
    expect(
      reviewChangeSetMatchesScope(changeSet, { teamName: 'team-b', memberName: 'alice' })
    ).toBe(false);
    expect(
      reviewChangeSetMatchesScope(changeSet, { teamName: 'team-a', memberName: 'bob' })
    ).toBe(false);
    expect(
      reviewChangeSetMatchesScope(changeSet, { teamName: 'team-a', taskId: 'task-1' })
    ).toBe(false);
  });

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

  it('keeps fallback content identity stable for relative Windows slash and case variants', () => {
    const baseFile = {
      relativePath: 'SRC\\File.ts',
      linesAdded: 1,
      linesRemoved: 1,
      isNewFile: false,
      snippets: [
        {
          toolUseId: 'tool-1',
          filePath: 'SRC\\File.ts',
          toolName: 'Edit' as const,
          type: 'edit' as const,
          oldString: 'before',
          newString: 'after',
          replaceAll: false,
          timestamp: '2026-04-21T10:00:00.000Z',
          isError: false,
        },
      ],
    };
    const left = {
      teamName: 'team-a',
      taskId: 'task-1',
      files: [{ ...baseFile, filePath: 'SRC\\File.ts' }],
      totalFiles: 1,
      totalLinesAdded: 1,
      totalLinesRemoved: 1,
      confidence: 'fallback' as const,
      computedAt: '2026-04-21T10:00:00.000Z',
      scope: {
        taskId: 'task-1',
        memberName: 'alice',
        startLine: 0,
        endLine: 0,
        startTimestamp: '',
        endTimestamp: '',
        toolUseIds: [],
        filePaths: ['SRC\\File.ts'],
        confidence: { tier: 4 as const, label: 'fallback' as const, reason: 'test' },
      },
      warnings: [],
    };
    const right = {
      ...left,
      files: [
        {
          ...baseFile,
          filePath: 'src/file.ts',
          relativePath: 'src/file.ts',
          snippets: [{ ...baseFile.snippets[0], filePath: 'src/file.ts' }],
        },
      ],
    };

    expect(fingerprintReviewChangeSet(left)).toBe(fingerprintReviewChangeSet(right));
  });
});
