import { ReviewMutationJournalStore as PortableStore } from '@agent-teams/task-change-ledger/review-storage';
import { getTeamsBasePath } from '@main/utils/pathDecoder';

import type {
  PrepareReviewMutationInput,
  ReviewMutationJournalDiscardInspection,
  ReviewMutationJournalRecord,
} from '@agent-teams/task-change-ledger/review-storage';
import type { ReviewMutationPhase } from '@features/review-mutations/contracts';
import type { ReviewDecisionPersistenceScope } from '@shared/types';

export class ReviewMutationJournalStore {
  constructor(private readonly teamsRoot?: string) {}
  private store(): PortableStore {
    return new PortableStore(this.teamsRoot ?? getTeamsBasePath());
  }
  prepare(input: PrepareReviewMutationInput): Promise<ReviewMutationJournalRecord> {
    return this.store().prepare(input);
  }
  transition(
    record: ReviewMutationJournalRecord,
    expectedPhase: ReviewMutationPhase,
    nextPhase: ReviewMutationPhase
  ): Promise<ReviewMutationJournalRecord> {
    return this.store().transition(record, expectedPhase, nextPhase);
  }
  checkpoint(record: ReviewMutationJournalRecord): Promise<ReviewMutationJournalRecord> {
    return this.store().checkpoint(record);
  }
  markFailed(record: ReviewMutationJournalRecord, error: unknown): Promise<void> {
    return this.store().markFailed(record, error);
  }
  unblock(record: ReviewMutationJournalRecord): Promise<ReviewMutationJournalRecord> {
    return this.store().unblock(record);
  }
  remove(record: ReviewMutationJournalRecord): Promise<void> {
    return this.store().remove(record);
  }
  clearScope(teamName: string, persistenceScope: ReviewDecisionPersistenceScope): Promise<void> {
    return this.store().clearScope(teamName, persistenceScope);
  }
  inspectForRecoveryDiscard(
    teamName: string,
    persistenceScope: ReviewDecisionPersistenceScope
  ): Promise<ReviewMutationJournalDiscardInspection> {
    return this.store().inspectForRecoveryDiscard(teamName, persistenceScope);
  }
  quarantineCorruptScope(
    teamName: string,
    persistenceScope: ReviewDecisionPersistenceScope
  ): Promise<string | null> {
    return this.store().quarantineCorruptScope(teamName, persistenceScope);
  }
  list(
    teamName: string,
    persistenceScope: ReviewDecisionPersistenceScope
  ): Promise<ReviewMutationJournalRecord[]> {
    return this.store().list(teamName, persistenceScope);
  }
}

export * from '@agent-teams/task-change-ledger/review-storage';
