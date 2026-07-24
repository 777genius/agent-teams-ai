import type { ReviewUndoActionInput } from '../utils/changeReviewActionHistory';
import type { ReviewOperationScopeToken } from '../utils/reviewOperationGeneration';
import type {
  ApplyReviewResult,
  FileChangeSummary,
  FileChangeWithContent,
  HunkDecision,
  ReviewDecisionSnapshot,
  ReviewMutationDiskPostimage,
  ReviewRenameRecoveryExpectation,
  ReviewUndoAction,
} from '@shared/types';

export interface ChangeReviewHunkDecisionStateSnapshot extends ReviewDecisionSnapshot {
  fileChunkCounts: Record<string, number>;
  changeSetEpoch: number;
}

export interface ChangeReviewHunkDecisionStatePort {
  getSnapshot: () => ChangeReviewHunkDecisionStateSnapshot;
  setDecision: (filePath: string, hunkIndex: number, decision: HunkDecision) => number;
  clearDecision: (filePath: string, originalIndex: number) => void;
  invalidateResolvedFileContent: (filePath: string) => void;
}

export type ChangeReviewHunkDecisionApplyOutcome =
  | { status: 'applied'; result: ApplyReviewResult }
  | { status: 'failed'; result: ApplyReviewResult | null };

export interface ChangeReviewHunkDecisionCommandPort {
  applySingleFileDecision: (
    teamName: string,
    filePath: string,
    taskId: string | undefined,
    memberName: string | undefined
  ) => Promise<ChangeReviewHunkDecisionApplyOutcome>;
  fetchFileContent: (teamName: string, memberName: string | undefined, filePath: string) => void;
  readCurrentDiskContent: (filePath: string, fallback: string) => Promise<string>;
}

export interface ChangeReviewHunkDecisionEditorPort {
  guardIgnoredMutation: (filePath: string) => void;
  rejectChunk: (filePath: string) => { beforeContent: string; afterContent: string } | null;
  rollbackContent: (filePath: string, content: string) => void;
}

export interface ChangeReviewHunkDecisionStatusPort {
  beginFileMutation: (filePath: string) => void;
  finishFileMutation: (filePath: string) => void;
  incrementDiscardCounter: (filePath: string) => void;
}

export interface ChangeReviewHunkDecisionWriteEvidencePort {
  markExpectedWrite: (filePath: string, expectedContent: string | null) => void;
  clearExpectedWrite: (filePath: string) => void;
  markCommittedPostimages: (postimages: readonly ReviewMutationDiskPostimage[] | undefined) => void;
}

export interface ChangeReviewHunkDecisionHistoryPort {
  pushUndoAction: (input: ReviewUndoActionInput) => ReviewUndoAction;
  bindCommittedAction: (
    optimistic: ReviewUndoAction,
    committed: ReviewUndoAction | undefined
  ) => boolean;
  discardLatestAction: (action: ReviewUndoAction) => boolean;
  publishUndoHistory: () => void;
}

export interface ChangeReviewHunkDecisionPolicy {
  getHunkCount: (
    file: FileChangeSummary,
    snapshot: ChangeReviewHunkDecisionStateSnapshot
  ) => number;
  resolveFileIsNew: (
    file: FileChangeSummary,
    content: FileChangeWithContent | null | undefined
  ) => boolean;
  shouldDeleteWhenUndoingReject: (
    file: FileChangeSummary | undefined,
    hunkCount: number,
    decisions: ReviewDecisionSnapshot
  ) => boolean;
  shouldCreateWhenUndoingReject: (
    file: FileChangeSummary | undefined,
    isNewFile: boolean,
    hunkCount: number,
    decisions: ReviewDecisionSnapshot
  ) => boolean;
  getRenameRecoveryExpectation: (
    file: FileChangeSummary | undefined
  ) => ReviewRenameRecoveryExpectation | null;
}

export type CaptureChangeReviewHunkOperationScope = () => ReviewOperationScopeToken | null;
