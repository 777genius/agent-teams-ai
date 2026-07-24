import type {
  ReviewDraftHistoryEntry,
  ReviewSerializedEditorState,
} from '@features/change-review-history/contracts';
import type {
  ExecuteReviewMutationResult,
  FileChangeSummary,
  HunkDecision,
  ReviewFileScope,
  ReviewPersistedStateSnapshot,
  ReviewRedoAction,
  ReviewUndoAction,
} from '@shared/types';

export interface ChangeReviewFileDraftPersistenceScope {
  teamName: string;
  scopeKey: string;
  scopeToken: string;
}

export interface ChangeReviewFileDraftStateSnapshot {
  activeFiles: readonly FileChangeSummary[];
  editedContents: Partial<Record<string, string>>;
  reviewExternalChangesByFile: Record<string, object>;
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  hunkContextHashesByFile: Record<string, Record<number, string>>;
  decisionRevision: number;
  changeSetEpoch: number;
}

export interface ChangeReviewFileDraftStatePort {
  getSnapshot: () => ChangeReviewFileDraftStateSnapshot;
  readExternalChange: (filePath: string) => object | undefined;
  updateEditedContent: (filePath: string, content: string) => void;
  discardFileEdits: (filePath: string) => void;
  clearExternalChange: (filePath: string, observedChange: object) => boolean;
  reloadFileFromDisk: (filePath: string) => void;
  applyReloadedReviewState: (state: ReviewPersistedStateSnapshot) => void;
  reportError: (message: string | null) => void;
}

export interface ChangeReviewFileDraftActionHistoryPort {
  clearForFile: (filePath: string) => void;
  getUndoHistory: () => ReviewUndoAction[];
  getRedoHistory: () => ReviewRedoAction[];
  replaceHistories: (undoHistory: ReviewUndoAction[], redoHistory: ReviewRedoAction[]) => void;
}

export interface ChangeReviewFileDraftHistoryPort {
  getEntry: (filePath: string) => ReviewDraftHistoryEntry | undefined;
  hasBaseline: (filePath: string) => boolean;
  getBaseline: (filePath: string) => string | null | undefined;
  setBaseline: (filePath: string, baseline: string | null) => void;
  deleteBaseline: (filePath: string) => void;
  unsuppressFile: (filePath: string) => void;
  publishCheckpoint: (
    filePath: string,
    editorState: ReviewSerializedEditorState,
    diskBaseline: string | null
  ) => void;
  flushWrites: () => Promise<boolean>;
  clearFile: (filePath: string) => Promise<void>;
}

export type ChangeReviewSaveEditedFileResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly error: string };

export interface CommitChangeReviewExternalReloadInput {
  reviewScope: ReviewFileScope;
  persistenceScope: ChangeReviewFileDraftPersistenceScope;
  filePath: string;
  persistedState: ReviewPersistedStateSnapshot;
  expectedDecisionRevision: number;
}

export interface ChangeReviewFileDraftCommandPort {
  saveEditedFile: (
    filePath: string,
    reviewScope: ReviewFileScope,
    expectedCurrentContent: string | null
  ) => Promise<ChangeReviewSaveEditedFileResult>;
  checkConflict: (
    reviewScope: ReviewFileScope,
    filePath: string,
    expectedContent: string
  ) => Promise<{
    hasConflict: boolean;
    conflictContent: string | null;
    currentContent: string;
  }>;
  commitExternalReload: (
    input: CommitChangeReviewExternalReloadInput
  ) => Promise<ExecuteReviewMutationResult>;
  quiescePersistence: (scope: ChangeReviewFileDraftPersistenceScope) => Promise<boolean>;
  recordDecisionRevision: (scope: ChangeReviewFileDraftPersistenceScope, revision: number) => void;
  fetchFileContent: (teamName: string, memberName: string | undefined, filePath: string) => void;
}

export interface ChangeReviewFileDraftStatusPort {
  beginFileMutation: (filePath: string) => void;
  finishFileMutation: (filePath: string) => void;
  incrementDiscardCounter: (filePath: string) => void;
}

export interface ChangeReviewFileDraftWriteEvidencePort {
  markExpectedWrite: (filePath: string, expectedContent: string | null) => void;
}
