import { ReviewMutationCoordinator } from '@features/review-mutations/main';
import { describe, expect, it, vi } from 'vitest';

import type { ReviewMutationPhase } from '@features/review-mutations/contracts';
import type {
  ReviewMutationJournalPort,
  ReviewMutationSteps,
} from '@features/review-mutations/main';

interface TestRecord {
  id: string;
  phase: ReviewMutationPhase;
}

function createHarness(initialPhase: ReviewMutationPhase = 'prepared') {
  let durable: TestRecord | null = null;
  const events: string[] = [];
  const journal: ReviewMutationJournalPort<TestRecord, { id: string }> = {
    prepare: vi.fn(async ({ id }) => {
      const next: TestRecord = { id, phase: 'prepared' };
      durable = next;
      events.push('persist:prepared');
      return next;
    }),
    checkpoint: vi.fn(async (record) => record),
    transition: vi.fn(async (record, expectedPhase, nextPhase) => {
      expect(record.phase).toBe(expectedPhase);
      const next: TestRecord = { ...record, phase: nextPhase };
      durable = next;
      events.push(`persist:${nextPhase}`);
      return next;
    }),
    remove: vi.fn(async (record) => {
      expect(record.phase).toBe('complete');
      events.push('remove');
      durable = null;
    }),
  };
  const steps: ReviewMutationSteps<TestRecord> = {
    applyDisk: vi.fn(async () => {
      events.push('disk');
    }),
    commitDecisions: vi.fn(async () => {
      events.push('decisions');
    }),
  };
  const recovered: TestRecord = { id: 'operation-1', phase: initialPhase };
  durable = recovered;
  return { journal, steps, events, recovered, getDurable: () => durable };
}

describe('ReviewMutationCoordinator', () => {
  it('persists every phase after its side effect and removes only complete records', async () => {
    const harness = createHarness();
    const coordinator = new ReviewMutationCoordinator(harness.journal);

    await coordinator.execute({ id: 'operation-1' }, harness.steps);

    expect(harness.events).toEqual([
      'persist:prepared',
      'disk',
      'persist:disk_applied',
      'decisions',
      'persist:decisions_committed',
      'persist:complete',
      'remove',
    ]);
    expect(harness.getDurable()).toBeNull();
  });

  it.each([
    ['prepared', 1, 1],
    ['disk_applied', 1, 1],
    ['decisions_committed', 0, 0],
    ['complete', 0, 0],
  ] as const)(
    'resumes %s while re-verifying a disk_applied postimage',
    async (phase, expectedDiskCalls, expectedDecisionCalls) => {
      const harness = createHarness(phase);
      const coordinator = new ReviewMutationCoordinator(harness.journal);

      await coordinator.resume(harness.recovered, harness.steps);

      expect(harness.steps.applyDisk).toHaveBeenCalledTimes(expectedDiskCalls);
      expect(harness.steps.commitDecisions).toHaveBeenCalledTimes(expectedDecisionCalls);
      expect(harness.getDurable()).toBeNull();
    }
  );

  it.each(['prepared', 'disk_applied', 'decisions_committed', 'complete'] as const)(
    'leaves the durable %s checkpoint when the process crashes there',
    async (phase) => {
      const harness = createHarness();
      const crash = new Error(`crash:${phase}`);
      const coordinator = new ReviewMutationCoordinator(harness.journal, {
        afterPhasePersisted: (persistedPhase) => {
          if (persistedPhase === phase) throw crash;
        },
      });

      await expect(coordinator.execute({ id: 'operation-1' }, harness.steps)).rejects.toBe(crash);
      expect(harness.getDurable()?.phase).toBe(phase);
    }
  );
});
