import {
  ReviewDecisionCommandApplication,
  ReviewMutationApplyResultError,
} from '@features/review-mutations/main';
import { describe, expect, it, vi } from 'vitest';

import type {
  ReviewDecisionCommandCurrentState,
  ReviewDecisionCommandDependencies,
  ReviewMutationJournalRecord,
} from '@features/review-mutations/main';
import type {
  ApplyReviewRequest,
  FileChangeSummary,
  FileChangeWithContent,
  ReviewDecisionPersistenceScope,
  ReviewPersistedStateSnapshot,
  ReviewUndoAction,
  SnippetDiff,
} from '@shared/types/review';

const FILE_PATH = '/sandbox/fixture.ts';
const REVIEW_KEY = 'fixture-change';
const SCOPE = { teamName: 'safe-team', memberName: 'worker' };
const PERSISTENCE_SCOPE: ReviewDecisionPersistenceScope = {
  scopeKey: 'agent-worker',
  scopeToken: 'scope-token',
};

function createSnippet(withLedger = false): SnippetDiff {
  return {
    toolUseId: 'tool-1',
    filePath: FILE_PATH,
    toolName: 'Edit',
    type: 'edit',
    oldString: 'before\n',
    newString: 'after\n',
    replaceAll: false,
    timestamp: '2026-07-24T00:00:00.000Z',
    isError: false,
    ...(withLedger
      ? {
          ledger: {
            eventId: 'event-1',
            source: 'ledger-exact' as const,
            confidence: 'exact' as const,
            originalFullContent: 'ledger-before\n',
            modifiedFullContent: 'ledger-after\n',
            beforeHash: 'before-hash',
            afterHash: 'after-hash',
          },
        }
      : {}),
  };
}

function createFile(withLedger = false): FileChangeSummary {
  return {
    filePath: FILE_PATH,
    relativePath: 'fixture.ts',
    snippets: [createSnippet(withLedger)],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
    changeKey: REVIEW_KEY,
  };
}

function createContent(
  originalFullContent: string,
  modifiedFullContent: string,
  snippets = createFile().snippets
): FileChangeWithContent {
  return {
    ...createFile(),
    snippets,
    originalFullContent,
    modifiedFullContent,
    contentSource: 'snippet-reconstruction',
  };
}

function createDecisionRequest(
  contentSnapshotToken: string,
  durable?: {
    persistedState: ReviewPersistedStateSnapshot;
    expectedDecisionRevision: number;
  }
): ApplyReviewRequest {
  return {
    ...SCOPE,
    ...(durable ? { decisionPersistenceScope: PERSISTENCE_SCOPE, ...durable } : {}),
    decisions: [
      {
        filePath: FILE_PATH,
        reviewKey: REVIEW_KEY,
        fileDecision: 'rejected',
        hunkDecisions: {},
        contentSnapshotToken,
      },
    ],
  };
}

