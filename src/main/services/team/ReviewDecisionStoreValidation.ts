import type { HunkDecision, ReviewRedoAction, ReviewUndoAction } from '@shared/types';

export const MAX_STORED_DECISION_ENTRIES = 200_000;
export const MAX_STORED_CONTEXT_FILES = 2_000;
export const MAX_STORED_KEY_LENGTH = 32_768;
export const MAX_STORED_REVIEW_ACTIONS = 100_000;

export type JsonRecord = Record<string, unknown>;

export function isJsonRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

export function hasOwnField(record: JsonRecord, field: string): boolean {
  return Object.prototype.hasOwnProperty.call(record, field);
}

export class ReviewDecisionStoreValidation {
  assertValidSnapshot(data: {
    hunkDecisions: Record<string, HunkDecision>;
    fileDecisions: Record<string, HunkDecision>;
    hunkContextHashesByFile?: Record<string, Record<number, string>>;
    reviewActionHistory?: ReviewUndoAction[];
    reviewRedoHistory?: ReviewRedoAction[];
  }): void {
    if (
      !this.isDecisionRecord(data.hunkDecisions) ||
      !this.isDecisionRecord(data.fileDecisions) ||
      !this.isContextHashRecord(data.hunkContextHashesByFile) ||
      !this.isReviewActionHistory(data.reviewActionHistory ?? []) ||
      !this.isReviewRedoHistory(data.reviewRedoHistory ?? []) ||
      !this.hasDisjointReviewActionIds(data.reviewActionHistory ?? [], data.reviewRedoHistory ?? [])
    ) {
      throw new Error('Invalid review decisions payload');
    }
  }

  isStoredReviewActionV6(value: unknown): boolean {
    if (!isJsonRecord(value)) return false;
    if (value.kind === 'hunk') {
      return (
        !hasOwnField(value, 'decisionSnapshot') &&
        !hasOwnField(value, 'diskSnapshots') &&
        isJsonRecord(value.action) &&
        !hasOwnField(value.action, 'snapshot') &&
        !hasOwnField(value.action, 'file') &&
        !hasOwnField(value.action, 'fileRef') &&
        !hasOwnField(value.action, 'decisionSnapshot')
      );
    }
    if (value.kind === 'disk') {
      if (
        hasOwnField(value, 'decisionSnapshot') ||
        hasOwnField(value, 'diskSnapshots') ||
        !isJsonRecord(value.action) ||
        hasOwnField(value.action, 'filePath') ||
        hasOwnField(value.action, 'file')
      ) {
        return false;
      }
      return (
        this.isStoredDiskUndoSnapshotV6(value.action.snapshot) &&
        (value.action.originalIndex === undefined ||
          (Number.isSafeInteger(value.action.originalIndex) &&
            Number(value.action.originalIndex) >= 0)) &&
        (value.action.fileRef === undefined || typeof value.action.fileRef === 'string') &&
        (value.action.decisionSnapshot === undefined ||
          this.isDecisionSnapshot(value.action.decisionSnapshot))
      );
    }
    if (value.kind === 'bulk') {
      return (
        !hasOwnField(value, 'action') &&
        this.isDecisionSnapshot(value.decisionSnapshot) &&
        Array.isArray(value.diskSnapshots) &&
        value.diskSnapshots.every((snapshot) => this.isStoredDiskUndoSnapshotV6(snapshot))
      );
    }
    return false;
  }

