import type {
  ApplyReviewResult,
  FileChangeSummary,
  HunkDecision,
  ReviewDecisionSnapshot,
  ReviewDiskUndoSnapshot,
  ReviewMutationDiskPostimage,
} from '@shared/types';

export interface ChangeReviewBulkDecisionStateSnapshot {
  editedContents: Record<string, string>;
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  changeSetEpoch: number;
}

export interface ChangeReviewBulkDecisionStatePort {
  getSnapshot: () => ChangeReviewBulkDecisionStateSnapshot;
  acceptAllFile: (filePath: string) => boolean;
  rejectAllFile: (filePath: string) => void;
  restoreDecisionSnapshot: (snapshot: ReviewDecisionSnapshot) => void;
  invalidateResolvedFileContent: (filePath: string) => void;
}

export interface ChangeReviewBulkDecisionCommandPort {
  applyReview: (
    teamName: string,
    taskId?: string,
    memberName?: string
  ) => Promise<ApplyReviewResult | null>;
  fetchFileContent: (teamName: string, memberName: string | undefined, filePath: string) => void;
  readCurrentDiskContent: (filePath: string, fallback: string) => Promise<string>;
}

export interface ChangeReviewBulkDecisionViewPort {
  scheduleEditorSync: (callback: () => void) => void;
  acceptAllEditorChunks: (filePaths: ReadonlySet<string>) => void;
  rejectAllEditorChunks: (filePaths: ReadonlySet<string>) => void;
  rollbackEditorContent: (filePath: string, content: string) => void;
  markExpectedWrite: (filePath: string, expectedContent: string | null) => void;
  markCommittedPostimages: (postimages: readonly ReviewMutationDiskPostimage[] | undefined) => void;
  beginFileMutation: (filePath: string) => void;
  finishFileMutation: (filePath: string) => void;
  markFilesApplying: (filePaths: ReadonlySet<string>) => void;
  clearFilesApplying: (filePaths: ReadonlySet<string>) => void;
  incrementDiscardCounter: (filePath: string) => void;
  setUndoInFlight: (value: boolean) => void;
}

export type BuildBulkRejectDiskSnapshot = (
  file: FileChangeSummary,
  decisionSnapshot: ReviewDecisionSnapshot
) => ReviewDiskUndoSnapshot | null;
