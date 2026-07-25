import { createHash } from 'node:crypto';

import {
  ReviewDecisionBatchApplication,
  ReviewMutationApplyResultError,
} from '@features/review-mutations/main';
import { describe, expect, it, vi } from 'vitest';

import type {
  ReviewDecisionBatchDependencies,
  ReviewMutationJournalRecord,
} from '@features/review-mutations/main';
import type { FileChangeWithContent, FileReviewDecision } from '@shared/types/review';

const FILE_PATH = '/sandbox/fixture.ts';

function createContent(filePath = FILE_PATH): FileChangeWithContent {
  return {
    filePath,
    relativePath: 'fixture.ts',
    snippets: [
      {
        toolUseId: 'tool-1',
        filePath,
        toolName: 'Edit',
        type: 'edit',
        oldString: 'before\n',
        newString: 'after\n',
        replaceAll: false,
        timestamp: '2026-07-24T00:00:00.000Z',
        isError: false,
      },
    ],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
    changeKey: 'fixture-change',
    originalFullContent: 'before\n',
    modifiedFullContent: 'after\n',
    contentSource: 'ledger-exact',
  };
}

function createDecision(filePath = FILE_PATH): FileReviewDecision & { reviewKey: string } {
  return {
    filePath,
    reviewKey: 'fixture-change',
    fileDecision: 'rejected',
    hunkDecisions: { 0: 'rejected' },
  };
}

function createRecord(
  overrides: Partial<ReviewMutationJournalRecord> = {}
): ReviewMutationJournalRecord {
  const decision = createDecision();
  return {
    version: 2,
    id: 'mutation-1',
    phase: 'prepared',
    kind: 'reject',
    teamName: 'safe-team',
    persistenceScope: { scopeKey: 'agent-worker', scopeToken: 'scope-token' },
    reviewScope: { teamName: 'safe-team', memberName: 'worker' },
    decisions: [decision],
    fileContents: [createContent()],
    decisionStatuses: ['pending'],
    persistedState: {
      hunkDecisions: { 'fixture-change:0': 'rejected' },
      fileDecisions: { 'fixture-change': 'rejected' },
      reviewActionHistory: [],
      reviewRedoHistory: [],
    },
    expectedDecisionRevision: 7,
    createdAt: '2026-07-24T00:00:00.000Z',
    updatedAt: '2026-07-24T00:00:00.000Z',
    ...overrides,
  };
}

function createHarness(
  applyResult: {
    applied: number;
    skipped: number;
    conflicts: number;
    errors: { filePath: string; error: string }[];
  } = { applied: 1, skipped: 0, conflicts: 0, errors: [] }
) {
  const disk = new Map<string, string>([[FILE_PATH, 'before\n']]);
  const checkpoint = vi.fn(async (record: ReviewMutationJournalRecord) => record);
  const markFailed = vi.fn(async () => undefined);
  const remove = vi.fn(async () => undefined);
  const finalizeReviewDiskTransitions = vi.fn(async () => undefined);
  const applyReviewDecisions: ReviewDecisionBatchDependencies['applier']['applyReviewDecisions'] =
    vi.fn(async (_request, _contents, hooks) => {
      if (applyResult.errors.length === 0) {
        await hooks.checkpointDiskTransitions([
          {
            filePath: FILE_PATH,
            beforeContent: 'before\n',
            afterContent: 'after\n',
            operation: 'replace',
            transactionId: 'transaction-1',
          },
        ]);
        disk.set(FILE_PATH, 'after\n');
      }
      return applyResult;
    });
  const save = vi.fn(async () => 8);
  const mergeFileDecisionPatch = vi.fn(async () => undefined);
  const invalidateAuthoritativeContent = vi.fn();
  const dependencies: ReviewDecisionBatchDependencies = {
    scope: {
      parse: (value) => value as ReviewMutationJournalRecord['reviewScope'],
      normalizeIdentityPath: (filePath) => filePath,
    },
    journal: { checkpoint, markFailed, remove },
    applier: {
      applyReviewDecisions,
      finalizeReviewDiskTransitions,
    },
    persistence: { save, mergeFileDecisionPatch },
    files: {
      readText: async (filePath) => {
        const content = disk.get(filePath);
        if (content !== undefined) return content;
        throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      },
      inspectTransaction: vi.fn(async () => 'published' as const),
    },
    cache: { invalidateAuthoritativeContent },
    logger: { warn: vi.fn(), error: vi.fn() },
  };
  return {
    application: new ReviewDecisionBatchApplication(dependencies),
    applyReviewDecisions,
    checkpoint,
    disk,
    finalizeReviewDiskTransitions,
    invalidateAuthoritativeContent,
    markFailed,
    mergeFileDecisionPatch,
    remove,
    save,
  };
}

