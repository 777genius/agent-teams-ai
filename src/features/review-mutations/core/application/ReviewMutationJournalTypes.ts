import type { ReviewMutationKind, ReviewMutationPhase } from '../../contracts';
import type { ReviewMutationJournalPathTransition } from '../domain/reviewDecisionBatch';

export type { ReviewMutationJournalPathTransition } from '../domain/reviewDecisionBatch';

export type ReviewMutationDecision = 'accepted' | 'rejected' | 'pending';

export interface ReviewMutationFileDecision {
  filePath: string;
  reviewKey?: string;
  fileDecision: ReviewMutationDecision;
  hunkDecisions: Record<number, ReviewMutationDecision>;
  contentSnapshotToken?: string;
  hunkContextHashes?: Record<number, string>;
}

export interface ReviewMutationPersistenceScope {
  scopeKey: string;
  scopeToken: string;
}

export interface ReviewMutationReviewScope {
  teamName: string;
  taskId?: string;
  memberName?: string;
}

export interface ReviewMutationDecisionSnapshot {
  hunkDecisions: Record<string, ReviewMutationDecision>;
  fileDecisions: Record<string, ReviewMutationDecision>;
}

export type ReviewMutationActionDescriptor =
  | {
      intent: 'accept-hunk' | 'reject-hunk';
      filePath: string;
      hunkIndex: number;
    }
  | {
      intent: 'accept-file' | 'reject-file' | 'restore-file' | 'restore-rename';
      filePath: string;
    }
  | { intent: 'accept-all' | 'reject-all'; fileCount: number };

interface ReviewMutationUndoActionBase {
  id: string;
  createdAt: string;
  descriptor?: ReviewMutationActionDescriptor;
}

export type ReviewMutationUndoAction =
  | (ReviewMutationUndoActionBase & {
      kind: 'bulk';
      decisionSnapshot: ReviewMutationDecisionSnapshot;
      diskSnapshots: {
        filePath: string;
        beforeContent: string;
        afterContent: string | null;
      }[];
    })
  | (ReviewMutationUndoActionBase & {
      kind: 'disk';
      action: {
        snapshot: {
          filePath: string;
          beforeContent: string;
          afterContent: string | null;
        };
        originalIndex?: number;
        decisionSnapshot?: ReviewMutationDecisionSnapshot;
      };
    })
  | (ReviewMutationUndoActionBase & {
      kind: 'hunk';
      action: { filePath: string; originalIndex: number };
    });

export interface ReviewMutationRedoAction {
  action: ReviewMutationUndoAction;
  decisionSnapshot: ReviewMutationDecisionSnapshot;
  hunkContextHashesByFile?: Record<string, Record<number, string>>;
}

export interface ReviewMutationPersistedStateSnapshot extends ReviewMutationDecisionSnapshot {
  hunkContextHashesByFile?: Record<string, Record<number, string>>;
  reviewActionHistory: ReviewMutationUndoAction[];
  reviewRedoHistory: ReviewMutationRedoAction[];
}

export interface ReviewMutationFileSnippet {
  toolUseId: string;
  filePath: string;
  toolName: 'Edit' | 'Write' | 'MultiEdit' | 'NotebookEdit' | 'Bash' | 'PowerShell' | 'PostToolUse';
  type:
    | 'edit'
    | 'write-new'
    | 'write-update'
    | 'multi-edit'
    | 'notebook-edit'
    | 'shell-snapshot'
    | 'hook-snapshot';
  oldString: string;
  newString: string;
  replaceAll: boolean;
  timestamp: string;
  isError: boolean;
  contextHash?: string;
  ledger?: {
    eventId: string;
    source: 'ledger-exact' | 'ledger-snapshot';
    confidence: 'exact' | 'high' | 'medium' | 'low' | 'ambiguous';
    originalFullContent: string | null;
    modifiedFullContent: string | null;
    beforeHash: string | null;
    afterHash: string | null;
    operation?: 'create' | 'modify' | 'delete';
    beforeState?: {
      exists?: boolean;
      sha256?: string;
      sizeBytes?: number;
      contentKind?: 'text' | 'binary' | 'unknown';
      blobRef?: string;
      unavailableCode?: 'binary' | 'too-large' | 'read-error' | 'not-captured' | 'blob-missing';
      unavailableReason?: string;
    };
    afterState?: {
      exists?: boolean;
      sha256?: string;
      sizeBytes?: number;
      contentKind?: 'text' | 'binary' | 'unknown';
      blobRef?: string;
      unavailableCode?: 'binary' | 'too-large' | 'read-error' | 'not-captured' | 'blob-missing';
      unavailableReason?: string;
    };
    relation?: {
      kind: 'rename' | 'copy';
      oldPath: string;
      newPath: string;
    };
    executionSeq?: number;
    linesAdded?: number;
    linesRemoved?: number;
    textAvailability?: 'patch-text' | 'full-text' | 'unavailable';
    worktreePath?: string;
    worktreeBranch?: string;
    baseWorkspaceRoot?: string;
    dirtyLeaderWarning?: string;
  };
}

