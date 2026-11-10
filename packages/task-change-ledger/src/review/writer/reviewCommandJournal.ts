import type {
  ReviewMutationJournalStore,
  ReviewMutationJournalRecord,
  PrepareReviewMutationInput,
} from '../storage/ReviewMutationJournalStore.js';
import type { ReviewCommandCorrelation } from '../storage/reviewCommandCorrelation.js';
import type { ReviewDecisionStore } from '../storage/ReviewDecisionStore.js';
import type { ReviewMutationJournalPort } from './ReviewMutationCoordinator.js';
import { isDurableReviewEqual } from './decisionBatch.js';
export interface ReviewCommandCommitProof {
  correlation: ReviewCommandCorrelation;
  walId: string;
  kind: ReviewMutationJournalRecord['kind'];
  decisionRevision: number;
  actionId?: string;
}
export interface ReviewCommandReceiptObserver {
  /** Main-owned per-request scope; never supplied by renderer or inferred on recovery. */
  capture(): ReviewCommandCorrelation | undefined;
  committed(proof: ReviewCommandCommitProof): Promise<void> | void;
  /** Exact unresolved disk-transaction evidence keeps this original command held. */
  uncertain?(): void;
}
/** Adapts only existing WAL prepare/remove boundaries. The Coordinator remains the recovery engine. */
export function createReviewCommandJournal(
  journal: ReviewMutationJournalStore,
  decisions: ReviewDecisionStore,
  observer: ReviewCommandReceiptObserver | undefined,
  assertCurrent: () => void
): ReviewMutationJournalPort<ReviewMutationJournalRecord, PrepareReviewMutationInput> {
  return {
    prepare(input) {
      assertCurrent();
      const correlation = observer?.capture();
      return journal.prepare({
        ...input,
        ...(correlation ? { commandReceipt: structuredClone(correlation) } : {}),
      });
    },
    checkpoint: journal.checkpoint.bind(journal),
    transition: journal.transition.bind(journal),
    async remove(record) {
      if (record.commandReceipt) {
        if (
          !observer ||
          record.phase !== 'complete' ||
          !record.persistedState ||
          record.expectedDecisionRevision === undefined
        )
          throw new Error('Original review command owner is required before removing its WAL');
        if (
          record.commandReceipt.origin.taskId !== record.reviewScope.taskId ||
          (record.commandReceipt.origin.memberName &&
            record.reviewScope.memberName &&
            record.commandReceipt.origin.memberName !== record.reviewScope.memberName)
        )
          throw new Error('Review WAL command origin differs from its authoritative scope');
        assertCurrent();
        const committed = await decisions.inspectMutationCommit(
          record.teamName,
          record.persistenceScope.scopeKey,
          record.persistenceScope.scopeToken,
          record.id
        );
        assertCurrent();
        if (
          !committed ||
          committed.revision !== record.expectedDecisionRevision + 1 ||
          !isDurableReviewEqual(
            record.persistedState,
            committed && {
              hunkDecisions: committed.hunkDecisions,
              fileDecisions: committed.fileDecisions,
              hunkContextHashesByFile: committed.hunkContextHashesByFile,
              reviewActionHistory: committed.reviewActionHistory,
              reviewRedoHistory: committed.reviewRedoHistory,
            }
          )
        )
          throw new Error('Committed review command proof is unavailable');
        const actionId = committed.reviewActionHistory.at(-1)?.id;
        await observer.committed({
          correlation: structuredClone(record.commandReceipt),
          walId: record.id,
          kind: record.kind,
          decisionRevision: committed.revision,
          ...(actionId ? { actionId } : {}),
        });
        assertCurrent();
      }
      // A failed receipt publication retains this complete WAL for explicit recovery.
      await journal.remove(record);
    },
  };
}