  isStoredDiskUndoSnapshotV6(value: unknown): boolean {
    if (
      !isJsonRecord(value) ||
      hasOwnField(value, 'beforeContent') ||
      hasOwnField(value, 'afterContent') ||
      hasOwnField(value, 'file')
    ) {
      return false;
    }
    return (
      typeof value.filePath === 'string' &&
      value.filePath.length > 0 &&
      value.filePath.length <= MAX_STORED_KEY_LENGTH &&
      !value.filePath.includes('\0') &&
      typeof value.beforeBlob === 'string' &&
      (typeof value.afterBlob === 'string' || value.afterBlob === null) &&
      (value.authoritativeBeforeSha256 === undefined ||
        value.authoritativeBeforeSha256 === null ||
        (typeof value.authoritativeBeforeSha256 === 'string' &&
          /^[a-f0-9]{64}$/.test(value.authoritativeBeforeSha256))) &&
      (value.fileRef === undefined || typeof value.fileRef === 'string') &&
      (value.fileIndex === undefined ||
        (Number.isSafeInteger(value.fileIndex) && Number(value.fileIndex) >= 0)) &&
      (value.restoreConflict === undefined ||
        (typeof value.restoreConflict === 'string' &&
          value.restoreConflict.length <= MAX_STORED_KEY_LENGTH)) &&
      (value.restoreMode === undefined ||
        value.restoreMode === 'content' ||
        value.restoreMode === 'create-file' ||
        value.restoreMode === 'delete-file' ||
        value.restoreMode === 'restore-rejected-rename' ||
        value.restoreMode === 'reapply-rejected-rename') &&
      (value.renameExpectation === undefined ||
        this.isReviewRenameExpectation(value.renameExpectation))
    );
  }

  isReviewActionHistory(value: unknown): value is ReviewUndoAction[] {
    if (!Array.isArray(value) || value.length > MAX_STORED_REVIEW_ACTIONS) return false;
    const ids = new Set<string>();
    let diskSnapshotCount = 0;
    return value.every((action) => {
      if (!isJsonRecord(action)) return false;
      const candidate = action as Partial<ReviewUndoAction>;
      if (
        typeof candidate.id !== 'string' ||
        candidate.id.length === 0 ||
        candidate.id.length > 256 ||
        ids.has(candidate.id) ||
        typeof candidate.createdAt !== 'string' ||
        candidate.createdAt.length === 0 ||
        candidate.createdAt.length > 128 ||
        (candidate.descriptor !== undefined && !this.isReviewActionDescriptor(candidate.descriptor))
      ) {
        return false;
      }
      ids.add(candidate.id);
      if (candidate.kind === 'hunk') {
        return (
          !hasOwnField(action, 'decisionSnapshot') &&
          !hasOwnField(action, 'diskSnapshots') &&
          this.isHunkUndoAction(candidate.action) &&
          this.isReviewActionDescriptorConsistent(candidate as ReviewUndoAction)
        );
      }
      if (candidate.kind === 'disk') {
        diskSnapshotCount++;
        return (
          !hasOwnField(action, 'decisionSnapshot') &&
          !hasOwnField(action, 'diskSnapshots') &&
          diskSnapshotCount <= MAX_STORED_DECISION_ENTRIES &&
          this.isDiskUndoAction(candidate.action) &&
          this.isReviewActionDescriptorConsistent(candidate as ReviewUndoAction)
        );
      }
      if (candidate.kind === 'bulk') {
        if (!Array.isArray(candidate.diskSnapshots)) return false;
        diskSnapshotCount += candidate.diskSnapshots.length;
        return (
          !hasOwnField(action, 'action') &&
          diskSnapshotCount <= MAX_STORED_DECISION_ENTRIES &&
          this.isDecisionSnapshot(candidate.decisionSnapshot) &&
          candidate.diskSnapshots.every((snapshot) => this.isDiskUndoSnapshot(snapshot)) &&
          this.isReviewActionDescriptorConsistent(candidate as ReviewUndoAction)
        );
      }
      return false;
    });
  }

