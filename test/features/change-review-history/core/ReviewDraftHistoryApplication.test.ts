import { ReviewDraftHistoryApplication } from '@features/change-review-history/core/application/ReviewDraftHistoryApplication';
import { describe, expect, it, vi } from 'vitest';

import type {
  ReviewDraftHistoryConflictCandidate,
  ReviewDraftHistoryConflictCandidateSummary,
  ReviewDraftHistoryEntry,
  ReviewDraftHistorySnapshot,
} from '@features/change-review-history/contracts';
import type {
  ReviewDraftHistoryAuthorization,
  ReviewDraftHistoryPersistenceLockPort,
} from '@features/change-review-history/core/application/ports';
import type { ReviewDraftHistoryApplicationDependencies } from '@features/change-review-history/core/application/ReviewDraftHistoryApplication';

const TEAM_NAME = 'safe-team';
const SCOPE_KEY = 'agent-worker';
const SCOPE_TOKEN = 'scope-token';
const REVIEWED_FILE = '/repo/src/reviewed.ts';
const FOREIGN_FILE = '/repo/src/foreign.ts';

const entry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'> = {
  filePath: REVIEWED_FILE,
  codec: 'codemirror-history-v1',
  revision: 1,
  diskBaseline: 'before\n',
  editorState: {
    doc: 'after\n',
    history: { done: [], undone: [] },
  },
};

function candidate(
  overrides: Partial<ReviewDraftHistoryConflictCandidate> = {}
): ReviewDraftHistoryConflictCandidate {
  return {
    id: 'candidate-id',
    capturedAt: '2026-07-23T10:00:00.000Z',
    origin: 'current-snapshot',
    filePath: REVIEWED_FILE,
    expectedRevision: 0,
    expectedGeneration: null,
    observedCurrentRevision: 1,
    observedCurrentGeneration: 'generation-1',
    entry,
    ...overrides,
  };
}

function candidateSummary(
  overrides: Partial<ReviewDraftHistoryConflictCandidateSummary> = {}
): ReviewDraftHistoryConflictCandidateSummary {
  return {
    id: 'candidate-id',
    capturedAt: '2026-07-23T10:00:00.000Z',
    origin: 'current-snapshot',
    recoverability: 'recoverable',
    filePath: REVIEWED_FILE,
    expectedRevision: 0,
    expectedGeneration: null,
    observedCurrentRevision: 1,
    observedCurrentGeneration: 'generation-1',
    entryRevision: 1,
    ...overrides,
  };
}

function createHarness(
  options: {
    reviewedFiles?: readonly string[];
    snapshot?: ReviewDraftHistorySnapshot | null;
    candidates?: ReviewDraftHistoryConflictCandidateSummary[];
  } = {}
) {
  const order: string[] = [];
  const reviewedFiles = new Set(options.reviewedFiles ?? [REVIEWED_FILE]);
  const authorization: ReviewDraftHistoryAuthorization = {
    isCurrentReviewedFile: (filePath) => reviewedFiles.has(filePath),
    assertCurrentReviewedFile: vi.fn(async (filePath: string) => {
      order.push(`authorize-file:${filePath}`);
      if (!reviewedFiles.has(filePath)) {
        throw new Error('File is not part of the reviewed scope');
      }
    }),
  };
  const lock: ReviewDraftHistoryPersistenceLockPort = {
    async run<T>(_teamName: string, _scope: unknown, operation: () => Promise<T>): Promise<T> {
      order.push('lock');
      return operation();
    },
  };
  const queries = {
    load: vi.fn(async () => {
      order.push('repo:load');
      return options.snapshot ?? null;
    }),
    loadConflictCandidateSummaries: vi.fn(async () => {
      order.push('repo:load-candidates');
      return options.candidates ?? [];
    }),
    loadConflictCandidate: vi.fn(async () => {
      order.push('repo:load-candidate');
      return candidate();
    }),
  };
  const conflictMutations = {
    resolveConflictCandidate: vi.fn(async () => {
      order.push('repo:resolve');
      return null;
    }),
    replaceConflictCandidate: vi.fn(async () => {
      order.push('repo:replace');
      return candidate({ entry: { ...entry, revision: 2 } });
    }),
  };
  const entryMutations = {
    saveEntry: vi.fn(async () => {
      order.push('repo:save');
      return {
        ...entry,
        generation: 'generation-1',
        updatedAt: '2026-07-23T10:00:00.000Z',
      };
    }),
    clearEntry: vi.fn(async () => {
      order.push('repo:clear-entry');
    }),
    clearUnreadableScope: vi.fn(async () => {
      order.push('repo:clear-unreadable');
    }),
  };
  const dependencies: ReviewDraftHistoryApplicationDependencies = {
    lock,
    authorization: {
      authorize: vi.fn(async () => {
        order.push('authorize-scope');
        return authorization;
      }),
    },
    queries,
    conflictMutations,
    entryMutations,
  };
  return {
    application: new ReviewDraftHistoryApplication(dependencies),
    authorization,
    conflictMutations,
    entryMutations,
    order,
  };
}

