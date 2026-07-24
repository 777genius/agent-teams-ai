import type { ReviewUndoActionInput } from '../utils/changeReviewActionHistory';
import type {
  ApplyReviewResult,
  ConflictCheckResult,
  ExecuteReviewMutationRequest,
  ExecuteReviewMutationResult,
  FileChangeSummary,
  FileChangeWithContent,
  HunkDecision,
  ReviewDecisionSnapshot,
  ReviewMutationDiskPostimage,
  ReviewRedoAction,
  ReviewRenameRecoveryExpectation,
  ReviewUndoAction,
} from '@shared/types';

export interface ChangeReviewFileDecisionPersistenceScope {
  teamName: string;
  scopeKey: string;
  scopeToken: string;
}

export interface ChangeReviewFileDecisionStateSnapshot {
  fileContents: Record<string, FileChangeWithContent>;
  reviewExternalChangesByFile: Record<string, unknown>;
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  hunkContextHashesByFile: Record<string, Record<number, string>>;
  fileChunkCounts: Record<string, number>;
  decisionRevision: number;
  changeSetEpoch: number;
}

export interface ChangeReviewFileDecisionStatePort {
  getSnapshot: () => ChangeReviewFileDecisionStateSnapshot;
  acceptAllFile: (filePath: string) => boolean;
  rejectAllFile: (filePath: string) => void;
  applyRestoredDecisionState: (file: FileChangeSummary) => void;
  restoreFileDecisions: (file: FileChangeSummary, snapshot: ReviewDecisionSnapshot) => void;
  clearExternalChange: (filePath: string) => void;
  invalidateResolvedFileContent: (filePath: string) => void;
  reportError: (message: string | null) => void;
}

export interface ChangeReviewFileDecisionHistoryPort {
  pushUndoAction: (input: ReviewUndoActionInput) => ReviewUndoAction;
  bindCommittedAction: (
    optimistic: ReviewUndoAction,
    committed: ReviewUndoAction | undefined
  ) => boolean;
  discardLatestAction: (action: ReviewUndoAction) => boolean;
  getUndoHistory: () => ReviewUndoAction[];
  getRedoHistory: () => ReviewRedoAction[];
  publishUndoHistory: () => void;
}

export interface ChangeReviewFileDecisionCommandPort {
  checkConflict: (
    scope: ExecuteReviewMutationRequest['scope'],
    filePath: string,
    expectedContent: string
  ) => Promise<ConflictCheckResult>;
  executeMutation: (request: ExecuteReviewMutationRequest) => Promise<ExecuteReviewMutationResult>;
  applySingleFileDecision: (
    teamName: string,
    filePath: string,
    taskId?: string,
    memberName?: string
  ) => Promise<ApplyReviewResult | null>;
  quiescePersistence: (scope: ChangeReviewFileDecisionPersistenceScope) => Promise<boolean>;
  recordDecisionRevision: (
    scope: ChangeReviewFileDecisionPersistenceScope,
    revision: number
  ) => void;
  fetchFileContent: (teamName: string, memberName: string | undefined, filePath: string) => void;
  readCurrentDiskContent: (filePath: string, fallback: string) => Promise<string>;
}

export interface ChangeReviewFileDecisionEditorPort {
  getCurrentContent: (filePath: string) => string | null;
  scheduleEditorSync: (callback: () => void) => void;
  acceptAllEditorChunks: (filePath: string) => void;
  rejectAllEditorChunks: (filePath: string) => void;
  rollbackEditorContent: (filePath: string, content: string) => void;
}

export interface ChangeReviewFileDecisionStatusPort {
  beginFileMutation: (filePath: string) => void;
  finishFileMutation: (filePath: string) => void;
  incrementDiscardCounter: (filePath: string) => void;
}

export interface ChangeReviewFileDecisionWriteEvidencePort {
  markExpectedWrite: (filePath: string, expectedContent: string | null) => void;
  markCommittedPostimages: (postimages: readonly ReviewMutationDiskPostimage[] | undefined) => void;
}

export interface ChangeReviewFileDecisionPolicy {
  getHunkCount: (file: FileChangeSummary, state: ChangeReviewFileDecisionStateSnapshot) => number;
  getFileDecision: (
    file: FileChangeSummary,
    state: ChangeReviewFileDecisionStateSnapshot
  ) => HunkDecision | undefined;
  resolveModifiedContent: (
    file: FileChangeSummary,
    content: FileChangeWithContent | null
  ) => string | null;
  resolveFileIsNew: (file: FileChangeSummary, content: FileChangeWithContent | null) => boolean;
  isExpectedDeletion: (file: FileChangeSummary) => boolean;
  isAcceptDisabled: (
    file: FileChangeSummary,
    content: FileChangeWithContent,
    fileDecision: HunkDecision | undefined
  ) => boolean;
  isRejectable: (file: FileChangeSummary, content: FileChangeWithContent | null) => boolean;
  hasFileRejections: (
    file: FileChangeSummary,
    hunkCount: number,
    decisions: ReviewDecisionSnapshot
  ) => boolean;
  isFileFullyRejected: (
    file: FileChangeSummary,
    hunkCount: number,
    decisions: ReviewDecisionSnapshot
  ) => boolean;
  shouldDeleteWhenUndoingReject: (
    file: FileChangeSummary,
    hunkCount: number,
    decisions: ReviewDecisionSnapshot
  ) => boolean;
  hasUnresolvedExternalChange: (filePath: string, changes: Record<string, unknown>) => boolean;
  getRenameRecoveryExpectation: (file: FileChangeSummary) => ReviewRenameRecoveryExpectation | null;
}
