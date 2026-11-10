import { ReviewDraftHistoryStore as PortableStore } from '@agent-teams/task-change-ledger/review-storage';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';

import type {
  ReviewDraftHistoryConflictCandidate,
  ReviewDraftHistoryConflictCandidateSummary,
  ReviewDraftHistoryEntry,
  ReviewDraftHistorySnapshot,
} from '@features/change-review-history/contracts';
import type { ReviewConflictResolution } from '@shared/types';
export type { SaveReviewDraftHistoryEntryInput } from '@agent-teams/task-change-ledger/review-storage';
import type { SaveReviewDraftHistoryEntryInput } from '@agent-teams/task-change-ledger/review-storage';

export class ReviewDraftHistoryStore {
  constructor(private readonly teamsRoot?: string) {}
  private store(): PortableStore {
    return new PortableStore(
      this.teamsRoot ?? getTeamsBasePath(),
      createLogger('ReviewDraftHistoryStore')
    );
  }
  load(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDraftHistorySnapshot | null> {
    return this.store().load(teamName, scopeKey, scopeToken);
  }
  loadConflictCandidates(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDraftHistoryConflictCandidate[]> {
    return this.store().loadConflictCandidates(teamName, scopeKey, scopeToken);
  }
  loadConflictCandidateSummaries(
    teamName: string,
    scopeKey: string,
    scopeToken: string
  ): Promise<ReviewDraftHistoryConflictCandidateSummary[]> {
    return this.store().loadConflictCandidateSummaries(teamName, scopeKey, scopeToken);
  }
  loadConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string
  ): Promise<ReviewDraftHistoryConflictCandidate> {
    return this.store().loadConflictCandidate(teamName, scopeKey, scopeToken, candidateId);
  }
  resolveConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string,
    resolution: ReviewConflictResolution,
    expectedCurrentRevision: number,
    expectedCurrentGeneration: string | null
  ): Promise<ReviewDraftHistoryEntry | null> {
    return this.store().resolveConflictCandidate(
      teamName,
      scopeKey,
      scopeToken,
      candidateId,
      resolution,
      expectedCurrentRevision,
      expectedCurrentGeneration
    );
  }
  replaceConflictCandidate(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    expectedEntry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
    replacementEntry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
    expectedCurrentRevision: number,
    expectedCurrentGeneration: string | null
  ): Promise<ReviewDraftHistoryConflictCandidate> {
    return this.store().replaceConflictCandidate(
      teamName,
      scopeKey,
      scopeToken,
      expectedEntry,
      replacementEntry,
      expectedCurrentRevision,
      expectedCurrentGeneration
    );
  }
  saveEntry(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    input: SaveReviewDraftHistoryEntryInput
  ): Promise<ReviewDraftHistoryEntry> {
    return this.store().saveEntry(teamName, scopeKey, scopeToken, input);
  }
  clearEntry(
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    filePath: string,
    expectedRevision: number,
    expectedGeneration: string | null
  ): Promise<void> {
    return this.store().clearEntry(
      teamName,
      scopeKey,
      scopeToken,
      filePath,
      expectedRevision,
      expectedGeneration
    );
  }
  clearScope(teamName: string, scopeKey: string, scopeToken: string): Promise<void> {
    return this.store().clearScope(teamName, scopeKey, scopeToken);
  }
  clearUnreadableScope(teamName: string, scopeKey: string, scopeToken: string): Promise<void> {
    return this.store().clearUnreadableScope(teamName, scopeKey, scopeToken);
  }
}