describe('ReviewDraftHistoryApplication', () => {
  it('orders the persistence lock, authoritative scope resolution, and repository write', async () => {
    const harness = createHarness();

    await harness.application.saveEntry(TEAM_NAME, SCOPE_KEY, SCOPE_TOKEN, entry, 0, null);

    expect(harness.order).toEqual([
      'lock',
      'authorize-scope',
      `authorize-file:${REVIEWED_FILE}`,
      'repo:save',
    ]);
    expect(harness.entryMutations.saveEntry).toHaveBeenCalledWith(
      TEAM_NAME,
      SCOPE_KEY,
      SCOPE_TOKEN,
      { ...entry, expectedRevision: 0, expectedGeneration: null }
    );
  });

  it('fails closed when a persisted snapshot contains a foreign file', async () => {
    const harness = createHarness({
      snapshot: {
        entries: {
          [REVIEWED_FILE]: {
            ...entry,
            generation: 'generation-1',
            updatedAt: '2026-07-23T10:00:00.000Z',
          },
          [FOREIGN_FILE]: {
            ...entry,
            filePath: FOREIGN_FILE,
            generation: 'generation-2',
            updatedAt: '2026-07-23T10:01:00.000Z',
          },
        },
      },
    });

    await expect(harness.application.load(TEAM_NAME, SCOPE_KEY, SCOPE_TOKEN)).rejects.toThrow(
      'File is not part of the reviewed scope'
    );
    expect(harness.order).toEqual([
      'lock',
      'authorize-scope',
      'repo:load',
      `authorize-file:${REVIEWED_FILE}`,
      `authorize-file:${FOREIGN_FILE}`,
    ]);
  });

  it('keeps an unauthorized prior-snapshot candidate visible but fail-closes a current one', async () => {
    const prior = candidateSummary({
      id: 'prior',
      origin: 'prior-snapshot',
      filePath: FOREIGN_FILE,
    });
    const priorHarness = createHarness({ candidates: [prior] });

    await expect(
      priorHarness.application.loadConflictCandidates(TEAM_NAME, SCOPE_KEY, SCOPE_TOKEN)
    ).resolves.toEqual([{ ...prior, recoverability: 'file-not-in-current-review' }]);
    expect(priorHarness.authorization.assertCurrentReviewedFile).not.toHaveBeenCalled();

    const currentHarness = createHarness({
      candidates: [{ ...prior, id: 'current', origin: 'current-snapshot' }],
    });
    await expect(
      currentHarness.application.loadConflictCandidates(TEAM_NAME, SCOPE_KEY, SCOPE_TOKEN)
    ).rejects.toThrow('File is not part of the reviewed scope');
    expect(currentHarness.conflictMutations.resolveConflictCandidate).not.toHaveBeenCalled();
  });

  it('authorizes recover-candidate while keep-current preserves the existing branch semantics', async () => {
    const recovery = createHarness();
    await recovery.application.resolveConflictCandidate(
      TEAM_NAME,
      SCOPE_KEY,
      SCOPE_TOKEN,
      'candidate-id',
      'recover-candidate',
      1,
      'generation-1'
    );
    expect(recovery.order).toEqual([
      'lock',
      'authorize-scope',
      'repo:load-candidate',
      `authorize-file:${REVIEWED_FILE}`,
      'repo:resolve',
    ]);

    const keepCurrent = createHarness({ reviewedFiles: [] });
    await expect(
      keepCurrent.application.resolveConflictCandidate(
        TEAM_NAME,
        SCOPE_KEY,
        SCOPE_TOKEN,
        'candidate-id',
        'keep-current',
        1,
        'generation-1'
      )
    ).resolves.toBeNull();
    expect(keepCurrent.authorization.assertCurrentReviewedFile).not.toHaveBeenCalled();
    expect(keepCurrent.conflictMutations.resolveConflictCandidate).toHaveBeenCalledOnce();
  });

  it('rejects a replacement path change before mutating the durable candidate', async () => {
    const harness = createHarness();

    await expect(
      harness.application.replaceConflictCandidate(
        TEAM_NAME,
        SCOPE_KEY,
        SCOPE_TOKEN,
        entry,
        { ...entry, filePath: FOREIGN_FILE, revision: 2 },
        1,
        'generation-1'
      )
    ).rejects.toThrow('Manual-edit recovery update changed file identity');
    expect(harness.conflictMutations.replaceConflictCandidate).not.toHaveBeenCalled();
  });

  it('maps a same-file replacement to the metadata-only renderer contract', async () => {
    const harness = createHarness();

    await expect(
      harness.application.replaceConflictCandidate(
        TEAM_NAME,
        SCOPE_KEY,
        SCOPE_TOKEN,
        entry,
        { ...entry, revision: 2 },
        1,
        'generation-1'
      )
    ).resolves.toEqual({
      id: 'candidate-id',
      capturedAt: '2026-07-23T10:00:00.000Z',
      origin: 'current-snapshot',
      recoverability: 'recoverable',
      filePath: REVIEWED_FILE,
      expectedRevision: 0,
      expectedGeneration: null,
      observedCurrentRevision: 1,
      observedCurrentGeneration: 'generation-1',
      entryRevision: 2,
    });
  });

  it('requires authoritative scope authorization even for unreadable-scope recovery clear', async () => {
    const harness = createHarness();

    await harness.application.clear(TEAM_NAME, SCOPE_KEY, SCOPE_TOKEN);

    expect(harness.order).toEqual(['lock', 'authorize-scope', 'repo:clear-unreadable']);
    expect(harness.authorization.assertCurrentReviewedFile).not.toHaveBeenCalled();
  });
});
