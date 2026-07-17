import type { PhasedReviewMutation, ReviewMutationPhase } from '../../contracts';

export interface ReviewMutationJournalPort<TRecord extends PhasedReviewMutation, TPrepareInput> {
  prepare(input: TPrepareInput): Promise<TRecord>;
  checkpoint(record: TRecord): Promise<TRecord>;
  transition(
    record: TRecord,
    expectedPhase: ReviewMutationPhase,
    nextPhase: ReviewMutationPhase
  ): Promise<TRecord>;
  remove(record: TRecord): Promise<void>;
}

export interface ReviewMutationSteps<TRecord extends PhasedReviewMutation> {
  applyDisk(record: TRecord): Promise<TRecord | void>;
  commitDecisions(record: TRecord): Promise<void>;
}

export interface ReviewMutationPhaseObserver<TRecord extends PhasedReviewMutation> {
  afterPhasePersisted(phase: ReviewMutationPhase, record: TRecord): Promise<void> | void;
}

/**
 * Drives every review mutation through the same durable forward-only protocol.
 *
 * Step implementations must be idempotent. A process may die after a side effect
 * but before the following phase write; recovery deliberately retries that step.
 */
export class ReviewMutationCoordinator<TRecord extends PhasedReviewMutation, TPrepareInput> {
  constructor(
    private readonly journal: ReviewMutationJournalPort<TRecord, TPrepareInput>,
    private readonly observer?: ReviewMutationPhaseObserver<TRecord>
  ) {}

  async execute(input: TPrepareInput, steps: ReviewMutationSteps<TRecord>): Promise<TRecord> {
    const prepared = await this.journal.prepare(input);
    await this.observe(prepared);
    return this.resume(prepared, steps);
  }

  async resume(record: TRecord, steps: ReviewMutationSteps<TRecord>): Promise<TRecord> {
    let current = record;
    const resumedFromDiskApplied = current.phase === 'disk_applied';

    if (current.phase === 'prepared') {
      current = (await steps.applyDisk(current)) ?? current;
      current = await this.journal.transition(current, 'prepared', 'disk_applied');
      await this.observe(current);
    }

    if (current.phase === 'disk_applied') {
      // A crash can happen after the durable phase transition and before the
      // decision commit. Re-run the idempotent disk step on that recovery path
      // so it verifies every recorded postimage before committing decisions.
      if (resumedFromDiskApplied) {
        current = (await steps.applyDisk(current)) ?? current;
      }
      await steps.commitDecisions(current);
      current = await this.journal.transition(current, 'disk_applied', 'decisions_committed');
      await this.observe(current);
    }

    if (current.phase === 'decisions_committed') {
      current = await this.journal.transition(current, 'decisions_committed', 'complete');
      await this.observe(current);
    }

    if (current.phase === 'complete') {
      await this.journal.remove(current);
    }

    return current;
  }

  private async observe(record: TRecord): Promise<void> {
    await this.observer?.afterPhasePersisted(record.phase, record);
  }
}
