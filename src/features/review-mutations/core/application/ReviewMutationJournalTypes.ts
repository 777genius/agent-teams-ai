import type { ReviewMutationKind, ReviewMutationPhase } from '../../contracts';
import type {
  FileChangeWithContent,
  FileReviewDecision,
  ReviewDecisionPersistenceScope,
  ReviewDirectDiskMutationStep,
  ReviewFileScope,
  ReviewPersistedStateSnapshot,
} from '@shared/types/review';

export interface ReviewMutationJournalRecord {
  version: 2;
  id: string;
  phase: ReviewMutationPhase;
  kind: ReviewMutationKind;
  teamName: string;
  persistenceScope: ReviewDecisionPersistenceScope;
  reviewScope: ReviewFileScope;
  decisions: (FileReviewDecision & { reviewKey: string })[];
  fileContents: FileChangeWithContent[];
  decisionStatuses?: ('pending' | 'applied')[];
  decisionPostimages?: (ReviewMutationJournalPathPostimage[] | null)[];
  decisionTransitions?: (ReviewMutationJournalPathTransition[] | null)[];
  diskSteps?: ReviewMutationJournalDiskStep[];
  persistedState?: ReviewPersistedStateSnapshot;
  expectedDecisionRevision?: number;
  createdAt: string;
  updatedAt: string;
  blocked?: boolean;
  failure?: string;
}

export interface PrepareReviewMutationInput {
  teamName: string;
  persistenceScope: ReviewDecisionPersistenceScope;
  reviewScope: ReviewFileScope;
  kind: ReviewMutationKind;
  decisions: (FileReviewDecision & { reviewKey: string })[];
  fileContents: FileChangeWithContent[];
  diskSteps?: ReviewMutationJournalDiskStep[];
  persistedState?: ReviewPersistedStateSnapshot;
  expectedDecisionRevision?: number;
}

export type ReviewMutationJournalDiskStep = ReviewDirectDiskMutationStep & {
  status: 'pending' | 'applied';
  /** Main-resolved immutable rename evidence needed after the renderer is gone. */
  authoritativeContent?: FileChangeWithContent;
};

export interface ReviewMutationJournalPathPostimage {
  filePath: string;
  /** Null means the path must be absent. Existing text is stored by digest only. */
  sha256: string | null;
}

export interface ReviewMutationJournalPathTransition {
  filePath: string;
  beforeContent: string | null;
  afterContent: string | null;
  operation?: 'replace' | 'delete' | 'move';
  transactionId?: string;
  relatedFilePath?: string;
}
