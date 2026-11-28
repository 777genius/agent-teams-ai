import type { HunkDecision, ReviewRedoAction, ReviewUndoAction } from '../../contracts.js';
import {
  MAX_STORED_DECISION_ENTRIES,
  MAX_STORED_CONTEXT_FILES,
  MAX_STORED_KEY_LENGTH,
  MAX_STORED_REVIEW_ACTIONS,
  type DecisionContext,
} from './DecisionTypes.js';

export function createDecisionValidation(getContext: () => DecisionContext) {
  return {
    isReviewActionHistory(value: unknown): value is ReviewUndoAction[] {
      const ctx = getContext();
      if (!Array.isArray(value) || value.length > MAX_STORED_REVIEW_ACTIONS) return false;
      const ids = new Set<string>();
      let diskSnapshotCount = 0;
      return value.every((action) => {
        if (!action || typeof action !== 'object' || Array.isArray(action)) return false;
        const candidate = action as Partial<ReviewUndoAction>;
        if (
          typeof candidate.id !== 'string' ||
          candidate.id.length === 0 ||
          candidate.id.length > 256 ||
          ids.has(candidate.id) ||
          typeof candidate.createdAt !== 'string' ||
          candidate.createdAt.length === 0 ||
          candidate.createdAt.length > 128 ||
          (candidate.descriptor !== undefined &&
            !ctx.isReviewActionDescriptor(candidate.descriptor))
        ) {
          return false;
        }
        ids.add(candidate.id);
        if (candidate.kind === 'hunk') {
          return (
            ctx.isHunkUndoAction(candidate.action) &&
            ctx.isReviewActionDescriptorConsistent(candidate as ReviewUndoAction)
          );
        }
        if (candidate.kind === 'disk') {
          diskSnapshotCount++;
          return (
            diskSnapshotCount <= MAX_STORED_DECISION_ENTRIES &&
            ctx.isDiskUndoAction(candidate.action) &&
            ctx.isReviewActionDescriptorConsistent(candidate as ReviewUndoAction)
          );
        }
        if (candidate.kind === 'bulk') {
          if (!Array.isArray(candidate.diskSnapshots)) return false;
          diskSnapshotCount += candidate.diskSnapshots.length;
          return (
            diskSnapshotCount <= MAX_STORED_DECISION_ENTRIES &&
            ctx.isDecisionSnapshot(candidate.decisionSnapshot) &&
            candidate.diskSnapshots.every((snapshot) => ctx.isDiskUndoSnapshot(snapshot)) &&
            ctx.isReviewActionDescriptorConsistent(candidate as ReviewUndoAction)
          );
        }
        return false;
      });
    },
    isReviewActionDescriptor(value: unknown): boolean {
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
            hasSafeFilePath &&
            candidate.hunkIndex === undefined &&
            candidate.fileCount === undefined
          );
        case 'accept-all':
        case 'reject-all':
          return (
            candidate.filePath === undefined &&
            candidate.hunkIndex === undefined &&
            hasSafeFileCount
          );
        default:
          return false;
      }
    },
    isReviewActionDescriptorConsistent(action: ReviewUndoAction): boolean {
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
    },
    isReviewRedoHistory(value: unknown): value is ReviewRedoAction[] {
      const ctx = getContext();
      if (!Array.isArray(value) || value.length > MAX_STORED_REVIEW_ACTIONS) return false;
      const ids = new Set<string>();
      let diskSnapshotCount = 0;
      return value.every((entry) => {
        if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return false;
        const candidate = entry as Partial<ReviewRedoAction>;
        if (
          !candidate.action ||
          !ctx.isReviewActionHistory([candidate.action]) ||
          ids.has(candidate.action.id) ||
          !ctx.isDecisionSnapshot(candidate.decisionSnapshot) ||
          !ctx.isContextHashRecord(candidate.hunkContextHashesByFile)
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
    },
    hasDisjointReviewActionIds(
      undoHistory: readonly ReviewUndoAction[],
      redoHistory: readonly ReviewRedoAction[]
    ): boolean {
      const undoIds = new Set(undoHistory.map((action) => action.id));
      return redoHistory.every((entry) => !undoIds.has(entry.action.id));
    },
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
    },
    isDecisionSnapshot(value: unknown): boolean {
      const ctx = getContext();
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const candidate = value as { hunkDecisions?: unknown; fileDecisions?: unknown };
      return (
        ctx.isDecisionRecord(candidate.hunkDecisions) &&
        ctx.isDecisionRecord(candidate.fileDecisions)
      );
    },
    isHunkUndoAction(value: unknown): boolean {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const candidate = value as { filePath?: unknown; originalIndex?: unknown };
      return (
        typeof candidate.filePath === 'string' &&
        candidate.filePath.length > 0 &&
        candidate.filePath.length <= MAX_STORED_KEY_LENGTH &&
        Number.isSafeInteger(candidate.originalIndex) &&
        (candidate.originalIndex as number) >= 0
      );
    },
    isDiskUndoAction(value: unknown): boolean {
      const ctx = getContext();
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const candidate = value as {
        snapshot?: unknown;
        originalIndex?: unknown;
        file?: unknown;
        decisionSnapshot?: unknown;
      };
      return (
        ctx.isDiskUndoSnapshot(candidate.snapshot) &&
        (candidate.originalIndex === undefined ||
          (Number.isSafeInteger(candidate.originalIndex) &&
            (candidate.originalIndex as number) >= 0)) &&
        (candidate.file === undefined || ctx.isFileSummary(candidate.file)) &&
        (candidate.decisionSnapshot === undefined ||
          ctx.isDecisionSnapshot(candidate.decisionSnapshot))
      );
    },
    isDiskUndoSnapshot(value: unknown): boolean {
      const ctx = getContext();
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
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
        typeof candidate.beforeContent === 'string' &&
        (typeof candidate.afterContent === 'string' || candidate.afterContent === null) &&
        (candidate.authoritativeBeforeSha256 === undefined ||
          candidate.authoritativeBeforeSha256 === null ||
          (typeof candidate.authoritativeBeforeSha256 === 'string' &&
            /^[a-f0-9]{64}$/.test(candidate.authoritativeBeforeSha256))) &&
        (candidate.file === undefined || ctx.isFileSummary(candidate.file)) &&
        (candidate.fileIndex === undefined ||
          (Number.isSafeInteger(candidate.fileIndex) && (candidate.fileIndex as number) >= 0)) &&
        (candidate.restoreConflict === undefined ||
          (typeof candidate.restoreConflict === 'string' &&
            candidate.restoreConflict.length <= MAX_STORED_KEY_LENGTH)) &&
        (candidate.restoreMode === undefined ||
          restoreModes.has(candidate.restoreMode as string)) &&
        (candidate.renameExpectation === undefined ||
          (!!candidate.renameExpectation &&
            typeof candidate.renameExpectation === 'object' &&
            !Array.isArray(candidate.renameExpectation)))
      );
    },
    isFileSummary(value: unknown): boolean {
      if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
      const candidate = value as {
        filePath?: unknown;
        relativePath?: unknown;
        snippets?: unknown;
        linesAdded?: unknown;
        linesRemoved?: unknown;
        isNewFile?: unknown;
      };
      return (
        typeof candidate.filePath === 'string' &&
        candidate.filePath.length > 0 &&
        candidate.filePath.length <= MAX_STORED_KEY_LENGTH &&
        typeof candidate.relativePath === 'string' &&
        Array.isArray(candidate.snippets) &&
        Number.isFinite(candidate.linesAdded) &&
        Number.isFinite(candidate.linesRemoved) &&
        typeof candidate.isNewFile === 'boolean'
      );
    },
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
    },
    isContextHashRecord(
      value: unknown
    ): value is Record<string, Record<number, string>> | undefined {
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
    },
  };
}
