import type {
  ApplyReviewRequest,
  ExecuteReviewMutationRequest,
  RestoreReviewHistoryRequest,
  RetryReviewMutationRecoveryRequest,
  ReviewFileScope,
  SnippetDiff,
  HunkDecision,
  ReviewRenameRecoveryExpectation,
  ReviewUndoAction,
  ReviewRedoAction,
  ReviewConflictResolution,
} from '../../contracts.js';
import type { ReviewDraftHistoryEntry } from '../storage/draftContracts.js';
import type { ReviewWriter } from '../writer/createReviewWriter.js';

/** Replaced only after the original Host binding and current principal have been authenticated. */
export const BOUND_REVIEW_TEAM = '__captured_review_team__';

/** Existing public input DTOs; the writer still owns authoritative validation and state guards. */
export interface ReviewWriterInputMap {
  checkConflict: [scope: ReviewFileScope, filePath: string, expectedModified: string];
  rejectHunks: [scope: ReviewFileScope, filePath: string, hunkIndices: number[]];
  rejectFile: [scope: ReviewFileScope, filePath: string];
  previewReject: [
    filePath: string,
    original: string,
    modified: string,
    hunkIndices: number[],
    snippets: SnippetDiff[],
  ];
  applyDecisions: [request: ApplyReviewRequest];
  executeReviewMutation: [request: ExecuteReviewMutationRequest];
  restoreReviewHistory: [request: RestoreReviewHistoryRequest];
  getFileContent: [
    teamName: string,
    memberName: string | undefined,
    filePath: string,
    snippets?: SnippetDiff[],
  ];
  saveEditedFile: [
    scope: ReviewFileScope,
    filePath: string,
    content: string,
    expectedCurrentContent: string | null,
  ];
  deleteEditedFile: [scope: ReviewFileScope, filePath: string, expectedCurrentContent: string];
  restoreRejectedRename: [
    scope: ReviewFileScope,
    filePath: string,
    expectation: ReviewRenameRecoveryExpectation,
  ];
  reapplyRejectedRename: [
    scope: ReviewFileScope,
    filePath: string,
    expectation: ReviewRenameRecoveryExpectation,
  ];
  retryReviewMutationRecovery: [request: RetryReviewMutationRecoveryRequest];
  loadDecisions: [teamName: string, scopeKey: string, scopeToken?: string | null];
  loadDecisionConflictCandidates: [teamName: string, scopeKey: string, scopeToken: string];
  resolveDecisionConflictCandidate: [
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string,
    resolution: ReviewConflictResolution,
    expectedCurrentRevision: number,
  ];
  saveDecisions: [
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    hunkDecisions: Record<string, HunkDecision>,
    fileDecisions: Record<string, HunkDecision>,
    hunkContextHashesByFile?: Record<string, Record<number, string>> | null,
    reviewActionHistory?: ReviewUndoAction[],
    expectedRevision?: number,
    reviewRedoHistory?: ReviewRedoAction[],
  ];
  clearDecisions: [
    teamName: string,
    scopeKey: string,
    scopeToken?: string | null,
    expectedRevision?: number,
  ];
  loadDraftHistory: [teamName: string, scopeKey: string, scopeToken: string];
  loadDraftHistoryConflictCandidates: [teamName: string, scopeKey: string, scopeToken: string];
  resolveDraftHistoryConflictCandidate: [
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    candidateId: string,
    resolution: ReviewConflictResolution,
    expectedCurrentRevision: number,
    expectedCurrentGeneration: string | null,
  ];
  replaceDraftHistoryConflictCandidate: [
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    expectedEntry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
    replacementEntry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
    expectedCurrentRevision: number,
    expectedCurrentGeneration: string | null,
  ];
  saveDraftHistoryEntry: [
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    entry: Omit<ReviewDraftHistoryEntry, 'updatedAt' | 'generation'>,
    expectedRevision: number,
    expectedGeneration: string | null,
  ];
  clearDraftHistory: [
    teamName: string,
    scopeKey: string,
    scopeToken: string,
    filePath?: string,
    expectedRevision?: number,
    expectedGeneration?: string | null,
  ];
}

export type ReviewWriterMethod = keyof ReviewWriterInputMap;
type AssertNever<T extends never> = T;
/** A writer API addition must receive an explicit finite transport decision. */
export type ReviewWriterTransportCoverage = AssertNever<
  Exclude<keyof ReviewWriter, ReviewWriterMethod | 'dispose'>
>;
export type ReviewWriterRequest = {
  [M in ReviewWriterMethod]: { method: M; args: ReviewWriterInputMap[M] };
}[ReviewWriterMethod];
type WireArgs<T extends unknown[]> = {
  [K in keyof T]: undefined extends T[K] ? Exclude<T[K], undefined> | null : T[K];
};
/** JSON tuple placeholders are distinct from the writer's original optional/default arguments. */
export type ReviewWriterWireRequest = {
  [M in ReviewWriterMethod]: {
    method: M;
    args: WireArgs<ReviewWriterInputMap[M]>;
  };
}[ReviewWriterMethod];
type WireValue<T> = T extends void ? null : T;
export type ReviewWriterResultMap = {
  [M in ReviewWriterMethod]: WireValue<Awaited<ReturnType<ReviewWriter[M]>>>;
};
export type ReviewWriterResponse = {
  [M in ReviewWriterMethod]: {
    kind: 'review-writer';
    method: M;
    result: ReviewWriterResultMap[M];
  };
}[ReviewWriterMethod];

/** Captured by the originating view; no global active task or previous-request lookup. */
export interface ReviewOriginScope {
  taskId?: string;
  memberName?: string;
}

/** Original Team command-family outcome; existing review WAL remains the disk recovery authority. */
export interface ReviewCommandLookup {
  kind: 'review-command';
  commandId: string;
  method: ReviewWriterMethod;
  origin: ReviewOriginScope;
  phase: 'prepared' | 'held' | 'completed';
  outcome: 'completed' | 'unknown';
  responseAvailable: boolean;
  response?: ReviewWriterResponse;
  references?: { walId?: string; actionId?: string; decisionRevision?: number };
}

/** Discovery metadata from the existing Team receipt family, never retained file arguments. */
export type ReviewRecoveryCommand = Pick<
  ReviewCommandLookup,
  'commandId' | 'method' | 'phase' | 'outcome' | 'responseAvailable' | 'references'
>;
export interface ReviewRecoveryRead {
  kind: 'review-recovery';
  origin: ReviewOriginScope;
  commands: ReviewRecoveryCommand[];
}