  private isReviewActionDescriptor(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as {
      intent?: unknown;
      filePath?: unknown;
      hunkIndex?: unknown;
      fileCount?: unknown;
    };
    const hasSafeFilePath =
      typeof candidate.filePath === 'string' &&
      candidate.filePath.length > 0 &&
      candidate.filePath.length <= MAX_STORED_KEY_LENGTH &&
      !candidate.filePath.includes('\0');
    const hasSafeHunkIndex =
      Number.isSafeInteger(candidate.hunkIndex) && Number(candidate.hunkIndex) >= 0;
    const hasSafeFileCount =
      Number.isSafeInteger(candidate.fileCount) &&
      Number(candidate.fileCount) > 0 &&
      Number(candidate.fileCount) <= MAX_STORED_DECISION_ENTRIES;

    switch (candidate.intent) {
      case 'accept-hunk':
      case 'reject-hunk':
        return hasSafeFilePath && hasSafeHunkIndex && candidate.fileCount === undefined;
      case 'accept-file':
      case 'reject-file':
      case 'restore-file':
      case 'restore-rename':
        return (
          hasSafeFilePath && candidate.hunkIndex === undefined && candidate.fileCount === undefined
        );
      case 'accept-all':
      case 'reject-all':
        return (
          candidate.filePath === undefined && candidate.hunkIndex === undefined && hasSafeFileCount
        );
      default:
        return false;
    }
  }

  private isReviewActionDescriptorConsistent(action: ReviewUndoAction): boolean {
    const descriptor = action.descriptor;
    if (!descriptor) return true;
    if (action.kind === 'hunk') {
      return (
        (descriptor.intent === 'accept-hunk' || descriptor.intent === 'reject-hunk') &&
        descriptor.filePath === action.action.filePath &&
        descriptor.hunkIndex === action.action.originalIndex
      );
    }
    if (action.kind === 'disk') {
      const { snapshot, originalIndex } = action.action;
      if (originalIndex !== undefined) {
        return (
          descriptor.intent === 'reject-hunk' &&
          descriptor.filePath === snapshot.filePath &&
          descriptor.hunkIndex === originalIndex
        );
      }
      return (
        (descriptor.intent === 'reject-file' ||
          descriptor.intent === 'restore-file' ||
          descriptor.intent === 'restore-rename') &&
        descriptor.filePath === snapshot.filePath
      );
    }
    if (action.diskSnapshots.length > 0) {
      return (
        descriptor.intent === 'reject-all' && descriptor.fileCount === action.diskSnapshots.length
      );
    }
    return descriptor.intent === 'accept-all' || descriptor.intent === 'accept-file';
  }

  isReviewRedoHistory(value: unknown): value is ReviewRedoAction[] {
    if (!Array.isArray(value) || value.length > MAX_STORED_REVIEW_ACTIONS) return false;
    const ids = new Set<string>();
    let diskSnapshotCount = 0;
    return value.every((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
      const candidate = entry as Partial<ReviewRedoAction>;
      if (
        !candidate.action ||
        !this.isReviewActionHistory([candidate.action]) ||
        ids.has(candidate.action.id) ||
        !this.isDecisionSnapshot(candidate.decisionSnapshot) ||
        !this.isContextHashRecord(candidate.hunkContextHashesByFile)
      ) {
        return false;
      }
      diskSnapshotCount +=
        candidate.action.kind === 'bulk'
          ? candidate.action.diskSnapshots.length
          : candidate.action.kind === 'disk'
            ? 1
            : 0;
      if (diskSnapshotCount > MAX_STORED_DECISION_ENTRIES) return false;
      ids.add(candidate.action.id);
      return true;
    });
  }

  hasDisjointReviewActionIds(
    undoHistory: readonly ReviewUndoAction[],
    redoHistory: readonly ReviewRedoAction[]
  ): boolean {
    const undoIds = new Set(undoHistory.map((action) => action.id));
    return redoHistory.every((entry) => !undoIds.has(entry.action.id));
  }

  getDiskBackedHistory(snapshot: {
    reviewActionHistory: readonly ReviewUndoAction[];
    reviewRedoHistory: readonly ReviewRedoAction[];
  }): object[] {
    const hasDiskEffect = (action: ReviewUndoAction): boolean =>
      action.kind === 'disk' || (action.kind === 'bulk' && action.diskSnapshots.length > 0);
    return [
      ...snapshot.reviewActionHistory
        .filter(hasDiskEffect)
        .map((action) => ({ stack: 'undo', action })),
      ...snapshot.reviewRedoHistory
        .filter((entry) => hasDiskEffect(entry.action))
        .map((entry) => ({ stack: 'redo', entry })),
    ];
  }

