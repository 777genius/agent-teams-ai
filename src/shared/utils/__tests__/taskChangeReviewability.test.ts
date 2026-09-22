import { describe, expect, it } from 'vitest';

import { resolveTaskChangePresenceFromResult } from '../taskChangePresence';
import {
  classifyTaskChangeReviewability,
  EMPTY_INTERVAL_NO_EDITS_WARNING,
} from '../taskChangeReviewability';

import type { TaskChangeSetV2 } from '../../types';

function changeSet(overrides: Partial<TaskChangeSetV2> = {}): TaskChangeSetV2 {
  return {
    teamName: 'team-a',
    taskId: 'task-a',
    files: [],
    totalFiles: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    confidence: 'high',
    computedAt: '2026-05-09T12:00:00.000Z',
    scope: {
      taskId: 'task-a',
      memberName: 'alice',
      startLine: 0,
      endLine: 0,
      startTimestamp: '2026-05-09T11:00:00.000Z',
      endTimestamp: '2026-05-09T11:10:00.000Z',
      toolUseIds: [],
      filePaths: [],
      confidence: { tier: 1, label: 'high', reason: 'test' },
    },
    warnings: [],
    ...overrides,
  };
}

describe('taskChangeReviewability', () => {
  it('treats changed files with non-blocking multi-scope diagnostics as reviewable', () => {
    const result = changeSet({
      files: [
        {
          filePath: '/repo/src/file.ts',
          relativePath: 'src/file.ts',
          snippets: [],
          linesAdded: 1,
          linesRemoved: 0,
          isNewFile: true,
        },
      ],
      totalFiles: 1,
      totalLinesAdded: 1,
      warnings: [
        'Task change ledger skipped attribution because multiple task scopes were active.',
      ],
    });

    expect(classifyTaskChangeReviewability(result).reviewability).toBe('reviewable');
    expect(resolveTaskChangePresenceFromResult(result)).toBe('has_changes');
  });

  it('classifies warning-only multi-scope notices as diagnostic-only', () => {
    const result = changeSet({
      warnings: [
        'Task change ledger skipped attribution because multiple task scopes were active.',
      ],
    });

    expect(classifyTaskChangeReviewability(result)).toMatchObject({
      reviewability: 'diagnostic_only',
      reasonCode: 'diagnostic_only',
      userAction: 'inspect_diagnostics',
    });
    expect(resolveTaskChangePresenceFromResult(result)).toBeNull();
  });

  it('fails closed for unclassified warning-only summaries', () => {
    const result = changeSet({ warnings: ['Unexpected ledger warning.'] });

    expect(classifyTaskChangeReviewability(result).reviewability).toBe('attention_required');
    expect(resolveTaskChangePresenceFromResult(result)).toBe('needs_attention');
  });

  it('keeps active no-edit intervals unknown instead of needs attention', () => {
    const result = changeSet({
      warnings: [EMPTY_INTERVAL_NO_EDITS_WARNING],
      scope: {
        ...changeSet().scope,
        startTimestamp: '2026-05-09T11:00:00.000Z',
        endTimestamp: '',
        toolUseIds: [],
      },
    });

    expect(classifyTaskChangeReviewability(result).reviewability).toBe('unknown');
    expect(resolveTaskChangePresenceFromResult(result)).toBeNull();
  });

  it('keeps active no-edit intervals fail-closed when blocking diagnostics are present', () => {
    const result = changeSet({
      warnings: [EMPTY_INTERVAL_NO_EDITS_WARNING, 'Task changes scan timed out.'],
      scope: {
        ...changeSet().scope,
        startTimestamp: '2026-05-09T11:00:00.000Z',
        endTimestamp: '',
        toolUseIds: [],
      },
    });

    expect(classifyTaskChangeReviewability(result).reviewability).toBe('attention_required');
    expect(resolveTaskChangePresenceFromResult(result)).toBe('needs_attention');
  });

  it('marks partial ledger evidence as attention required', () => {
    const result = changeSet({
      provenance: {
        sourceKind: 'ledger',
        sourceFingerprint: 'fingerprint',
        integrity: 'partial',
      },
    });

    expect(classifyTaskChangeReviewability(result).reviewability).toBe('attention_required');
    expect(resolveTaskChangePresenceFromResult(result)).toBe('needs_attention');
  });

  it('deduplicates recovered ledger diagnostics from typed diagnostics and provenance', () => {
    const result = changeSet({
      reviewDiagnostics: [
        {
          code: 'ledger_integrity_recovered',
          severity: 'warning',
          reviewBlocking: true,
          message: 'The task-change ledger was recovered from malformed journal lines.',
          source: 'ledger',
        },
      ],
      provenance: {
        sourceKind: 'ledger',
        sourceFingerprint: 'fingerprint',
        integrity: 'recovered',
      },
    });

    const status = classifyTaskChangeReviewability(result);

    expect(status.reviewability).toBe('attention_required');
    expect(status.diagnostics).toHaveLength(1);
    expect(status.diagnostics[0]?.code).toBe('ledger_integrity_recovered');
  });

  it('does not downgrade typed blocking diagnostics when legacy warnings duplicate them', () => {
    const result = changeSet({
      reviewDiagnostics: [
        {
          code: 'multi_scope_no_safe_diff',
          severity: 'warning',
          reviewBlocking: true,
          message:
            'Activity was observed while multiple task scopes were active, so file edits were not safely assigned to this task.',
          source: 'ledger',
        },
      ],
      warnings: [
        'Task change ledger skipped attribution because multiple task scopes were active.',
      ],
    });

    const status = classifyTaskChangeReviewability(result);

    expect(status.reviewability).toBe('attention_required');
    expect(status.diagnostics).toHaveLength(1);
    expect(status.diagnostics[0]?.reviewBlocking).toBe(true);
  });

  it('upgrades duplicate diagnostics when legacy warnings are more strict', () => {
    const result = changeSet({
      reviewDiagnostics: [
        {
          code: 'legacy_warning',
          severity: 'info',
          reviewBlocking: false,
          message: 'Unexpected ledger warning.',
          source: 'summary',
        },
      ],
      warnings: ['Unexpected ledger warning.'],
    });

    const status = classifyTaskChangeReviewability(result);

    expect(status.reviewability).toBe('attention_required');
    expect(status.diagnostics).toHaveLength(1);
    expect(status.diagnostics[0]).toMatchObject({
      code: 'legacy_warning',
      severity: 'warning',
      reviewBlocking: true,
      source: 'legacy',
    });
  });

  it('fails closed when reported files are missing safe review details', () => {
    const result = changeSet({
      totalFiles: 2,
      files: [
        {
          filePath: '/repo/src/file.ts',
          relativePath: 'src/file.ts',
          snippets: [],
          linesAdded: 1,
          linesRemoved: 0,
          isNewFile: true,
        },
      ],
      totalLinesAdded: 1,
    });

    const status = classifyTaskChangeReviewability(result);

    expect(status).toMatchObject({
      reviewability: 'attention_required',
      reasonCode: 'blocking_diagnostics',
      userAction: 'review_diff',
    });
    expect(status.diagnostics).toContainEqual(
      expect.objectContaining({
        code: 'unsafe_or_untrusted_evidence',
        reviewBlocking: true,
      })
    );
    expect(resolveTaskChangePresenceFromResult(result)).toBe('needs_attention');
  });

  it('tolerates malformed cached scope and diagnostic shapes', () => {
    const result = changeSet({
      totalFiles: 'not-a-number' as unknown as number,
      reviewDiagnostics: [
        null,
        'bad-diagnostic',
        {
          code: 'legacy_warning',
          severity: 'warning',
          reviewBlocking: true,
          message: 'Recovered warning from cache.',
          source: 'summary',
        },
      ] as unknown as TaskChangeSetV2['reviewDiagnostics'],
      warnings: [42, EMPTY_INTERVAL_NO_EDITS_WARNING] as unknown as string[],
      scope: {
        taskId: 'task-a',
        memberName: 'alice',
        startTimestamp: '2026-05-09T11:00:00.000Z',
        endTimestamp: '',
        confidence: { tier: 2, label: 'medium', reason: 'legacy cache fixture' },
      } as unknown as TaskChangeSetV2['scope'],
    });

    const status = classifyTaskChangeReviewability(result);

    expect(status.reviewability).toBe('attention_required');
    expect(status.diagnostics).toHaveLength(3);
    expect(status.diagnostics.map((diagnostic) => diagnostic.message)).toEqual([
      'bad-diagnostic',
      'Recovered warning from cache.',
      'No file edits have been observed in the active task interval yet.',
    ]);
    expect(resolveTaskChangePresenceFromResult(result)).toBe('needs_attention');
  });

  it('confirms empty high-confidence summaries as no changes', () => {
    const result = changeSet();

    expect(classifyTaskChangeReviewability(result).reviewability).toBe('none');
    expect(resolveTaskChangePresenceFromResult(result)).toBe('no_changes');
  });
});
