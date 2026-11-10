import { assertReviewStorageRoot } from '../io/capturedRoot.js';
import {
  type DecisionContext,
  type StorageLogger,
  type LoadedReviewDecisions,
} from './DecisionTypes.js';
import { createDecisionPaths } from './decisionPaths.js';
import { createDecisionCodec } from './decisionCodec.js';
import { createDecisionValidation } from './decisionValidation.js';
import { createDecisionConflictPersistence } from './decisionConflictPersistence.js';
import { createDecisionPersistence } from './decisionPersistence.js';
import { createDecisionConflictResolution } from './decisionConflictResolution.js';
import { createDecisionWrites } from './decisionWrites.js';

export class ReviewDecisionStore {
  readonly assertValidSnapshot: DecisionContext['assertValidSnapshot'];
  readonly load: DecisionContext['load'];
  readonly loadConflictCandidates: DecisionContext['loadConflictCandidates'];
  readonly loadConflictCandidateSummaries: DecisionContext['loadConflictCandidateSummaries'];
  readonly loadConflictCandidate: DecisionContext['loadConflictCandidate'];
  readonly resolveConflictCandidate: DecisionContext['resolveConflictCandidate'];
  readonly save: DecisionContext['save'];
  readonly mergeFileDecisionPatch: DecisionContext['mergeFileDecisionPatch'];
  readonly clear: DecisionContext['clear'];
  readonly inspectMutationCommit: (
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    mutationId: string
  ) => Promise<LoadedReviewDecisions | null>;
  readonly clearUnreadableExactScope: DecisionContext['clearUnreadableExactScope'];
  constructor(teamsRoot: string, logger: StorageLogger = { warn() {}, error() {} }) {
    assertReviewStorageRoot(teamsRoot);
    const ctx: DecisionContext = {
      teamsRoot,
      logger,
      ...createDecisionPaths(() => ctx),
      ...createDecisionCodec(() => ctx),
      ...createDecisionValidation(() => ctx),
      ...createDecisionConflictPersistence(() => ctx),
      ...createDecisionPersistence(() => ctx),
      ...createDecisionConflictResolution(() => ctx),
      ...createDecisionWrites(() => ctx),
    };
    Object.defineProperty(this, 'pruneScopeDir', { value: ctx.pruneScopeDir });
    this.assertValidSnapshot = ctx.assertValidSnapshot;
    this.load = ctx.load;
    this.inspectMutationCommit = async (teamName, scopeKey, scopeToken, mutationId) => {
      const loaded = await ctx.loadInternal(teamName, scopeKey, scopeToken);
      if (!loaded || loaded.lastMutationId !== mutationId) return null;
      const {
        lastMutationId: _lastMutationId,
        storageVersion: _storageVersion,
        ...snapshot
      } = loaded;
      return snapshot;
    };
    this.loadConflictCandidates = ctx.loadConflictCandidates;
    this.loadConflictCandidateSummaries = ctx.loadConflictCandidateSummaries;
    this.loadConflictCandidate = ctx.loadConflictCandidate;
    this.resolveConflictCandidate = ctx.resolveConflictCandidate;
    this.save = ctx.save;
    this.mergeFileDecisionPatch = ctx.mergeFileDecisionPatch;
    this.clear = ctx.clear;
    this.clearUnreadableExactScope = ctx.clearUnreadableExactScope;
  }
}
export type { ReviewDecisionsData, LoadedReviewDecisions } from './DecisionTypes.js';
