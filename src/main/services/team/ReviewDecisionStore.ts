import { ReviewDecisionStore as PortableStore } from '@agent-teams/task-change-ledger/review-storage';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import type {
  FileReviewDecision,
  HunkDecision,
  ReviewConflictResolution,
  ReviewDecisionConflictCandidate,
  ReviewDecisionConflictCandidateSummary,
  ReviewRedoAction,
  ReviewUndoAction,
} from '@shared/types';
export type {
  LoadedReviewDecisions,
  ReviewDecisionsData,
} from '@agent-teams/task-change-ledger/review-storage';
import type { LoadedReviewDecisions } from '@agent-teams/task-change-ledger/review-storage';

export class ReviewDecisionStore {
  constructor(private readonly teamsRoot?: string) {
    this.pruneScopeDir = this.pruneScopeDir.bind(this);
  }
  private store(): PortableStore {
    return new PortableStore(
      this.teamsRoot ?? getTeamsBasePath(),
      createLogger('ReviewDecisionStore')
    );
  }
  assertValidSnapshot(data: {
    hunkDecisions: Record<string, HunkDecision>;
    fileDecisions: Record<string, HunkDecision>;
    hunkContextHashesByFile?: Record<string, Record<number, string>>;
    reviewActionHistory?: ReviewUndoAction[];
    reviewRedoHistory?: ReviewRedoAction[];
  }): void {
    return this.store().assertValidSnapshot(data);
  }
  load(
    teamName: string,
    scopeKey: string,
    scopeToken?: string
  ): Promise<LoadedReviewDecisions | null> {
    return this.store().load(teamName, scopeKey, scopeToken);
  }
  loadConflictCandidates(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDecisionConflictCandidate[]> {
    return this.store().loadConflictCandidates(teamName, scopeKey, scopeToken);
  }
  loadConflictCandidateSummaries(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDecisionConflictCandidateSummary[]> {
    return this.store().loadConflictCandidateSummaries(teamName, scopeKey, scopeToken);
  }
  loadConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string
  ): Promise<ReviewDecisionConflictCandidate> {
    return this.store().loadConflictCandidate(teamName, scopeKey, scopeToken, candidateId);
  }
  resolveConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string,
    resolution: ReviewConflictResolution,
    expectedCurrentRevision: number
  ): Promise<number> {
    return this.store().resolveConflictCandidate(
      teamName,
      scopeKey,
      scopeToken,
      candidateId,
      resolution,
      expectedCurrentRevision
    );
  }
  save(
    teamName: string,
    scopeKey: string,
    data: {
      scopeToken: string;
      hunkDecisions: Record<string, HunkDecision>;
      fileDecisions: Record<string, HunkDecision>;
      hunkContextHashesByFile?: Record<string, Record<number, string>>;
      reviewActionHistory?: ReviewUndoAction[];
      reviewRedoHistory?: ReviewRedoAction[];
      expectedRevision?: number;
      mutationId?: string;
    }
  ): Promise<number> {
    return this.store().save(teamName, scopeKey, data);
  }
  mergeFileDecisionPatch(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    decision: FileReviewDecision & { reviewKey: string }
  ): Promise<void> {
    return this.store().mergeFileDecisionPatch(teamName, scopeKey, scopeToken, decision);
  }
  clear(teamName: string, scopeKey: string, scopeToken?: string): Promise<void> {
    return this.store().clear(teamName, scopeKey, scopeToken);
  }
  clearUnreadableExactScope(teamName: string, scopeKey: string, scopeToken: string): Promise<void> {
    return this.store().clearUnreadableExactScope(teamName, scopeKey, scopeToken);
  }

  private async pruneScopeDir(team: string, scope: string, protectedPath: string): Promise<void> {
    return (
      this.store() as unknown as {
        pruneScopeDir(team: string, scope: string, protectedPath: string): Promise<void>;
      }
    ).pruneScopeDir(team, scope, protectedPath);
  }
}
