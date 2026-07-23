import { ReviewDecisionHistoryApplication } from '@features/change-review-history/core/application/ReviewDecisionHistoryApplication';
import { describe, expect, it, vi } from 'vitest';

import type {
  LoadedReviewDecisionState,
  ReviewDecisionAuthorization,
  ReviewDecisionHistoryDependencies,
} from '@features/change-review-history/core/application/ReviewDecisionHistoryPorts';
import type { ReviewHistoryPersistenceScope } from '@features/change-review-history/core/application/ports';
import type {
  FileChangeSummary,
  ReviewDecisionConflictCandidate,
  ReviewPersistedStateSnapshot,
  ReviewUndoAction,
} from '@shared/types/review';

const TEAM_NAME = 'safe-team';
const SCOPE_KEY = 'agent-worker';
const SCOPE_TOKEN = 'scope-token';
const REVIEWED_FILE = '/repo/src/reviewed.ts';
const FOREIGN_FILE = '/repo/src/foreign.ts';
const REVIEW_KEY = 'reviewed-change';

const reviewedFile: FileChangeSummary = {
  filePath: REVIEWED_FILE,
  relativePath: 'src/reviewed.ts',
  snippets: [],
  linesAdded: 1,
  linesRemoved: 0,
  isNewFile: false,
  changeKey: REVIEW_KEY,
};

function hunkAction(id: string, originalIndex: number, filePath = REVIEWED_FILE): ReviewUndoAction {
  return {
    id,
    createdAt: '2026-07-23T12:00:00.000Z',
    kind: 'hunk',
    action: { filePath, originalIndex },
  };
}

function snapshot(
  overrides: Partial<ReviewPersistedStateSnapshot> = {}
): ReviewPersistedStateSnapshot {
  return {
    hunkDecisions: {},
    fileDecisions: {},
    hunkContextHashesByFile: {},
    reviewActionHistory: [],
    reviewRedoHistory: [],
    ...overrides,
  };
}

function loaded(overrides: Partial<LoadedReviewDecisionState> = {}): LoadedReviewDecisionState {
  return { ...snapshot(), revision: 1, ...overrides };
}

function conflictCandidate(
  overrides: Partial<ReviewDecisionConflictCandidate> = {}
): ReviewDecisionConflictCandidate {
  return {
    id: 'candidate-id',
    capturedAt: '2026-07-23T12:00:00.000Z',
    origin: 'current-snapshot',
    expectedRevision: 0,
    observedCurrentRevision: 1,
    state: snapshot(),
    ...overrides,
  };
}

function createHarness(
  options: {
    current?: LoadedReviewDecisionState | null;
    candidate?: ReviewDecisionConflictCandidate;
    containsPotentialDiskMutation?: boolean;
    corruptRecordCount?: number;
  } = {}
) {
  const order: string[] = [];
  const authorization: ReviewDecisionAuthorization = {
    files: [reviewedFile],
    normalizePath: (filePath) => filePath.toLowerCase(),
    resolveFile: (filePath) => {
      if (filePath.toLowerCase() !== REVIEWED_FILE.toLowerCase()) {
        throw new Error('File is not part of the reviewed scope');
      }
      return reviewedFile;
    },
  };
  const dependencies: ReviewDecisionHistoryDependencies = {
    lock: {
      async run<T>(
        _teamName: string,
        _scope: ReviewHistoryPersistenceScope,
        operation: () => Promise<T>
      ): Promise<T> {
        order.push('lock');
        return operation();
      },
    },
    authorization: {
      authorize: vi.fn(async () => {
        order.push('authorize');
        return authorization;
      }),
    },
    queries: {
      load: vi.fn(async () => {
        order.push('repo:load');
        return options.current ?? null;
      }),
      loadConflictCandidateSummaries: vi.fn(async () => {
        order.push('repo:load-candidates');
        return [];
      }),
      loadConflictCandidate: vi.fn(async () => {
        order.push('repo:load-candidate');
        return options.candidate ?? conflictCandidate();
      }),
    },
    mutations: {
      resolveConflictCandidate: vi.fn(async () => {
        order.push('repo:resolve');
        return 2;
      }),
      save: vi.fn(async () => {
        order.push('repo:save');
        return 2;
      }),
      clear: vi.fn(async () => {
        order.push('repo:clear');
      }),
      clearUnreadableExactScope: vi.fn(async () => {
        order.push('repo:clear-unreadable');
      }),
    },
    validation: {
      assertValidSnapshot: vi.fn(() => {
        order.push('validate');
      }),
    },
    recovery: {
      recover: vi.fn(async () => {
        order.push('recover');
      }),
      inspectForDiscard: vi.fn(async () => {
        order.push('inspect');
        return {
          containsPotentialDiskMutation: options.containsPotentialDiskMutation ?? false,
          corruptRecordCount: options.corruptRecordCount ?? 0,
        };
      }),
      quarantineCorruptScope: vi.fn(async () => {
        order.push('quarantine');
      }),
      clearScope: vi.fn(async () => {
        order.push('clear-journal');
      }),
    },
  };
  return {
    application: new ReviewDecisionHistoryApplication(dependencies),
    authorization: dependencies.authorization,
    mutations: dependencies.mutations,
    order,
    recovery: dependencies.recovery,
  };
}

