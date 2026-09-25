import { ReviewDirectMutationDiskService } from '@features/review-mutations/main';
import { describe, expect, it, vi } from 'vitest';

import type {
  ReviewDirectMutationDiskDependencies,
  ReviewMutationJournalRecord,
} from '@features/review-mutations/main';

function createRecord(status: 'pending' | 'applied'): ReviewMutationJournalRecord {
  return {
    version: 2,
    id: 'mutation-1',
    phase: 'prepared',
    kind: 'undo',
    teamName: 'safe-team',
    persistenceScope: { scopeKey: 'agent-worker', scopeToken: 'scope-token' },
    reviewScope: { teamName: 'safe-team', memberName: 'worker' },
    decisions: [],
    fileContents: [],
    diskSteps: [
      {
        id: 'write-1',
        type: 'write',
        filePath: '/sandbox/fixture.ts',
        expectedContent: 'before\n',
        content: 'after\n',
        status,
      },
    ],
    persistedState: {
      hunkDecisions: {},
      fileDecisions: {},
      reviewActionHistory: [],
      reviewRedoHistory: [],
    },
    expectedDecisionRevision: 0,
    createdAt: '2026-07-23T00:00:00.000Z',
    updatedAt: '2026-07-23T00:00:00.000Z',
  };
}

function createHarness(classifiedState: 'before' | 'after') {
  const checkpoint = vi.fn(async (record: ReviewMutationJournalRecord) => record);
  const markFailed = vi.fn(async () => undefined);
  const saveEditedFile = vi.fn(async () => ({ success: true }));
  const finalizeEditedFileTransaction = vi.fn(async () => undefined);
  const dependencies = {
    scope: {
      normalizeIdentityPath: (filePath: string) => filePath,
    },
    journal: { checkpoint, markFailed },
    applier: {
      classifyEditedFileTransition: vi.fn(async () => classifiedState),
      saveEditedFile,
      finalizeEditedFileTransaction,
    },
    cache: {
      invalidateAuthoritativeContent: vi.fn(),
      invalidateFile: vi.fn(),
    },
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
    },
  } as unknown as ReviewDirectMutationDiskDependencies;
  return {
    service: new ReviewDirectMutationDiskService(dependencies),
    checkpoint,
    markFailed,
    saveEditedFile,
    finalizeEditedFileTransaction,
  };
}

describe('ReviewDirectMutationDiskService crash recovery', () => {
  it('checkpoints an observed postimage without replaying the disk write', async () => {
    const harness = createHarness('after');

    const recovered = await harness.service.apply(createRecord('pending'));

    expect(harness.saveEditedFile).not.toHaveBeenCalled();
    expect(harness.checkpoint).toHaveBeenCalledTimes(1);
    expect(recovered.diskSteps?.[0]?.status).toBe('applied');
    expect(harness.finalizeEditedFileTransaction).toHaveBeenCalledWith(
      '/sandbox/fixture.ts',
      'before\n',
      'after\n'
    );
  });

  it('blocks recovery when a checkpointed postimage drifted', async () => {
    const harness = createHarness('before');
    const record = createRecord('applied');

    await expect(harness.service.apply(record)).rejects.toThrow(
      'Applied review mutation changed after crash; refusing recovery'
    );
    expect(harness.markFailed).toHaveBeenCalledWith(record, expect.any(Error));
    expect(harness.saveEditedFile).not.toHaveBeenCalled();
  });
});
