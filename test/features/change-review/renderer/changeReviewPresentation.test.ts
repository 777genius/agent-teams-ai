import {
  buildChangeReviewTitle,
  buildGlobalDiffLoadingState,
  buildReviewChangeStats,
  buildReviewFileLabels,
  buildReviewStats,
  buildTaskChangesEmptyStatePresentation,
  buildWatchedReviewFilePathsKey,
  findActiveReviewFile,
  resolveReviewFileLabel,
  shouldShowTaskScopeBanner,
  sortChangeReviewFiles,
  toTaskChangeSetV2,
} from '@features/change-review/renderer';
import { describe, expect, it } from 'vitest';

import type {
  AgentChangeSet,
  FileChangeSummary,
  FileChangeWithContent,
  GlobalTask,
  TaskChangeSetV2,
} from '@shared/types';

function makeFile(
  relativePath: string,
  overrides: Partial<FileChangeSummary> = {}
): FileChangeSummary {
  const filePath = `/repo/${relativePath}`;
  return {
    filePath,
    relativePath,
    snippets: [
      {
        toolUseId: `tool-${relativePath}`,
        filePath,
        toolName: 'Edit',
        type: 'edit',
        oldString: 'before',
        newString: 'after',
        replaceAll: false,
        timestamp: '2026-07-23T07:00:00.000Z',
        isError: false,
      },
    ],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
    ...overrides,
  };
}

function makeContent(
  file: FileChangeSummary,
  overrides: Partial<FileChangeWithContent> = {}
): FileChangeWithContent {
  return {
    ...file,
    originalFullContent: 'before',
    modifiedFullContent: 'after',
    contentSource: 'snippet-reconstruction',
    ...overrides,
  };
}

function makeTaskChangeSet(overrides: Partial<TaskChangeSetV2> = {}): TaskChangeSetV2 {
  return {
    teamName: 'team-a',
    taskId: 'task-a',
    files: [],
    totalFiles: 0,
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    confidence: 'high',
    computedAt: '2026-07-23T07:00:00.000Z',
    scope: {
      taskId: 'task-a',
      memberName: 'alice',
      startLine: 1,
      endLine: 2,
      startTimestamp: '2026-07-23T06:00:00.000Z',
      endTimestamp: '2026-07-23T06:30:00.000Z',
      toolUseIds: [],
      filePaths: [],
      confidence: { tier: 1, label: 'high', reason: 'test' },
    },
    warnings: [],
    ...overrides,
  };
}

function makeAgentChangeSet(files: FileChangeSummary[]): AgentChangeSet {
  return {
    teamName: 'team-a',
    memberName: 'alice',
    files,
    totalFiles: files.length,
    totalLinesAdded: files.reduce((sum, file) => sum + file.linesAdded, 0),
    totalLinesRemoved: files.reduce((sum, file) => sum + file.linesRemoved, 0),
    computedAt: '2026-07-23T07:00:00.000Z',
  };
}