describe('ReviewDecisionHistoryApplication', () => {
  it('preserves legacy loading while exact-scope reads recover under the shared lock', async () => {
    const legacy = createHarness({ current: loaded() });
    await legacy.application.load(TEAM_NAME, SCOPE_KEY);
    expect(legacy.order).toEqual(['repo:load']);

    const exact = createHarness({ current: loaded() });
    await exact.application.load(TEAM_NAME, SCOPE_KEY, SCOPE_TOKEN);
    expect(exact.order).toEqual(['lock', 'recover', 'repo:load']);
  });

  it('orders authorization before recovery and repository conflict queries', async () => {
    const harness = createHarness();

    await harness.application.loadConflictCandidates(TEAM_NAME, SCOPE_KEY, SCOPE_TOKEN);

    expect(harness.order).toEqual(['lock', 'authorize', 'recover', 'repo:load-candidates']);
  });

  it('rejects prior-snapshot and foreign recovery candidates before mutation', async () => {
    const prior = createHarness({
      candidate: conflictCandidate({ origin: 'prior-snapshot' }),
    });
    await expect(
      prior.application.resolveConflictCandidate(
        TEAM_NAME,
        SCOPE_KEY,
        SCOPE_TOKEN,
        'candidate-id',
        'recover-candidate',
        1
      )
    ).rejects.toThrow('different review snapshot');
    expect(prior.mutations.resolveConflictCandidate).not.toHaveBeenCalled();

    const foreign = createHarness({
      candidate: conflictCandidate({
        state: snapshot({
          hunkDecisions: { [`${FOREIGN_FILE}:0`]: 'accepted' },
          reviewActionHistory: [hunkAction('foreign', 0, FOREIGN_FILE)],
        }),
      }),
    });
    await expect(
      foreign.application.resolveConflictCandidate(
        TEAM_NAME,
        SCOPE_KEY,
        SCOPE_TOKEN,
        'candidate-id',
        'recover-candidate',
        1
      )
    ).rejects.toThrow('outside the active review');
    expect(foreign.mutations.resolveConflictCandidate).not.toHaveBeenCalled();
  });

  it('treats an identical stale save as response-loss without authorization or a second write', async () => {
    const action = hunkAction('accepted', 0);
    const current = loaded({
      hunkDecisions: { [`${REVIEW_KEY}:0`]: 'accepted' },
      reviewActionHistory: [action],
    });
    const harness = createHarness({ current });

    await expect(
      harness.application.save(
        TEAM_NAME,
        SCOPE_KEY,
        SCOPE_TOKEN,
        current.hunkDecisions,
        current.fileDecisions,
        current.hunkContextHashesByFile ?? null,
        current.reviewActionHistory,
        0,
        current.reviewRedoHistory
      )
    ).resolves.toEqual({ revision: 1 });
    expect(harness.authorization.authorize).not.toHaveBeenCalled();
    expect(harness.mutations.save).not.toHaveBeenCalled();
    expect(harness.order).toEqual(['lock', 'recover', 'validate', 'repo:load']);
  });

  it('reconciles a stale generic prefix to the newer canonical suffix', async () => {
    const first = hunkAction('first', 0);
    const second = hunkAction('second', 1);
    const current = loaded({
      hunkDecisions: {
        [`${REVIEW_KEY}:0`]: 'accepted',
        [`${REVIEW_KEY}:1`]: 'rejected',
      },
      reviewActionHistory: [first, second],
    });
    const harness = createHarness({ current });

    await expect(
      harness.application.save(
        TEAM_NAME,
        SCOPE_KEY,
        SCOPE_TOKEN,
        { [`${REVIEW_KEY}:0`]: 'accepted' },
        {},
        {},
        [first],
        0,
        []
      )
    ).resolves.toEqual({
      revision: 1,
      reconciledState: {
        hunkDecisions: current.hunkDecisions,
        fileDecisions: {},
        hunkContextHashesByFile: {},
        reviewActionHistory: [first, second],
        reviewRedoHistory: [],
      },
    });
    expect(harness.mutations.save).not.toHaveBeenCalled();
    expect(harness.order).toEqual(['lock', 'recover', 'validate', 'repo:load', 'authorize']);
  });

  it('rejects renderer-injected disk history before authorization and persistence', async () => {
    const diskAction: ReviewUndoAction = {
      id: 'disk-action',
      createdAt: '2026-07-23T12:00:00.000Z',
      kind: 'disk',
      action: {
        snapshot: {
          filePath: REVIEWED_FILE,
          beforeContent: 'before\n',
          afterContent: 'after\n',
        },
      },
    };
    const harness = createHarness();

    await expect(
      harness.application.save(TEAM_NAME, SCOPE_KEY, SCOPE_TOKEN, {}, {}, {}, [diskAction], 0, [])
    ).rejects.toThrow('Disk review history must be committed atomically');
    expect(harness.authorization.authorize).not.toHaveBeenCalled();
    expect(harness.mutations.save).not.toHaveBeenCalled();
  });

  it('persists an exact authorized generic transition after recovery and validation', async () => {
    const action = hunkAction('accept-hunk', 0);
    const harness = createHarness();

    await expect(
      harness.application.save(
        TEAM_NAME,
        SCOPE_KEY,
        SCOPE_TOKEN,
        { [`${REVIEW_KEY}:0`]: 'accepted' },
        {},
        {},
        [action],
        0,
        []
      )
    ).resolves.toEqual({ revision: 2 });
    expect(harness.order).toEqual([
      'lock',
      'recover',
      'validate',
      'repo:load',
      'authorize',
      'repo:save',
    ]);
  });

  it('fail-closes unreadable-state discard when a disk mutation may be partial', async () => {
    const harness = createHarness({ containsPotentialDiskMutation: true });

    await expect(harness.application.clear(TEAM_NAME, SCOPE_KEY, SCOPE_TOKEN)).rejects.toThrow(
      'Cannot discard a disk mutation'
    );
    expect(harness.mutations.clearUnreadableExactScope).not.toHaveBeenCalled();
    expect(harness.order).toEqual(['lock', 'inspect']);
  });

  it('quarantines corrupt metadata only after clearing the unreadable exact scope', async () => {
    const harness = createHarness({ corruptRecordCount: 1 });

    await expect(harness.application.clear(TEAM_NAME, SCOPE_KEY, SCOPE_TOKEN)).resolves.toEqual({
      revision: 0,
    });
    expect(harness.order).toEqual(['lock', 'inspect', 'repo:clear-unreadable', 'quarantine']);
    expect(harness.recovery.clearScope).not.toHaveBeenCalled();
  });

  it('recovers then writes an exact empty snapshot for revision-guarded clear', async () => {
    const harness = createHarness();

    await expect(harness.application.clear(TEAM_NAME, SCOPE_KEY, SCOPE_TOKEN, 3)).resolves.toEqual({
      revision: 2,
    });
    expect(harness.order).toEqual(['lock', 'recover', 'repo:save']);
    expect(harness.mutations.save).toHaveBeenCalledWith(TEAM_NAME, SCOPE_KEY, {
      scopeToken: SCOPE_TOKEN,
      hunkDecisions: {},
      fileDecisions: {},
      hunkContextHashesByFile: {},
      reviewActionHistory: [],
      reviewRedoHistory: [],
      expectedRevision: 3,
    });
  });
});
