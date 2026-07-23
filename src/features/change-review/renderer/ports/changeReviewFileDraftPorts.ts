import type {
  ExecuteReviewMutationResult,
  FileChangeSummary,
  HunkDecision,
  ReviewFileScope,
  ReviewPersistedStateSnapshot,
} from '@shared/types';

export interface ChangeReviewFileDraftPersistenceScope {
  teamName: string;
  scopeKey: string;
  scopeToken: string;
}

export interface ChangeReviewFileDraftStateSnapshot {
  activeFiles: readonly FileChangeSummary[];
  editedContents: Partial<Record<string, string>>;
  reviewExternalChangesByFile: Record<string, unknown>;
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  hunkContextHashesByFile: Record<string, Record<number, string>>;
  decisionRevision: number;
  changeSetEpoch: number;
  applyError: string | null;
}

export interface ChangeReviewFileDraftStatePort {
  getSnapshot: () => ChangeReviewFileDraftStateSnapshot;
  updateEditedContent: (filePath: string, content: string) => void;
  discardFileEdits: (filePath: string) => void;
  clearExternalChange: (filePath: string) => void;
  reloadFileFromDisk: (filePath: string) => void;
  applyReloadedReviewState: (state: ReviewPersistedStateSnapshot) => void;
  reportError: (message: string | null) => void;
}

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
  ) => Promise<void>;
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