  private isDecisionSnapshot(value: unknown): boolean {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as { hunkDecisions?: unknown; fileDecisions?: unknown };
    return (
      this.isDecisionRecord(candidate.hunkDecisions) &&
      this.isDecisionRecord(candidate.fileDecisions)
    );
  }

  private isHunkUndoAction(value: unknown): boolean {
    if (
      !isJsonRecord(value) ||
      hasOwnField(value, 'snapshot') ||
      hasOwnField(value, 'file') ||
      hasOwnField(value, 'fileRef') ||
      hasOwnField(value, 'decisionSnapshot')
    ) {
      return false;
    }
    const candidate = value as { filePath?: unknown; originalIndex?: unknown };
    return (
      typeof candidate.filePath === 'string' &&
      candidate.filePath.length > 0 &&
      candidate.filePath.length <= MAX_STORED_KEY_LENGTH &&
      !candidate.filePath.includes('\0') &&
      Number.isSafeInteger(candidate.originalIndex) &&
      (candidate.originalIndex as number) >= 0
    );
  }

  private isDiskUndoAction(value: unknown): boolean {
    if (!isJsonRecord(value) || hasOwnField(value, 'filePath') || hasOwnField(value, 'fileRef')) {
      return false;
    }
    const candidate = value as {
      snapshot?: unknown;
      originalIndex?: unknown;
      file?: unknown;
      decisionSnapshot?: unknown;
    };
    return (
      this.isDiskUndoSnapshot(candidate.snapshot) &&
      (candidate.originalIndex === undefined ||
        (Number.isSafeInteger(candidate.originalIndex) &&
          (candidate.originalIndex as number) >= 0)) &&
      (candidate.file === undefined || this.isFileSummary(candidate.file)) &&
      (candidate.decisionSnapshot === undefined ||
        this.isDecisionSnapshot(candidate.decisionSnapshot))
    );
  }

  private isDiskUndoSnapshot(value: unknown): boolean {
    if (
      !isJsonRecord(value) ||
      hasOwnField(value, 'beforeBlob') ||
      hasOwnField(value, 'afterBlob') ||
      hasOwnField(value, 'fileRef')
    ) {
      return false;
    }
    const candidate = value as {
      filePath?: unknown;
      beforeContent?: unknown;
      afterContent?: unknown;
      authoritativeBeforeSha256?: unknown;
      file?: unknown;
      fileIndex?: unknown;
      restoreConflict?: unknown;
      restoreMode?: unknown;
      renameExpectation?: unknown;
    };
    const restoreModes = new Set([
      'content',
      'create-file',
      'delete-file',
      'restore-rejected-rename',
      'reapply-rejected-rename',
    ]);
    return (
      typeof candidate.filePath === 'string' &&
      candidate.filePath.length > 0 &&
      candidate.filePath.length <= MAX_STORED_KEY_LENGTH &&
      !candidate.filePath.includes('\0') &&
      typeof candidate.beforeContent === 'string' &&
      (typeof candidate.afterContent === 'string' || candidate.afterContent === null) &&
      (candidate.authoritativeBeforeSha256 === undefined ||
        candidate.authoritativeBeforeSha256 === null ||
        (typeof candidate.authoritativeBeforeSha256 === 'string' &&
          /^[a-f0-9]{64}$/.test(candidate.authoritativeBeforeSha256))) &&
      (candidate.file === undefined || this.isFileSummary(candidate.file)) &&
      (candidate.fileIndex === undefined ||
        (Number.isSafeInteger(candidate.fileIndex) && (candidate.fileIndex as number) >= 0)) &&
      (candidate.restoreConflict === undefined ||
        (typeof candidate.restoreConflict === 'string' &&
          candidate.restoreConflict.length <= MAX_STORED_KEY_LENGTH)) &&
      (candidate.restoreMode === undefined || restoreModes.has(candidate.restoreMode as string)) &&
      (candidate.renameExpectation === undefined ||
        this.isReviewRenameExpectation(candidate.renameExpectation))
    );
  }