function createHarness(options: {
  file?: FileChangeSummary;
  authoritativeContent?: FileChangeWithContent;
  persistenceScope?: ReviewDecisionPersistenceScope | null;
  loadStates?: (ReviewDecisionCommandCurrentState | null)[];
}) {
  const file = options.file ?? createFile();
  const events: string[] = [];
  let now = 1_000;
  let tokenIndex = 0;
  const loadStates = [...(options.loadStates ?? [])];
  const authorization = {
    roots: [{ lexicalPath: '/sandbox', realPath: '/sandbox' }],
    reviewedFiles: new Map([[FILE_PATH, file]]),
    resolutionMemberName: 'worker',
  };
  const applyReviewDecisions: ReviewDecisionCommandDependencies['applier']['applyReviewDecisions'] =
    vi.fn(() => Promise.resolve({ applied: 1, skipped: 0, conflicts: 0, errors: [] }));
  const resolveAuthoritativeContent = vi.fn(() =>
    Promise.resolve(
      options.authoritativeContent ??
        createContent('authoritative-before\n', 'authoritative-after\n', file.snippets)
    )
  );
  const invalidateFile = vi.fn();
  const applyDisk: ReviewDecisionCommandDependencies['batch']['applyDisk'] = vi.fn(
    (record, onResult, onPostimages) => {
      events.push('apply-disk');
      onResult?.({ applied: 1, skipped: 0, conflicts: 0, errors: [] });
      onPostimages?.([{ filePath: FILE_PATH, content: 'before\n' }]);
      return Promise.resolve(record);
    }
  );
  const assertSnippetShapes = (value: unknown): asserts value is SnippetDiff[] => {
    if (!Array.isArray(value)) throw new Error('Invalid snippets');
  };
  const assertDecisionShape: ReviewDecisionCommandDependencies['scope']['assertDecisionShape'] = (
    value
  ): asserts value is ApplyReviewRequest['decisions'][number] => {
    events.push('validate-decision');
    if (!value || typeof value !== 'object') throw new Error('Invalid decision');
  };
  const dependencies: ReviewDecisionCommandDependencies = {
    scope: {
      resolve: () => {
        events.push('resolve-scope');
        return Promise.resolve({ scope: SCOPE, authorization });
      },
      parsePersistenceScope: () => {
        events.push('parse-persistence');
        return options.persistenceScope ?? null;
      },
      validateFilePath: (_authorization, filePath) => Promise.resolve(String(filePath)),
      validateSnippets: () => Promise.resolve(),
      assertDecisionShape,
      assertSnippetShapes,
      getAuthoritativeFile: () => file,
      resolveAuthoritativeContent,
      normalizeIdentityPath: (filePath) => filePath,
    },
    applier: {
      checkConflict: vi.fn(() =>
        Promise.resolve({
          hasConflict: false,
          conflictContent: null,
          currentContent: 'after\n',
          originalContent: 'before\n',
        })
      ),
      rejectHunks: vi.fn(() =>
        Promise.resolve({
          success: true,
          newContent: 'before\n',
          hadConflicts: false,
        })
      ),
      rejectFile: vi.fn(() =>
        Promise.resolve({
          success: true,
          newContent: 'before\n',
          hadConflicts: false,
        })
      ),
      previewReject: vi.fn(() => Promise.resolve({ preview: '', hasConflicts: false })),
      applyReviewDecisions,
    },
    persistence: {
      withLock: (_teamName, _scope, operation) => {
        events.push('lock');
        return operation();
      },
      assertValidSnapshot: () => events.push('validate-state'),
      load: () => {
        events.push(`load-${loadStates.length}`);
        return Promise.resolve(loadStates.shift() ?? null);
      },
    },
    batch: {
      assertPersistedStateIncludesDecisions: () => events.push('validate-decisions'),
      applyDisk,
      commit: () => {
        events.push('commit');
        return Promise.resolve();
      },
    },
    history: {
      bindNewHistorySnapshots: (state) => {
        events.push('bind-history');
        return Promise.resolve(state);
      },
    },
    recovery: {
      recoverPending: () => {
        events.push('recover');
        return Promise.resolve();
      },
    },
    coordinator: {
      execute: async (_input, steps) => {
        events.push('coordinate');
        const record = {} as ReviewMutationJournalRecord;
        const applied = (await steps.applyDisk(record)) ?? record;
        await steps.commitDecisions(applied);
        return applied;
      },
    },
    snapshots: {
      now: () => now,
      createToken: () => `snapshot-${++tokenIndex}`,
      fingerprintSnippets: (snippets) => JSON.stringify(snippets),
    },
    cache: { invalidateFile },
    logger: { debug: vi.fn() },
  };
  return {
    application: new ReviewDecisionCommandApplication(dependencies),
    applyDisk,
    applyReviewDecisions,
    events,
    invalidateFile,
    resolveAuthoritativeContent,
    setNow: (value: number) => {
      now = value;
    },
  };
}