export interface ReviewMutationFileContent {
  filePath: string;
  relativePath: string;
  snippets: ReviewMutationFileSnippet[];
  linesAdded: number;
  linesRemoved: number;
  isNewFile: boolean;
  changeKey?: string;
  diffStatKnown?: boolean;
  reviewSnapshotToken?: string;
  originalFullContent: string | null;
  modifiedFullContent: string | null;
  contentSource:
    | 'ledger-exact'
    | 'ledger-snapshot'
    | 'file-history'
    | 'snippet-reconstruction'
    | 'disk-current'
    | 'git-fallback'
    | 'unavailable';
}

export interface ReviewMutationRenameRecoveryExpectation {
  eventId: string;
  beforeHash: string | null;
  afterHash: string | null;
  relation: {
    kind: 'rename' | 'copy';
    oldPath: string;
    newPath: string;
  };
}

export type ReviewMutationDirectDiskStep =
  | {
      id: string;
      type: 'write';
      filePath: string;
      expectedContent: string | null;
      content: string;
    }
  | {
      id: string;
      type: 'delete';
      filePath: string;
      expectedContent: string;
    }
  | {
      id: string;
      type: 'restore-rejected-rename' | 'reapply-rejected-rename';
      filePath: string;
      expectation: ReviewMutationRenameRecoveryExpectation;
    };

export interface ReviewMutationJournalRecord {
  version: 2;
  id: string;
  phase: ReviewMutationPhase;
  kind: ReviewMutationKind;
  teamName: string;
  persistenceScope: ReviewMutationPersistenceScope;
  reviewScope: ReviewMutationReviewScope;
  decisions: (ReviewMutationFileDecision & { reviewKey: string })[];
  fileContents: ReviewMutationFileContent[];
  decisionStatuses?: ('pending' | 'applied')[];
  decisionPostimages?: (ReviewMutationJournalPathPostimage[] | null)[];
  decisionTransitions?: (ReviewMutationJournalPathTransition[] | null)[];
  diskSteps?: ReviewMutationJournalDiskStep[];
  persistedState?: ReviewMutationPersistedStateSnapshot;
  expectedDecisionRevision?: number;
  createdAt: string;
  updatedAt: string;
  blocked?: boolean;
  failure?: string;
}

export interface PrepareReviewMutationInput {
  teamName: string;
  persistenceScope: ReviewMutationPersistenceScope;
  reviewScope: ReviewMutationReviewScope;
  kind: ReviewMutationKind;
  decisions: (ReviewMutationFileDecision & { reviewKey: string })[];
  fileContents: ReviewMutationFileContent[];
  diskSteps?: ReviewMutationJournalDiskStep[];
  persistedState?: ReviewMutationPersistedStateSnapshot;
  expectedDecisionRevision?: number;
}

export type ReviewMutationJournalDiskStep = ReviewMutationDirectDiskStep & {
  status: 'pending' | 'applied';
  /** Main-resolved immutable rename evidence needed after the renderer is gone. */
  authoritativeContent?: ReviewMutationFileContent;
};

export interface ReviewMutationJournalPathPostimage {
  filePath: string;
  /** Null means the path must be absent. Existing text is stored by digest only. */
  sha256: string | null;
}
