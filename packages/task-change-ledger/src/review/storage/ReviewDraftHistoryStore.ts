import { assertReviewStorageRoot } from '../io/capturedRoot.js';
import { type DraftContext, type StorageLogger } from './DraftTypes.js';
import { createDraftPersistence } from './draftPersistence.js';
import { createDraftConflictPersistence } from './draftConflictPersistence.js';
import { createDraftConflictResolution } from './draftConflictResolution.js';
import { createDraftWrites } from './draftWrites.js';

export class ReviewDraftHistoryStore {
  readonly load: DraftContext['load'];
  readonly loadConflictCandidates: DraftContext['loadConflictCandidates'];
  readonly loadConflictCandidateSummaries: DraftContext['loadConflictCandidateSummaries'];
  readonly loadConflictCandidate: DraftContext['loadConflictCandidate'];
  readonly resolveConflictCandidate: DraftContext['resolveConflictCandidate'];
  readonly replaceConflictCandidate: DraftContext['replaceConflictCandidate'];
  readonly saveEntry: DraftContext['saveEntry'];
  readonly clearEntry: DraftContext['clearEntry'];
  readonly clearScope: DraftContext['clearScope'];
  readonly clearUnreadableScope: DraftContext['clearUnreadableScope'];
  constructor(teamsRoot: string, logger: StorageLogger = { warn() {}, error() {} }) {
    assertReviewStorageRoot(teamsRoot);
    const ctx: DraftContext = {
      teamsRoot,
      logger,
      ...createDraftPersistence(() => ctx),
      ...createDraftConflictPersistence(() => ctx),
      ...createDraftConflictResolution(() => ctx),
      ...createDraftWrites(() => ctx),
    };
    this.load = ctx.load;
    this.loadConflictCandidates = ctx.loadConflictCandidates;
    this.loadConflictCandidateSummaries = ctx.loadConflictCandidateSummaries;
    this.loadConflictCandidate = ctx.loadConflictCandidate;
    this.resolveConflictCandidate = ctx.resolveConflictCandidate;
    this.replaceConflictCandidate = ctx.replaceConflictCandidate;
    this.saveEntry = ctx.saveEntry;
    this.clearEntry = ctx.clearEntry;
    this.clearScope = ctx.clearScope;
    this.clearUnreadableScope = ctx.clearUnreadableScope;
  }
}
export type { SaveReviewDraftHistoryEntryInput } from './DraftTypes.js';