  private isReviewRenameExpectation(value: unknown): boolean {
    if (!isJsonRecord(value)) return false;
    const isHash = (hash: unknown): boolean =>
      hash === null || (typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash));
    return (
      typeof value.eventId === 'string' &&
      value.eventId.length > 0 &&
      value.eventId.length <= MAX_STORED_KEY_LENGTH &&
      isHash(value.beforeHash) &&
      isHash(value.afterHash) &&
      isJsonRecord(value.relation) &&
      (value.relation.kind === 'rename' || value.relation.kind === 'copy') &&
      typeof value.relation.oldPath === 'string' &&
      value.relation.oldPath.length > 0 &&
      value.relation.oldPath.length <= MAX_STORED_KEY_LENGTH &&
      typeof value.relation.newPath === 'string' &&
      value.relation.newPath.length > 0 &&
      value.relation.newPath.length <= MAX_STORED_KEY_LENGTH
    );
  }

  isFileSummary(value: unknown): boolean {
    if (!isJsonRecord(value)) return false;
    const candidate = value as {
      filePath?: unknown;
      relativePath?: unknown;
      snippets?: unknown;
      linesAdded?: unknown;
      linesRemoved?: unknown;
      isNewFile?: unknown;
      changeKey?: unknown;
      diffStatKnown?: unknown;
      ledgerSummary?: unknown;
      timeline?: unknown;
    };
    return (
      typeof candidate.filePath === 'string' &&
      candidate.filePath.length > 0 &&
      candidate.filePath.length <= MAX_STORED_KEY_LENGTH &&
      typeof candidate.relativePath === 'string' &&
      Array.isArray(candidate.snippets) &&
      candidate.snippets.length <= MAX_STORED_DECISION_ENTRIES &&
      candidate.snippets.every((snippet) => this.isSnippetDiff(snippet)) &&
      Number.isFinite(candidate.linesAdded) &&
      Number.isFinite(candidate.linesRemoved) &&
      typeof candidate.isNewFile === 'boolean' &&
      (candidate.changeKey === undefined || typeof candidate.changeKey === 'string') &&
      (candidate.diffStatKnown === undefined || typeof candidate.diffStatKnown === 'boolean') &&
      (candidate.ledgerSummary === undefined ||
        this.isFileSummaryLedger(candidate.ledgerSummary)) &&
      (candidate.timeline === undefined || this.isFileEditTimeline(candidate.timeline))
    );
  }

  private isSnippetDiff(value: unknown): boolean {
    if (!isJsonRecord(value)) return false;
    return (
      typeof value.toolUseId === 'string' &&
      typeof value.filePath === 'string' &&
      (value.toolName === 'Edit' ||
        value.toolName === 'Write' ||
        value.toolName === 'MultiEdit' ||
        value.toolName === 'NotebookEdit' ||
        value.toolName === 'Bash' ||
        value.toolName === 'PowerShell' ||
        value.toolName === 'PostToolUse') &&
      (value.type === 'edit' ||
        value.type === 'write-new' ||
        value.type === 'write-update' ||
        value.type === 'multi-edit' ||
        value.type === 'notebook-edit' ||
        value.type === 'shell-snapshot' ||
        value.type === 'hook-snapshot') &&
      typeof value.oldString === 'string' &&
      typeof value.newString === 'string' &&
      typeof value.replaceAll === 'boolean' &&
      typeof value.timestamp === 'string' &&
      typeof value.isError === 'boolean' &&
      (value.contextHash === undefined || typeof value.contextHash === 'string') &&
      (value.ledger === undefined || this.isSnippetLedger(value.ledger))
    );
  }

  private isSnippetLedger(value: unknown): boolean {
    if (!isJsonRecord(value)) return false;
    return (
      typeof value.eventId === 'string' &&
      (value.source === 'ledger-exact' || value.source === 'ledger-snapshot') &&
      (value.confidence === 'exact' ||
        value.confidence === 'high' ||
        value.confidence === 'medium' ||
        value.confidence === 'low' ||
        value.confidence === 'ambiguous') &&
      (value.originalFullContent === null || typeof value.originalFullContent === 'string') &&
      (value.modifiedFullContent === null || typeof value.modifiedFullContent === 'string') &&
      (value.beforeHash === null || typeof value.beforeHash === 'string') &&
      (value.afterHash === null || typeof value.afterHash === 'string') &&
      (value.operation === undefined ||
        value.operation === 'create' ||
        value.operation === 'modify' ||
        value.operation === 'delete') &&
      (value.beforeState === undefined || this.isLedgerContentState(value.beforeState)) &&
      (value.afterState === undefined || this.isLedgerContentState(value.afterState)) &&
      (value.relation === undefined || this.isLedgerChangeRelation(value.relation)) &&
      (value.executionSeq === undefined || Number.isFinite(value.executionSeq)) &&
      (value.linesAdded === undefined || Number.isFinite(value.linesAdded)) &&
      (value.linesRemoved === undefined || Number.isFinite(value.linesRemoved)) &&
      (value.textAvailability === undefined ||
        value.textAvailability === 'patch-text' ||
        value.textAvailability === 'full-text' ||
        value.textAvailability === 'unavailable') &&
      (value.worktreePath === undefined || typeof value.worktreePath === 'string') &&
      (value.worktreeBranch === undefined || typeof value.worktreeBranch === 'string') &&
      (value.baseWorkspaceRoot === undefined || typeof value.baseWorkspaceRoot === 'string') &&
      (value.dirtyLeaderWarning === undefined || typeof value.dirtyLeaderWarning === 'string')
    );
  }

  private isLedgerContentState(value: unknown): boolean {
    if (!isJsonRecord(value)) return false;
    return (
      (value.exists === undefined || typeof value.exists === 'boolean') &&
      (value.sha256 === undefined || typeof value.sha256 === 'string') &&
      (value.sizeBytes === undefined || Number.isFinite(value.sizeBytes)) &&
      (value.contentKind === undefined ||
        value.contentKind === 'text' ||
        value.contentKind === 'binary' ||
        value.contentKind === 'unknown') &&
      (value.blobRef === undefined || typeof value.blobRef === 'string') &&
      (value.unavailableCode === undefined ||
        value.unavailableCode === 'binary' ||
        value.unavailableCode === 'too-large' ||
        value.unavailableCode === 'read-error' ||
        value.unavailableCode === 'not-captured' ||
        value.unavailableCode === 'blob-missing') &&
      (value.unavailableReason === undefined || typeof value.unavailableReason === 'string')
    );
  }

  private isLedgerChangeRelation(value: unknown): boolean {
    return (
      isJsonRecord(value) &&
      (value.kind === 'rename' || value.kind === 'copy') &&
      typeof value.oldPath === 'string' &&
      typeof value.newPath === 'string'
    );
  }

  private isFileSummaryLedger(value: unknown): boolean {
    if (!isJsonRecord(value)) return false;
    return (
      (value.latestOperation === undefined ||
        value.latestOperation === 'create' ||
        value.latestOperation === 'modify' ||
        value.latestOperation === 'delete') &&
      (value.createdInTask === undefined || typeof value.createdInTask === 'boolean') &&
      (value.deletedInTask === undefined || typeof value.deletedInTask === 'boolean') &&
      (value.contentAvailability === undefined ||
        value.contentAvailability === 'full-text' ||
        value.contentAvailability === 'hash-only' ||
        value.contentAvailability === 'metadata-only') &&
      (value.reviewability === undefined ||
        value.reviewability === 'full-text' ||
        value.reviewability === 'partial-text' ||
        value.reviewability === 'metadata-only') &&
      (value.relation === undefined || this.isLedgerChangeRelation(value.relation)) &&
      (value.beforeState === undefined || this.isLedgerContentState(value.beforeState)) &&
      (value.afterState === undefined || this.isLedgerContentState(value.afterState)) &&
      (value.primaryActorKey === undefined || typeof value.primaryActorKey === 'string') &&
      this.isOptionalStringArray(value.agentIds) &&
      this.isOptionalStringArray(value.memberNames) &&
      (value.executionSeqRange === undefined ||
        this.isExecutionSeqRange(value.executionSeqRange)) &&
      (value.worktreePath === undefined || typeof value.worktreePath === 'string') &&
      (value.worktreeBranch === undefined || typeof value.worktreeBranch === 'string') &&
      (value.baseWorkspaceRoot === undefined || typeof value.baseWorkspaceRoot === 'string') &&
      (value.dirtyLeaderWarning === undefined || typeof value.dirtyLeaderWarning === 'string')
    );
  }

  private isOptionalStringArray(value: unknown): boolean {
    return (
      value === undefined ||
      (Array.isArray(value) &&
        value.length <= MAX_STORED_DECISION_ENTRIES &&
        value.every((entry) => typeof entry === 'string'))
    );
  }

  private isExecutionSeqRange(value: unknown): boolean {
    return isJsonRecord(value) && Number.isFinite(value.start) && Number.isFinite(value.end);
  }

  private isFileEditTimeline(value: unknown): boolean {
    return (
      isJsonRecord(value) &&
      typeof value.filePath === 'string' &&
      Array.isArray(value.events) &&
      value.events.length <= MAX_STORED_DECISION_ENTRIES &&
      value.events.every((event) => this.isFileEditEvent(event)) &&
      Number.isFinite(value.durationMs)
    );
  }

  private isFileEditEvent(value: unknown): boolean {
    if (!isJsonRecord(value)) return false;
    return (
      typeof value.toolUseId === 'string' &&
      (value.toolName === 'Edit' ||
        value.toolName === 'Write' ||
        value.toolName === 'MultiEdit' ||
        value.toolName === 'NotebookEdit' ||
        value.toolName === 'Bash' ||
        value.toolName === 'PowerShell' ||
        value.toolName === 'PostToolUse') &&
      typeof value.timestamp === 'string' &&
      typeof value.summary === 'string' &&
      Number.isFinite(value.linesAdded) &&
      Number.isFinite(value.linesRemoved) &&
      Number.isFinite(value.snippetIndex)
    );
  }

  isDecisionRecord(value: unknown): value is Record<string, HunkDecision> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const entries = Object.entries(value);
    return (
      entries.length <= MAX_STORED_DECISION_ENTRIES &&
      entries.every(
        ([key, decision]) =>
          key.length > 0 &&
          key.length <= MAX_STORED_KEY_LENGTH &&
          (decision === 'accepted' || decision === 'rejected' || decision === 'pending')
      )
    );
  }

  isContextHashRecord(value: unknown): value is Record<string, Record<number, string>> | undefined {
    if (value === undefined) return true;
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const files = Object.entries(value as Record<string, unknown>);
    if (files.length > MAX_STORED_CONTEXT_FILES) return false;
    let totalHashes = 0;
    for (const [filePath, hashes] of files) {
      if (
        filePath.length === 0 ||
        filePath.length > MAX_STORED_KEY_LENGTH ||
        !hashes ||
        typeof hashes !== 'object' ||
        Array.isArray(hashes)
      ) {
        return false;
      }
      const entries = Object.entries(hashes);
      totalHashes += entries.length;
      if (totalHashes > MAX_STORED_DECISION_ENTRIES) return false;
      if (
        entries.some(
          ([index, hash]) =>
            !/^(0|[1-9]\d*)$/.test(index) || typeof hash !== 'string' || hash.length > 256
        )
      ) {
        return false;
      }
    }
    return true;
  }
}