describe('ReviewDecisionCommandApplication', () => {
  it('binds non-ledger Apply to the immutable displayed snapshot and rejects stale tokens', async () => {
    const harness = createHarness({});
    const displayed = harness.application.registerDisplayedReviewSnapshot(
      SCOPE.teamName,
      FILE_PATH,
      createFile().snippets,
      createContent('displayed-before\n', 'displayed-after\n')
    );

    await harness.application.applyDecisions(createDecisionRequest(displayed.reviewSnapshotToken!));

    const [, contents] = vi.mocked(harness.applyReviewDecisions).mock.calls[0];
    expect(contents.get(FILE_PATH)).toMatchObject({
      originalFullContent: 'displayed-before\n',
      modifiedFullContent: 'displayed-after\n',
    });
    expect(harness.resolveAuthoritativeContent).not.toHaveBeenCalled();
    expect(harness.invalidateFile).toHaveBeenCalledWith(FILE_PATH);

    harness.setNow(1_000 + 60 * 60 * 1_000 + 1);
    await expect(
      harness.application.applyDecisions(createDecisionRequest(displayed.reviewSnapshotToken!))
    ).rejects.toThrow('Displayed review snapshot is stale; reload Changes before rejecting.');
  });

  it('uses authoritative ledger content without trusting a displayed token', async () => {
    const file = createFile(true);
    const authoritativeContent = createContent('ledger-before\n', 'ledger-after\n', file.snippets);
    const harness = createHarness({ file, authoritativeContent });

    await harness.application.applyDecisions(createDecisionRequest('forged-token'));

    const [, contents] = vi.mocked(harness.applyReviewDecisions).mock.calls[0];
    expect(contents.get(FILE_PATH)).toBe(authoritativeContent);
    expect(harness.resolveAuthoritativeContent).toHaveBeenCalledTimes(1);
  });

  it('preserves lock, recovery, CAS, history binding, WAL, commit, and result ordering', async () => {
    const current: ReviewDecisionCommandCurrentState = {
      hunkDecisions: {},
      fileDecisions: {},
      hunkContextHashesByFile: {},
      reviewActionHistory: [],
      reviewRedoHistory: [],
      revision: 7,
    };
    const action: Extract<ReviewUndoAction, { kind: 'disk' }> = {
      id: 'action-1',
      createdAt: '2026-07-24T00:00:00.000Z',
      kind: 'disk',
      descriptor: { intent: 'reject-file', filePath: FILE_PATH },
      action: {
        snapshot: {
          filePath: FILE_PATH,
          beforeContent: 'after\n',
          afterContent: 'before\n',
        },
        decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
      },
    };
    const persistedState: ReviewPersistedStateSnapshot = {
      hunkDecisions: {},
      fileDecisions: { [REVIEW_KEY]: 'rejected' },
      hunkContextHashesByFile: {},
      reviewActionHistory: [action],
      reviewRedoHistory: [],
    };
    const committed = { ...persistedState, revision: 8 };
    const harness = createHarness({
      persistenceScope: PERSISTENCE_SCOPE,
      loadStates: [current, committed],
    });
    const displayed = harness.application.registerDisplayedReviewSnapshot(
      SCOPE.teamName,
      FILE_PATH,
      createFile().snippets,
      createContent('after\n', 'before\n')
    );

    const result = await harness.application.applyDecisions(
      createDecisionRequest(displayed.reviewSnapshotToken!, {
        persistedState,
        expectedDecisionRevision: 7,
      })
    );

    expect(harness.events).toEqual([
      'resolve-scope',
      'parse-persistence',
      'validate-decision',
      'validate-state',
      'validate-decisions',
      'lock',
      'recover',
      'load-2',
      'bind-history',
      'coordinate',
      'apply-disk',
      'commit',
      'load-1',
    ]);
    expect(result).toMatchObject({
      applied: 1,
      decisionRevision: 8,
      committedReviewAction: action,
      diskPostimages: [{ filePath: FILE_PATH, content: 'before\n' }],
    });
  });

  it('returns an exact clean-conflict result while preserving collected postimages', async () => {
    const current: ReviewDecisionCommandCurrentState = {
      hunkDecisions: {},
      fileDecisions: {},
      reviewActionHistory: [],
      reviewRedoHistory: [],
      revision: 0,
    };
    const action: Extract<ReviewUndoAction, { kind: 'disk' }> = {
      id: 'action-conflict',
      createdAt: '2026-07-24T00:00:00.000Z',
      kind: 'disk',
      action: {
        snapshot: { filePath: FILE_PATH, beforeContent: 'after\n', afterContent: 'before\n' },
        decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
      },
    };
    const persistedState: ReviewPersistedStateSnapshot = {
      hunkDecisions: {},
      fileDecisions: { [REVIEW_KEY]: 'rejected' },
      reviewActionHistory: [action],
      reviewRedoHistory: [],
    };
    const harness = createHarness({
      persistenceScope: PERSISTENCE_SCOPE,
      loadStates: [current],
    });
    const displayed = harness.application.registerDisplayedReviewSnapshot(
      SCOPE.teamName,
      FILE_PATH,
      createFile().snippets,
      createContent('after\n', 'before\n')
    );
    vi.mocked(harness.applyDisk).mockImplementationOnce((_record, _onResult, onPostimages) => {
      onPostimages?.([{ filePath: FILE_PATH, content: null }]);
      return Promise.reject(
        new ReviewMutationApplyResultError({
          applied: 0,
          skipped: 0,
          conflicts: 1,
          errors: [{ filePath: FILE_PATH, error: 'external edit' }],
        })
      );
    });

    await expect(
      harness.application.applyDecisions(
        createDecisionRequest(displayed.reviewSnapshotToken!, {
          persistedState,
          expectedDecisionRevision: 0,
        })
      )
    ).resolves.toEqual({
      applied: 0,
      skipped: 0,
      conflicts: 1,
      errors: [{ filePath: FILE_PATH, error: 'external edit' }],
      diskPostimages: [{ filePath: FILE_PATH, content: null }],
    });
  });
});