describe('changeReviewPresentation', () => {
  it('keeps tree order, stable watcher identity, and cross-platform labels', () => {
    const windowsFile = makeFile('src/a.ts', {
      filePath: 'C:\\Repo\\src\\a.ts',
      relativePath: 'src/a.ts',
    });
    const sorted = sortChangeReviewFiles([makeFile('z.ts'), makeFile('src/b.ts'), windowsFile]);

    expect(sorted.map((file) => file.relativePath)).toEqual(['src/a.ts', 'src/b.ts', 'z.ts']);
    expect(buildWatchedReviewFilePathsKey(sorted)).toBe(
      ['C:\\Repo\\src\\a.ts', '/repo/src/b.ts', '/repo/z.ts'].join('\0')
    );
    const labels = buildReviewFileLabels(sorted);
    expect(resolveReviewFileLabel(labels, 'C:/Repo/src/a.ts')).toBe('src/a.ts');
    expect(resolveReviewFileLabel(labels, '/repo/missing.ts')).toBe('/repo/missing.ts');
  });

  it('projects loading progress from ready keys and non-error snippets', () => {
    const first = makeFile('src/a.ts', {
      snippets: [
        makeFile('src/a.ts').snippets[0]!,
        { ...makeFile('src/a.ts').snippets[0]!, toolUseId: 'failed', isError: true },
      ],
    });
    const second = makeFile('src/b.ts');
    const ready = makeContent(first);

    expect(
      buildGlobalDiffLoadingState({
        files: [first, second],
        activeFilePath: second.filePath,
        fileContentsLoading: { [first.filePath]: true, [second.filePath]: true },
        fileContents: { [first.filePath]: ready },
      })
    ).toEqual({
      totalFilesCount: 2,
      readyFilesCount: 1,
      loadingFilesCount: 2,
      snippetCount: 2,
      activeFileName: 'src/b.ts',
    });
    expect(
      buildGlobalDiffLoadingState({
        files: [first],
        activeFilePath: null,
        fileContentsLoading: {},
        fileContents: {},
      })
    ).toBeNull();
  });

  it('gives file decisions priority and uses CodeMirror chunk counts for stats', () => {
    const accepted = makeFile('accepted.ts', { changeKey: 'change:accepted' });
    const hunks = makeFile('hunks.ts');

    expect(
      buildReviewStats({
        changeSet: makeAgentChangeSet([accepted, hunks]),
        fileDecisions: { 'change:accepted': 'accepted' },
        hunkDecisions: {
          [`${hunks.filePath}:0`]: 'rejected',
          [`${hunks.filePath}:1`]: 'accepted',
        },
        fileChunkCounts: { [accepted.filePath]: 3, [hunks.filePath]: 3 },
      })
    ).toEqual({ pending: 1, accepted: 4, rejected: 1 });
  });

  it('projects aggregate stats and active-file lookup without inventing defaults', () => {
    const file = makeFile('src/a.ts', { linesAdded: 4, linesRemoved: 2 });
    const changeSet = makeAgentChangeSet([file]);

    expect(buildReviewChangeStats(changeSet)).toEqual({
      linesAdded: 4,
      linesRemoved: 2,
      filesChanged: 1,
    });
    expect(buildReviewChangeStats(null)).toEqual({
      linesAdded: 0,
      linesRemoved: 0,
      filesChanged: 0,
    });
    expect(findActiveReviewFile(changeSet, file.filePath)).toBe(file);
    expect(findActiveReviewFile(changeSet, '/repo/missing.ts')).toBeNull();
  });

  it('narrows only v2 task sets and preserves scope-banner policy', () => {
    const ledger = makeTaskChangeSet({
      provenance: { sourceKind: 'ledger', sourceFingerprint: 'fingerprint', integrity: 'ok' },
    });
    const legacy = makeTaskChangeSet();
    const lowConfidence = makeTaskChangeSet({
      provenance: { sourceKind: 'ledger', sourceFingerprint: 'fingerprint', integrity: 'ok' },
      scope: {
        ...makeTaskChangeSet().scope,
        confidence: { tier: 2, label: 'medium', reason: 'test' },
      },
    });

    expect(toTaskChangeSetV2(ledger)).toBe(ledger);
    expect(toTaskChangeSetV2(makeAgentChangeSet([]))).toBeNull();
    expect(shouldShowTaskScopeBanner({ mode: 'task', changeSet: ledger })).toBe(false);
    expect(shouldShowTaskScopeBanner({ mode: 'task', changeSet: legacy })).toBe(true);
    expect(shouldShowTaskScopeBanner({ mode: 'task', changeSet: lowConfidence })).toBe(true);
    expect(shouldShowTaskScopeBanner({ mode: 'agent', changeSet: legacy })).toBe(false);
  });

  it('builds task and agent titles with the exact legacy fallbacks', () => {
    const globalTasks = [
      {
        id: 'task-123456789',
        displayId: '42',
        subject: 'Ship presentation slice',
        status: 'in_progress',
        teamName: 'team-a',
        teamDisplayName: 'Team A',
      } as GlobalTask,
    ];

    expect(buildChangeReviewTitle({ mode: 'task', taskId: 'task-123456789', globalTasks })).toBe(
      'Changes for task #42 - Ship presentation slice'
    );
    expect(buildChangeReviewTitle({ mode: 'task', taskId: 'abcdefghijk', globalTasks: [] })).toBe(
      'Changes for task #abcdefgh'
    );
    expect(buildChangeReviewTitle({ mode: 'task', globalTasks: [] })).toBe('Changes for task #?');
    expect(buildChangeReviewTitle({ mode: 'agent', memberName: 'alice', globalTasks: [] })).toBe(
      'Changes by alice'
    );
  });

  it('keeps the generic empty state for a missing or legacy change set', () => {
    expect(buildTaskChangesEmptyStatePresentation(null)).toEqual({
      icon: 'file-search',
      tone: 'neutral',
      titleKey: 'review.empty.noFileChangesRecorded',
      descriptionKey: 'review.empty.noFileEvents',
      messages: [],
    });
  });

  it('keeps diagnostic-only wording and ordered warning context', () => {
    const presentation = buildTaskChangesEmptyStatePresentation(
      makeTaskChangeSet({
        warnings: [
          'Task change ledger skipped attribution because multiple task scopes were active.',
          'Task change ledger skipped attribution because multiple task scopes were active.',
        ],
      })
    );

    expect(presentation).toMatchObject({
      icon: 'info',
      tone: 'neutral',
      titleKey: 'review.empty.noSafeDiff',
      descriptionKey: 'review.empty.noSafeDiffDescription',
    });
    expect(presentation.messages).toHaveLength(1);
  });

  it('normalizes typed diagnostics with legacy warnings and preserves the attention tone', () => {
    const presentation = buildTaskChangesEmptyStatePresentation(
      makeTaskChangeSet({
        warnings: ['Legacy warning must not replace typed diagnostics.'],
        reviewDiagnostics: [
          {
            code: 'multi_scope_no_safe_diff',
            severity: 'warning',
            reviewBlocking: true,
            message: 'Typed blocking diagnostic.',
            source: 'ledger',
          },
          {
            code: 'legacy_warning',
            severity: 'info',
            reviewBlocking: false,
            message: '   ',
            source: 'summary',
          },
        ],
      })
    );

    expect(presentation).toEqual({
      icon: 'alert',
      tone: 'attention',
      titleKey: 'review.continuousScroll.empty',
      descriptionKey: 'review.empty.noSafeDiffDiagnosticsDescription',
      messages: [
        'Typed blocking diagnostic.',
        'Legacy warning must not replace typed diagnostics.',
      ],
    });
  });
});
