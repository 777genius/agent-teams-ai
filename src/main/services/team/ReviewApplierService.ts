import { ReviewApplier } from '@agent-teams/task-change-ledger/review-apply';

import type {
  ReviewApplyMutationHooks,
  ReviewFileTransitionState,
  ReviewRenameTransitionState,
} from '@agent-teams/task-change-ledger/review-apply';
export type {
  ReviewApplyMutationHooks,
  ReviewFileTransitionState,
  ReviewRenameTransitionState,
} from '@agent-teams/task-change-ledger/review-apply';
import type {
  ApplyReviewDiskTransition,
  ApplyReviewRequest,
  ApplyReviewResult,
  ConflictCheckResult,
  FileChangeWithContent,
  RejectResult,
  ReviewMutationDiskPostimage,
  SnippetDiff,
} from '@shared/types';
export class ReviewApplierService {
  private readonly applier = new ReviewApplier();
  classifyEditedFileTransition(
    filePath: string,
    beforeContent: string | null,
    afterContent: string | null
  ): Promise<ReviewFileTransitionState> {
    return this.applier.classifyEditedFileTransition(filePath, beforeContent, afterContent);
  }
  classifyRejectedRenameTransition(
    filePath: string,
    original: string | null,
    modified: string | null,
    snippets: SnippetDiff[]
  ): Promise<ReviewRenameTransitionState> {
    return this.applier.classifyRejectedRenameTransition(filePath, original, modified, snippets);
  }
  restoreRejectedRename(
    filePath: string,
    original: string | null,
    modified: string | null,
    snippets: SnippetDiff[]
  ): Promise<{ success: true }> {
    return this.applier.restoreRejectedRename(filePath, original, modified, snippets);
  }
  reapplyRejectedRename(
    filePath: string,
    original: string | null,
    snippets: SnippetDiff[]
  ): Promise<{ success: true }> {
    return this.applier.reapplyRejectedRename(filePath, original, snippets);
  }
  getRejectedRenamePostimages(
    original: string | null,
    modified: string | null,
    snippets: SnippetDiff[],
    direction: 'restore' | 'reapply'
  ): Promise<ReviewMutationDiskPostimage[]> {
    return this.applier.getRejectedRenamePostimages(original, modified, snippets, direction);
  }
  checkConflict(filePath: string, expectedModified: string): Promise<ConflictCheckResult> {
    return this.applier.checkConflict(filePath, expectedModified);
  }
  rejectHunks(
    _teamName: string,
    filePath: string,
    original: string,
    modified: string,
    hunkIndices: number[],
    _snippets: SnippetDiff[],
    hunkContextHashes?: Record<number, string>
  ): Promise<RejectResult> {
    return this.applier.rejectHunks(
      _teamName,
      filePath,
      original,
      modified,
      hunkIndices,
      _snippets,
      hunkContextHashes
    );
  }
  rejectFile(
    _teamName: string,
    filePath: string,
    original: string,
    modified: string
  ): Promise<RejectResult> {
    return this.applier.rejectFile(_teamName, filePath, original, modified);
  }
  previewReject(
    _filePath: string,
    original: string,
    modified: string,
    hunkIndices: number[],
    snippets: SnippetDiff[]
  ): Promise<{ preview: string; hasConflicts: boolean }> {
    return this.applier.previewReject(_filePath, original, modified, hunkIndices, snippets);
  }
  applyReviewDecisions(
    request: ApplyReviewRequest,
    fileContents = new Map<string, FileChangeWithContent>(),
    hooks?: ReviewApplyMutationHooks
  ): Promise<ApplyReviewResult> {
    return this.applier.applyReviewDecisions(request, fileContents, hooks);
  }
  saveEditedFile(
    filePath: string,
    content: string,
    expectedCurrentContent: string | null
  ): Promise<{ success: boolean }> {
    return this.applier.saveEditedFile(filePath, content, expectedCurrentContent);
  }
  deleteEditedFile(
    filePath: string,
    expectedCurrentContent: string
  ): Promise<{ success: boolean }> {
    return this.applier.deleteEditedFile(filePath, expectedCurrentContent);
  }
  finalizeReviewDiskTransitions(transitions: readonly ApplyReviewDiskTransition[]): Promise<void> {
    return this.applier.finalizeReviewDiskTransitions(transitions);
  }
  finalizeEditedFileTransaction(
    filePath: string,
    expectedContent: string | null,
    nextContent: string | null
  ): Promise<void> {
    return this.applier.finalizeEditedFileTransaction(filePath, expectedContent, nextContent);
  }
  finalizeRejectedRenameTransaction(
    filePath: string,
    original: string | null,
    modified: string | null,
    snippets: SnippetDiff[],
    direction: 'restore' | 'reapply'
  ): Promise<void> {
    return this.applier.finalizeRejectedRenameTransaction(
      filePath,
      original,
      modified,
      snippets,
      direction
    );
  }
}