describe('ReviewDecisionBatchApplication', () => {
  it('checkpoints transition and postimage evidence before reporting a batch as applied', async () => {
    const harness = createHarness();
    const progress: number[] = [];
    const postimages: { filePath: string; content: string | null }[][] = [];

    const recovered = await harness.application.applyDisk(
      createRecord(),
      (result) => progress.push(result.applied),
      (next) => postimages.push([...next])
    );

    expect(harness.applyReviewDecisions).toHaveBeenCalledTimes(1);
    expect(harness.checkpoint).toHaveBeenCalledTimes(2);
    expect(recovered.decisionStatuses).toEqual(['applied']);
    expect(recovered.decisionPostimages).toEqual([
      [
        {
          filePath: FILE_PATH,
          sha256: createHash('sha256').update('after\n').digest('hex'),
        },
      ],
    ]);
    expect(progress).toEqual([1]);
    expect(postimages).toEqual([[{ filePath: FILE_PATH, content: 'after\n' }]]);
    expect(harness.finalizeReviewDiskTransitions).toHaveBeenCalledWith([
      expect.objectContaining({ transactionId: 'transaction-1' }),
    ]);
    expect(harness.invalidateAuthoritativeContent).toHaveBeenCalledWith(createContent());
  });

  it('blocks recovery when a checkpointed applied postimage has drifted', async () => {
    const harness = createHarness();
    const record = createRecord({
      decisionStatuses: ['applied'],
      decisionPostimages: [[{ filePath: FILE_PATH, sha256: 'stale-digest' }]],
    });

    await expect(harness.application.applyDisk(record)).rejects.toThrow(
      `Review mutation postimage changed after crash; refusing recovery for ${FILE_PATH}`
    );
    expect(harness.markFailed).toHaveBeenCalledWith(record, expect.any(Error));
    expect(harness.applyReviewDecisions).not.toHaveBeenCalled();
  });

  it('removes a clean conflict journal and preserves the exact aggregate error', async () => {
    const harness = createHarness({
      applied: 0,
      skipped: 0,
      conflicts: 1,
      errors: [{ filePath: FILE_PATH, error: 'content changed' }],
    });
    const record = createRecord();

    const failure = await harness.application.applyDisk(record).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(ReviewMutationApplyResultError);
    expect((failure as ReviewMutationApplyResultError).result).toEqual({
      applied: 0,
      skipped: 0,
      conflicts: 1,
      errors: [{ filePath: FILE_PATH, error: 'content changed' }],
    });
    expect(harness.remove).toHaveBeenCalledWith(record);
    expect(harness.markFailed).not.toHaveBeenCalled();
  });

  it('commits an exact snapshot with the journal revision and mutation id', async () => {
    const harness = createHarness();
    const record = createRecord();

    await harness.application.commit(record);

    expect(harness.save).toHaveBeenCalledWith('safe-team', 'agent-worker', {
      scopeToken: 'scope-token',
      ...record.persistedState,
      expectedRevision: 7,
      mutationId: 'mutation-1',
    });
    expect(harness.mergeFileDecisionPatch).not.toHaveBeenCalled();
  });

  it('rejects a persisted state that does not contain the requested decision', () => {
    const harness = createHarness();

    expect(() =>
      harness.application.assertPersistedStateIncludesDecisions(
        {
          hunkDecisions: {},
          fileDecisions: {},
          reviewActionHistory: [],
          reviewRedoHistory: [],
        },
        [createDecision()]
      )
    ).toThrow('Durable review state does not match the requested file decision');
  });
});
