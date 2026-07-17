import {
  atomicCreateAsync,
  atomicWriteAsync,
  renamePathWithRetry,
  unlinkPathDurably,
} from '@main/utils/atomicWrite';
import { isWindowsishPath, normalizePathForComparison } from '@shared/utils/platformPath';
import { buildReviewChunkContextHashes, rejectReviewChunks } from '@shared/utils/reviewChunks';
import { threeWayTextMerge } from '@shared/utils/threeWayTextMerge';
import { createHash } from 'crypto';
import { lstat, mkdir, readFile } from 'fs/promises';
import { dirname } from 'path';

import type {
  ApplyReviewRequest,
  ApplyReviewResult,
  ConflictCheckResult,
  FileChangeWithContent,
  LedgerChangeRelation,
  RejectResult,
  SnippetDiff,
} from '@shared/types';

type ApplyErrorCode = NonNullable<ApplyReviewResult['errors'][number]['code']>;
type LedgerApplyOutcome =
  | { handled: false }
  | { handled: true; status: 'applied' | 'skipped' }
  | { handled: true; status: 'conflict' | 'error'; error: string; code: ApplyErrorCode };

type CurrentTextReadResult =
  | { missing: true; content: '' }
  | { missing: false; content: string }
  | { missing: false; content: ''; error: string };

export type ReviewFileTransitionState = 'before' | 'after' | 'both';
export type ReviewRenameTransitionState =
  | 'accepted'
  | 'rejected'
  | 'both'
  | 'restoring'
  | 'reapplying'
  | 'legacy-reapplying';

function getCurrentTextReadError(result: CurrentTextReadResult): string | null {
  return 'error' in result ? result.error : null;
}

const fileMutationQueues = new Map<string, Promise<void>>();

async function withFileMutationLock<T>(filePath: string, operation: () => Promise<T>): Promise<T> {
  return withFileMutationLocks([filePath], operation);
}

async function withFileMutationLocks<T>(
  filePaths: readonly string[],
  operation: () => Promise<T>
): Promise<T> {
  const keys = [
    ...new Set(
      filePaths.map((filePath) => {
        const normalized = normalizePathForComparison(filePath).normalize('NFC');
        return process.platform === 'darwin' || process.platform === 'win32'
          ? normalized.toLowerCase()
          : normalized;
      })
    ),
  ].sort();

  const acquire = (index: number): Promise<T> => {
    const key = keys[index];
    return key ? withFileMutationKeyLock(key, () => acquire(index + 1)) : operation();
  };

  return acquire(0);
}

async function withFileMutationKeyLock<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const previous = fileMutationQueues.get(key) ?? Promise.resolve();
  let release = (): void => undefined;
  const current = new Promise<void>((resolve) => {
    release = resolve;
  });
  const queueTail = previous.then(
    () => current,
    () => current
  );
  fileMutationQueues.set(key, queueTail);

  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    release();
    if (fileMutationQueues.get(key) === queueTail) {
      fileMutationQueues.delete(key);
    }
  }
}

/**
 * Service for applying reject decisions from code review.
 *
 * Supports:
 * - Conflict detection (file changed since review was computed)
 * - Hunk-level rejection (reverse specific hunks)
 * - File-level rejection (restore entire file to original)
 * - Preview mode (show what would change without writing)
 * - Batch review application
 */
export class ReviewApplierService {
  /**
   * Read-only CAS classification used before a durable direct mutation and while
   * recovering it. Existing paths must still be safe regular single-link files.
   */
  async classifyEditedFileTransition(
    filePath: string,
    beforeContent: string | null,
    afterContent: string | null
  ): Promise<ReviewFileTransitionState> {
    return withFileMutationLock(filePath, async () => {
      const current = await this.readCurrentText(filePath);
      const currentError = getCurrentTextReadError(current);
      if (currentError) throw new Error(currentError);
      if (!current.missing) {
        await this.assertSafeExpectedFile(filePath, current.content);
      }

      const beforeMatches =
        beforeContent === null
          ? current.missing
          : !current.missing && current.content === beforeContent;
      const afterMatches =
        afterContent === null
          ? current.missing
          : !current.missing && current.content === afterContent;
      if (beforeMatches && afterMatches) return 'both';
      if (beforeMatches) return 'before';
      if (afterMatches) return 'after';
      throw new Error('File changed since review update; durable mutation state is ambiguous');
    });
  }

  /**
   * Classify both sides of a ledger rename without mutating either path. The
   * intermediate states are exact crash states understood by the idempotent
   * rename recovery methods below.
   */
  async classifyRejectedRenameTransition(
    filePath: string,
    original: string | null,
    modified: string | null,
    snippets: SnippetDiff[]
  ): Promise<ReviewRenameTransitionState> {
    const ledgerSnippets = snippets.filter((snippet) => snippet.ledger && !snippet.isError);
    const relation = this.resolveLedgerRelation(ledgerSnippets);
    if (relation?.kind !== 'rename') {
      throw new Error('Review file is not a ledger rename.');
    }
    const oldSnippet =
      ledgerSnippets.find(
        (snippet) =>
          snippet.ledger?.operation === 'delete' &&
          this.pathMatchesRelationPath(snippet.filePath, relation.oldPath)
      ) ?? ledgerSnippets.find((snippet) => snippet.ledger?.operation === 'delete');
    const newSnippet =
      ledgerSnippets.find(
        (snippet) =>
          snippet.ledger?.operation === 'create' &&
          this.pathMatchesRelationPath(snippet.filePath, relation.newPath)
      ) ?? ledgerSnippets.find((snippet) => snippet.ledger?.operation === 'create');
    const oldFilePath =
      oldSnippet?.filePath ??
      this.resolveRelatedLedgerPath(newSnippet?.filePath, relation.newPath, relation.oldPath);
    const newFilePath = newSnippet?.filePath;
    const oldContent = oldSnippet?.ledger?.originalFullContent ?? original;
    const newContent = newSnippet?.ledger?.modifiedFullContent ?? modified;
    if (!oldFilePath || !newFilePath || oldContent === null || newContent === null) {
      throw new Error('Ledger rename recovery metadata is incomplete.');
    }
    if (
      ledgerSnippets.some(
        (snippet) =>
          snippet.ledger?.beforeState?.unavailableReason ||
          snippet.ledger?.afterState?.unavailableReason
      )
    ) {
      throw new Error('Ledger rename recovery content is unavailable.');
    }

    return withFileMutationLocks(
      this.resolveLedgerMutationPaths(filePath, ledgerSnippets),
      async () => {
        const oldCurrent = await this.readCurrentText(oldFilePath);
        const oldError = getCurrentTextReadError(oldCurrent);
        if (oldError) throw new Error(oldError);
        const newCurrent = await this.readCurrentText(newFilePath);
        const newError = getCurrentTextReadError(newCurrent);
        if (newError) throw new Error(newError);
        if (!oldCurrent.missing) {
          await this.assertSafeExpectedFile(oldFilePath, oldCurrent.content);
        }
        if (!newCurrent.missing) {
          await this.assertSafeExpectedFile(newFilePath, newCurrent.content);
        }

        const aliased =
          !oldCurrent.missing &&
          !newCurrent.missing &&
          (await this.pathsReferToSameFile(oldFilePath, newFilePath));
        const accepted = aliased
          ? newCurrent.content === newContent
          : oldCurrent.missing && !newCurrent.missing && newCurrent.content === newContent;
        const rejected = aliased
          ? oldCurrent.content === oldContent
          : !oldCurrent.missing && oldCurrent.content === oldContent && newCurrent.missing;
        if (accepted && rejected) return 'both';
        if (accepted) return 'accepted';
        if (rejected) return 'rejected';
        if (oldCurrent.missing && !newCurrent.missing && newCurrent.content === oldContent) {
          return 'restoring';
        }
        if (newCurrent.missing && !oldCurrent.missing && oldCurrent.content === newContent) {
          return 'reapplying';
        }
        if (
          !oldCurrent.missing &&
          oldCurrent.content === oldContent &&
          !newCurrent.missing &&
          newCurrent.content === newContent
        ) {
          return 'legacy-reapplying';
        }
        throw new Error('Ledger rename changed since review update; durable state is ambiguous');
      }
    );
  }

  /**
   * Restore the agent side of a previously rejected ledger rename.
   * Both paths are guarded by the same mutation lock and verified before mutation.
   */
  async restoreRejectedRename(
    filePath: string,
    original: string | null,
    modified: string | null,
    snippets: SnippetDiff[]
  ): Promise<{ success: true }> {
    const ledgerSnippets = snippets.filter((snippet) => snippet.ledger && !snippet.isError);
    const relation = this.resolveLedgerRelation(ledgerSnippets);
    if (relation?.kind !== 'rename') {
      throw new Error('Review file is not a ledger rename.');
    }

    return withFileMutationLocks(
      this.resolveLedgerMutationPaths(filePath, ledgerSnippets),
      async () => {
        await this.restoreRejectedLedgerRename(ledgerSnippets, relation, original, modified);
        return { success: true };
      }
    );
  }

  /** Re-apply the rejected side of a rename when undoing a later restore/accept action. */
  async reapplyRejectedRename(
    filePath: string,
    original: string | null,
    snippets: SnippetDiff[]
  ): Promise<{ success: true }> {
    const ledgerSnippets = snippets.filter((snippet) => snippet.ledger && !snippet.isError);
    const relation = this.resolveLedgerRelation(ledgerSnippets);
    if (relation?.kind !== 'rename') {
      throw new Error('Review file is not a ledger rename.');
    }
    const hasUnavailableState = ledgerSnippets.some(
      (snippet) =>
        snippet.ledger?.beforeState?.unavailableReason ||
        snippet.ledger?.afterState?.unavailableReason
    );

    return withFileMutationLocks(
      this.resolveLedgerMutationPaths(filePath, ledgerSnippets),
      async () => {
        const outcome = await this.rejectLedgerRename(
          ledgerSnippets,
          relation,
          original,
          hasUnavailableState
        );
        if (outcome.handled && (outcome.status === 'applied' || outcome.status === 'skipped')) {
          return { success: true };
        }
        throw new Error(
          outcome.handled && 'error' in outcome
            ? outcome.error
            : 'Ledger rename reject was not handled.'
        );
      }
    );
  }

  /**
   * Check if the file on disk has been modified since the review was computed.
   * Compares current disk content against the expected modified content.
   */
  async checkConflict(filePath: string, expectedModified: string): Promise<ConflictCheckResult> {
    let currentContent: string;
    try {
      currentContent = await readFile(filePath, 'utf8');
    } catch {
      return {
        hasConflict: true,
        conflictContent: null,
        currentContent: '',
        originalContent: expectedModified,
      };
    }

    const hasConflict = currentContent !== expectedModified;

    return {
      hasConflict,
      conflictContent: hasConflict ? currentContent : null,
      currentContent,
      originalContent: expectedModified,
    };
  }

  /**
   * Reject specific hunks from a file's changes.
   * Uses the exact CodeMirror chunk model that produced the renderer indexes.
   */
  async rejectHunks(
    _teamName: string,
    filePath: string,
    original: string,
    modified: string,
    hunkIndices: number[],
    _snippets: SnippetDiff[],
    hunkContextHashes?: Record<number, string>
  ): Promise<RejectResult> {
    let mappedHunkIndices = hunkIndices;
    if (hunkContextHashes) {
      const strictHunks = mapRejectedHunkIndicesByHashStrict(
        original,
        modified,
        hunkIndices,
        hunkContextHashes
      );
      if (!strictHunks.ok) {
        return {
          success: false,
          newContent: modified,
          hadConflicts: true,
          conflictDescription: strictHunks.error,
        };
      }
      mappedHunkIndices = strictHunks.indices;
    }
    const rejectedBaseline = rejectReviewChunks(original, modified, mappedHunkIndices);
    if (rejectedBaseline === null) {
      return {
        success: false,
        newContent: modified,
        hadConflicts: true,
        conflictDescription: 'Не удалось применить reject: индекс CodeMirror chunk недействителен',
      };
    }

    return withFileMutationLock(filePath, async () => {
      const current = await this.readCurrentText(filePath);
      if (current.missing) {
        return {
          success: false,
          newContent: '',
          hadConflicts: true,
          conflictDescription: 'Файл отсутствует на диске; partial reject отменён',
        };
      }
      const currentError = getCurrentTextReadError(current);
      if (currentError) {
        return {
          success: false,
          newContent: '',
          hadConflicts: false,
          conflictDescription: currentError,
        };
      }

      let newContent = rejectedBaseline;
      if (current.content !== modified) {
        const mergeResult = threeWayTextMerge(modified, current.content, rejectedBaseline);
        if (mergeResult.hasConflicts) {
          return {
            success: false,
            newContent: current.content,
            hadConflicts: true,
            conflictDescription:
              'Файл был изменён после вычисления review, и partial reject конфликтует с текущими изменениями',
          };
        }
        newContent = mergeResult.content;
      }

      if (newContent === current.content) {
        return { success: true, newContent, hadConflicts: false };
      }

      try {
        await this.atomicReplaceTextFile(filePath, current.content, newContent);
        return {
          success: true,
          newContent,
          hadConflicts: false,
        };
      } catch (err) {
        return {
          success: false,
          newContent: current.content,
          hadConflicts: false,
          conflictDescription: `Не удалось записать файл: ${String(err)}`,
        };
      }
    });
  }

  /**
   * Reject the entire file — restore to original content.
   */
  async rejectFile(
    _teamName: string,
    filePath: string,
    original: string,
    modified: string
  ): Promise<RejectResult> {
    return withFileMutationLock(filePath, async () => {
      const current = await this.readCurrentText(filePath);
      if (current.missing) {
        return {
          success: false,
          newContent: '',
          hadConflicts: true,
          conflictDescription: 'Файл отсутствует на диске; reject отменён',
        };
      }
      const currentError = getCurrentTextReadError(current);
      if (currentError) {
        return {
          success: false,
          newContent: '',
          hadConflicts: false,
          conflictDescription: currentError,
        };
      }

      if (current.content !== modified) {
        // File was modified since review — try three-way merge
        const currentContent = current.content;
        const mergeResult = threeWayTextMerge(modified, currentContent, original);

        if (mergeResult.hasConflicts) {
          return {
            success: false,
            newContent: currentContent,
            hadConflicts: true,
            conflictDescription:
              'Файл был изменён после вычисления review, и три-сторонний merge обнаружил конфликты',
          };
        }

        try {
          await this.atomicReplaceTextFile(filePath, currentContent, mergeResult.content);
          return {
            success: true,
            newContent: mergeResult.content,
            hadConflicts: false,
          };
        } catch (err) {
          return {
            success: false,
            newContent: currentContent,
            hadConflicts: false,
            conflictDescription: `Не удалось записать файл: ${String(err)}`,
          };
        }
      }

      // No conflict — simply write original content
      try {
        await this.atomicReplaceTextFile(filePath, modified, original);
        return {
          success: true,
          newContent: original,
          hadConflicts: false,
        };
      } catch (err) {
        return {
          success: false,
          newContent: modified,
          hadConflicts: false,
          conflictDescription: `Не удалось записать файл: ${String(err)}`,
        };
      }
    });
  }

  /**
   * Preview what a reject operation would produce WITHOUT writing to disk.
   */
  async previewReject(
    _filePath: string,
    original: string,
    modified: string,
    hunkIndices: number[],
    snippets: SnippetDiff[]
  ): Promise<{ preview: string; hasConflicts: boolean }> {
    void snippets;
    const rejected = rejectReviewChunks(original, modified, hunkIndices);
    return rejected === null
      ? { preview: modified, hasConflicts: true }
      : { preview: rejected, hasConflicts: false };
  }

  /**
   * Apply all review decisions in batch.
   */
  async applyReviewDecisions(
    request: ApplyReviewRequest,
    fileContents = new Map<string, FileChangeWithContent>()
  ): Promise<ApplyReviewResult> {
    let applied = 0;
    let skipped = 0;
    let conflicts = 0;
    const errors: ApplyReviewResult['errors'] = [];

    for (const decision of request.decisions) {
      const fileContent = fileContents.get(decision.filePath);
      if (!fileContent) {
        skipped++;
        continue;
      }

      // Skip files where all hunks are accepted (nothing to reject)
      if (decision.fileDecision === 'accepted') {
        skipped++;
        continue;
      }

      const original = fileContent.originalFullContent;
      const modified = fileContent.modifiedFullContent;

      const rejectedHunkIndices = Object.entries(decision.hunkDecisions)
        .filter(([, d]) => d === 'rejected')
        .map(([idx]) => parseInt(idx, 10));

      const allHunksRejected =
        Object.keys(decision.hunkDecisions).length > 0 &&
        Object.values(decision.hunkDecisions).every((d) => d === 'rejected');
      const hasNewFileSnippet = fileContent.snippets.some(
        (s) => s.type === 'write-new' || s.ledger?.operation === 'create'
      );

      // Special case: rejecting an entirely new file should remove it from disk.
      // IMPORTANT: Do NOT delete on partial reject — users may want to keep parts of the new file.
      const shouldDeleteNewFile =
        fileContent.isNewFile &&
        hasNewFileSnippet &&
        original === '' &&
        (decision.fileDecision === 'rejected' || allHunksRejected);

      const ledgerOutcome = await this.tryApplyLedgerDecision(
        decision.filePath,
        original,
        modified,
        decision.fileDecision === 'rejected',
        allHunksRejected,
        rejectedHunkIndices,
        decision.hunkContextHashes,
        fileContent.snippets
      );
      if (ledgerOutcome.handled) {
        if (ledgerOutcome.status === 'applied') {
          applied++;
        } else if (ledgerOutcome.status === 'skipped') {
          skipped++;
        } else if (ledgerOutcome.status === 'conflict' || ledgerOutcome.status === 'error') {
          if (ledgerOutcome.status === 'conflict') conflicts++;
          errors.push({
            filePath: decision.filePath,
            error: ledgerOutcome.error,
            code: ledgerOutcome.code,
          });
        }
        continue;
      }

      if (shouldDeleteNewFile) {
        const outcome = await withFileMutationLock(decision.filePath, () =>
          this.rejectNonLedgerNewFile(decision.filePath, modified)
        );
        if (outcome.status === 'applied') {
          applied++;
        } else {
          if (outcome.status === 'conflict') conflicts++;
          errors.push({
            filePath: decision.filePath,
            error: outcome.error,
            code: outcome.code,
          });
        }
        continue;
      }

      if (original === null || modified === null) {
        errors.push({
          filePath: decision.filePath,
          error: 'Содержимое файла недоступно для применения review',
          code: 'unavailable',
        });
        continue;
      }

      try {
        if (decision.fileDecision === 'rejected') {
          // Reject entire file
          const result = await this.rejectFile(
            request.teamName,
            decision.filePath,
            original,
            modified
          );
          if (result.success) {
            applied++;
          } else {
            if (result.hadConflicts) conflicts++;
            errors.push({
              filePath: decision.filePath,
              error: result.conflictDescription || 'Не удалось применить reject',
            });
          }
        } else {
          // Partial reject — only specific hunks
          if (rejectedHunkIndices.length === 0) {
            skipped++;
            continue;
          }
          if (!decision.hunkContextHashes) {
            conflicts++;
            errors.push({
              filePath: decision.filePath,
              error: 'Partial reject requires stable hunk context hashes.',
              code: 'conflict',
            });
            continue;
          }

          const result = await this.rejectHunks(
            request.teamName,
            decision.filePath,
            original,
            modified,
            rejectedHunkIndices,
            fileContent.snippets,
            decision.hunkContextHashes
          );

          if (result.success) {
            applied++;
          } else {
            if (result.hadConflicts) conflicts++;
            errors.push({
              filePath: decision.filePath,
              error: result.conflictDescription || 'Не удалось применить reject',
            });
          }
        }
      } catch (err) {
        errors.push({
          filePath: decision.filePath,
          error: `Неожиданная ошибка: ${String(err)}`,
        });
      }
    }

    return { applied, skipped, conflicts, errors };
  }

  /**
   * Save edited file content directly to disk.
   */
  async saveEditedFile(
    filePath: string,
    content: string,
    expectedCurrentContent: string | null
  ): Promise<{ success: boolean }> {
    return withFileMutationLock(filePath, async () => {
      const current = await this.readCurrentText(filePath);
      const currentError = getCurrentTextReadError(current);
      if (currentError) {
        throw new Error(currentError);
      }
      if (expectedCurrentContent !== null && !current.missing && current.content === content) {
        // Idempotent retry after an atomic replacement succeeded but its IPC response
        // was lost. Missing-file restoration intentionally stays non-idempotent because
        // an identical file may have been created independently and must not be claimed.
        return { success: true };
      }
      const matchesExpected =
        expectedCurrentContent === null
          ? current.missing
          : !current.missing && current.content === expectedCurrentContent;
      if (!matchesExpected) {
        throw new Error('File changed since review update; refusing to overwrite');
      }
      if (expectedCurrentContent === null) {
        try {
          await atomicCreateAsync(filePath, content);
        } catch (error) {
          const code =
            error && typeof error === 'object' && 'code' in error
              ? String((error as { code?: unknown }).code)
              : '';
          if (code === 'EEXIST') {
            throw new Error('File changed since review update; refusing to overwrite');
          }
          throw error;
        }
        return { success: true };
      }
      await this.atomicReplaceTextFile(filePath, expectedCurrentContent, content);
      return { success: true };
    });
  }

  /** Delete a reviewed file only when its content still matches the Undo snapshot. */
  async deleteEditedFile(
    filePath: string,
    expectedCurrentContent: string
  ): Promise<{ success: boolean }> {
    return withFileMutationLock(filePath, async () => {
      const current = await this.readCurrentText(filePath);
      const currentError = getCurrentTextReadError(current);
      if (currentError) throw new Error(currentError);
      if (current.missing) {
        // Idempotent retry after a successful delete whose IPC response was lost.
        return { success: true };
      }
      if (current.content !== expectedCurrentContent) {
        throw new Error('File changed since review update; refusing to delete');
      }
      await this.deleteExpectedTextFile(filePath, expectedCurrentContent);
      return { success: true };
    });
  }

  // ── Private: Rejection strategies ──

  private async rejectNonLedgerNewFile(
    filePath: string,
    modified: string | null
  ): Promise<
    { status: 'applied' } | { status: 'conflict' | 'error'; error: string; code: ApplyErrorCode }
  > {
    if (modified === null) {
      const current = await this.readCurrentText(filePath);
      if (current.missing) return { status: 'applied' };
      const currentError = getCurrentTextReadError(current);
      return {
        status: 'error',
        error: currentError ?? 'Cannot delete new file: expected modified content is unavailable.',
        code: currentError ? 'io-error' : 'unavailable',
      };
    }

    const current = await this.readCurrentText(filePath);
    if (current.missing) return { status: 'applied' };
    const currentError = getCurrentTextReadError(current);
    if (currentError) {
      return { status: 'error', error: currentError, code: 'io-error' };
    }
    if (current.content !== modified) {
      return {
        status: 'conflict',
        error:
          'File was modified since review was computed; refusing to delete new file automatically.',
        code: 'conflict',
      };
    }

    try {
      await this.deleteExpectedTextFile(filePath, current.content);
      return { status: 'applied' };
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: unknown }).code)
          : '';
      return code === 'ENOENT'
        ? { status: 'applied' }
        : {
            status: 'error',
            error: `Failed to delete new file: ${String(err)}`,
            code: 'io-error',
          };
    }
  }

  private async tryApplyLedgerDecision(
    filePath: string,
    original: string | null,
    modified: string | null,
    fileRejected: boolean,
    allHunksRejected: boolean,
    rejectedHunkIndices: number[],
    hunkContextHashes: Record<number, string> | undefined,
    snippets: SnippetDiff[]
  ): Promise<LedgerApplyOutcome> {
    const ledgerSnippets = snippets.filter((snippet) => snippet.ledger && !snippet.isError);
    if (ledgerSnippets.length === 0) {
      return { handled: false };
    }

    return withFileMutationLocks(this.resolveLedgerMutationPaths(filePath, ledgerSnippets), () =>
      this.tryApplyLedgerDecisionLocked(
        filePath,
        original,
        modified,
        fileRejected,
        allHunksRejected,
        rejectedHunkIndices,
        hunkContextHashes,
        ledgerSnippets
      )
    );
  }

  private async tryApplyLedgerDecisionLocked(
    filePath: string,
    original: string | null,
    modified: string | null,
    fileRejected: boolean,
    allHunksRejected: boolean,
    rejectedHunkIndices: number[],
    hunkContextHashes: Record<number, string> | undefined,
    ledgerSnippets: SnippetDiff[]
  ): Promise<LedgerApplyOutcome> {
    const firstLedger = ledgerSnippets[0]?.ledger;
    const lastLedger = ledgerSnippets[ledgerSnippets.length - 1]?.ledger;
    if (!firstLedger || !lastLedger) {
      return { handled: false };
    }

    const fullReject = fileRejected || allHunksRejected;
    const hasUnavailableState = ledgerSnippets.some(
      (snippet) =>
        snippet.ledger?.beforeState?.unavailableReason ||
        snippet.ledger?.afterState?.unavailableReason
    );
    const relation = this.resolveLedgerRelation(ledgerSnippets);

    if (hasUnavailableState) {
      return {
        handled: true,
        status: 'error',
        code: 'manual-review-required',
        error: 'Ledger content metadata is unavailable; manual review is required.',
      };
    }

    if (!fullReject) {
      if (relation?.kind === 'rename' || relation?.kind === 'copy') {
        return {
          handled: true,
          status: 'error',
          code: 'manual-review-required',
          error: `Ledger ${relation.kind} partial reject requires manual review.`,
        };
      }
      if (original === null || modified === null) {
        return {
          handled: true,
          status: 'error',
          code: 'manual-review-required',
          error: 'Ledger full text is unavailable; partial reject requires manual review.',
        };
      }
      const strictHunks = mapRejectedHunkIndicesByHashStrict(
        original,
        modified,
        rejectedHunkIndices,
        hunkContextHashes
      );
      if (!strictHunks.ok) {
        return {
          handled: true,
          status: strictHunks.code === 'conflict' ? 'conflict' : 'error',
          code: strictHunks.code,
          error: strictHunks.error,
        };
      }
      const patchResult = this.tryStrictHunkLevelReject(original, modified, strictHunks.indices);
      if (!patchResult) {
        return {
          handled: true,
          status: 'error',
          code: 'manual-review-required',
          error: 'Ledger partial reject could not be applied safely.',
        };
      }

      const expectedHash = lastLedger.afterState?.sha256 ?? lastLedger.afterHash ?? undefined;
      if (!expectedHash) {
        return {
          handled: true,
          status: 'error',
          code: 'manual-review-required',
          error: 'Ledger expected content hash is unavailable; refusing automatic apply.',
        };
      }
      const current = await this.readCurrentText(filePath);
      if (current.missing) {
        return {
          handled: true,
          status: 'conflict',
          code: 'conflict',
          error: 'File is missing on disk; refusing ledger apply.',
        };
      }
      const currentError = getCurrentTextReadError(current);
      if (currentError) {
        return {
          handled: true,
          status: 'error',
          code: 'io-error',
          error: currentError,
        };
      }

      let newContent = patchResult.newContent;
      if (this.hashText(current.content) !== expectedHash) {
        const mergeResult = threeWayTextMerge(modified, current.content, patchResult.newContent);
        if (mergeResult.hasConflicts) {
          return {
            handled: true,
            status: 'conflict',
            code: 'conflict',
            error: 'Current file edits conflict with the requested ledger hunk reject.',
          };
        }
        newContent = mergeResult.content;
      }
      if (newContent === current.content) {
        return { handled: true, status: 'applied' };
      }
      try {
        await this.atomicReplaceTextFile(filePath, current.content, newContent);
        return { handled: true, status: 'applied' };
      } catch (err) {
        return {
          handled: true,
          status: 'error',
          code: 'io-error',
          error: `Не удалось записать файл: ${String(err)}`,
        };
      }
    }

    if (relation?.kind === 'rename') {
      return this.rejectLedgerRename(ledgerSnippets, relation, original, hasUnavailableState);
    }

    const operation = this.resolveLedgerOperation(ledgerSnippets);
    if (operation === 'create') {
      const afterHash = lastLedger.afterState?.sha256 ?? lastLedger.afterHash ?? undefined;
      const current = await this.readCurrentText(filePath);
      if (current.missing) {
        return { handled: true, status: 'applied' };
      }
      const currentError = getCurrentTextReadError(current);
      if (currentError) {
        return {
          handled: true,
          status: 'error',
          code: 'io-error',
          error: currentError,
        };
      }
      if (!afterHash) {
        return {
          handled: true,
          status: 'error',
          code: hasUnavailableState ? 'manual-review-required' : 'unavailable',
          error: 'Ledger after content hash is unavailable; refusing to delete file automatically.',
        };
      }
      if (this.hashText(current.content) !== afterHash) {
        return {
          handled: true,
          status: 'conflict',
          code: 'conflict',
          error: 'File was modified since review was computed; refusing ledger delete.',
        };
      }
      try {
        await this.deleteExpectedTextFile(filePath, current.content);
        return { handled: true, status: 'applied' };
      } catch (err) {
        const msg = String(err);
        if (msg.includes('ENOENT')) {
          return { handled: true, status: 'applied' };
        }
        return {
          handled: true,
          status: 'error',
          code: 'io-error',
          error: `Failed to delete new file: ${msg}`,
        };
      }
    }

    if (operation === 'delete') {
      if (original === null) {
        return {
          handled: true,
          status: 'error',
          code: 'manual-review-required',
          error: 'Ledger before content is unavailable; deleted file requires manual restore.',
        };
      }
      const current = await this.readCurrentText(filePath);
      if (!current.missing) {
        const currentError = getCurrentTextReadError(current);
        if (!currentError && current.content === original) {
          return { handled: true, status: 'applied' };
        }
        return {
          handled: true,
          status: 'conflict',
          code: 'conflict',
          error:
            currentError || 'File exists on disk; refusing to overwrite while rejecting delete.',
        };
      }
      try {
        await mkdir(dirname(filePath), { recursive: true });
        await atomicCreateAsync(filePath, original);
        return { handled: true, status: 'applied' };
      } catch (err) {
        const code =
          err && typeof err === 'object' && 'code' in err
            ? String((err as { code?: unknown }).code)
            : '';
        return {
          handled: true,
          status: code === 'EEXIST' ? 'conflict' : 'error',
          code: code === 'EEXIST' ? 'conflict' : 'io-error',
          error:
            code === 'EEXIST'
              ? 'Deleted file was recreated while restoring it; refusing overwrite.'
              : `Не удалось записать файл: ${String(err)}`,
        };
      }
    }

    if (original === null) {
      return {
        handled: true,
        status: 'error',
        code: 'manual-review-required',
        error:
          'Ledger before content is unavailable; rejecting this change requires manual review.',
      };
    }
    const current = await this.readCurrentText(filePath);
    const currentError = getCurrentTextReadError(current);
    if (currentError) {
      return {
        handled: true,
        status: 'error',
        code: 'io-error',
        error: currentError,
      };
    }
    if (!current.missing && current.content === original) {
      return { handled: true, status: 'applied' };
    }
    const guard = await this.checkLedgerCurrentHash(
      filePath,
      lastLedger.afterState?.sha256 ?? lastLedger.afterHash ?? undefined
    );
    if (!guard.ok) {
      return guard.outcome;
    }
    try {
      await this.atomicReplaceTextFile(filePath, current.content, original);
      return { handled: true, status: 'applied' };
    } catch (err) {
      return {
        handled: true,
        status: 'error',
        code: 'io-error',
        error: `Не удалось записать файл: ${String(err)}`,
      };
    }
  }

  private resolveLedgerOperation(snippets: SnippetDiff[]): 'create' | 'modify' | 'delete' {
    const ledgerSnippets = snippets.filter((snippet) => snippet.ledger);
    const firstLedger = ledgerSnippets[0]?.ledger;
    const lastLedger = ledgerSnippets[ledgerSnippets.length - 1]?.ledger;
    const baselineExists = firstLedger?.beforeState?.exists;
    const finalExists = lastLedger?.afterState?.exists;

    if (baselineExists === false && finalExists === true) return 'create';
    if (baselineExists === true && finalExists === false) return 'delete';
    if (baselineExists === true && finalExists === true) return 'modify';
    if (baselineExists === false && finalExists === false) return 'create';

    if (lastLedger?.operation === 'delete') return 'delete';
    if (firstLedger?.operation === 'create') return 'create';
    return 'modify';
  }

  private resolveLedgerRelation(snippets: SnippetDiff[]): LedgerChangeRelation | undefined {
    return snippets.find((snippet) => snippet.ledger?.relation)?.ledger?.relation;
  }

  private resolveLedgerMutationPaths(filePath: string, snippets: SnippetDiff[]): string[] {
    const paths = new Set<string>([filePath]);
    for (const snippet of snippets) {
      paths.add(snippet.filePath);
    }

    const relation = this.resolveLedgerRelation(snippets);
    if (relation?.kind === 'rename') {
      const newSnippet = snippets.find(
        (snippet) =>
          snippet.ledger?.operation === 'create' &&
          this.pathMatchesRelationPath(snippet.filePath, relation.newPath)
      );
      const oldSnippet = snippets.find(
        (snippet) =>
          snippet.ledger?.operation === 'delete' &&
          this.pathMatchesRelationPath(snippet.filePath, relation.oldPath)
      );
      const inferredOldPath = this.resolveRelatedLedgerPath(
        newSnippet?.filePath,
        relation.newPath,
        relation.oldPath
      );
      if (oldSnippet?.filePath) paths.add(oldSnippet.filePath);
      if (inferredOldPath) paths.add(inferredOldPath);
    }

    return [...paths];
  }

  private async rejectLedgerRename(
    snippets: SnippetDiff[],
    relation: LedgerChangeRelation,
    original: string | null,
    hasUnavailableState: boolean
  ): Promise<LedgerApplyOutcome> {
    const oldSnippet =
      snippets.find(
        (snippet) =>
          snippet.ledger?.operation === 'delete' &&
          this.pathMatchesRelationPath(snippet.filePath, relation.oldPath)
      ) ?? snippets.find((snippet) => snippet.ledger?.operation === 'delete');
    const newSnippet =
      snippets.find(
        (snippet) =>
          snippet.ledger?.operation === 'create' &&
          this.pathMatchesRelationPath(snippet.filePath, relation.newPath)
      ) ?? snippets.find((snippet) => snippet.ledger?.operation === 'create');
    const oldFilePath =
      oldSnippet?.filePath ??
      this.resolveRelatedLedgerPath(newSnippet?.filePath, relation.newPath, relation.oldPath);
    const newFilePath = newSnippet?.filePath;
    const oldContent = oldSnippet?.ledger?.originalFullContent ?? original;
    const newHash = newSnippet?.ledger?.afterState?.sha256 ?? newSnippet?.ledger?.afterHash;
    const oldHash = oldSnippet?.ledger?.beforeState?.sha256 ?? oldSnippet?.ledger?.beforeHash;

    if (!oldFilePath || !newFilePath || oldContent === null) {
      return {
        handled: true,
        status: 'error',
        code: 'manual-review-required',
        error: 'Ledger rename metadata is incomplete; manual review is required.',
      };
    }
    if (hasUnavailableState || !newHash) {
      return {
        handled: true,
        status: 'error',
        code: 'manual-review-required',
        error: 'Ledger rename content metadata is unavailable; manual review is required.',
      };
    }

    const newCurrent = await this.readCurrentText(newFilePath);
    const newCurrentError = newCurrent.missing ? null : getCurrentTextReadError(newCurrent);
    if (newCurrentError) {
      return { handled: true, status: 'error', code: 'io-error', error: newCurrentError };
    }
    const oldCurrent = await this.readCurrentText(oldFilePath);
    const oldCurrentError = oldCurrent.missing ? null : getCurrentTextReadError(oldCurrent);
    if (oldCurrentError) {
      return {
        handled: true,
        status: 'error',
        code: 'io-error',
        error: oldCurrentError,
      };
    }
    const oldMatchesExpected =
      !oldCurrent.missing &&
      (oldHash ? this.hashText(oldCurrent.content) === oldHash : oldCurrent.content === oldContent);
    const newMatchesExpected = !newCurrent.missing && this.hashText(newCurrent.content) === newHash;
    const aliased =
      !oldCurrent.missing &&
      !newCurrent.missing &&
      (await this.pathsReferToSameFile(oldFilePath, newFilePath));

    if (aliased) {
      if (!newMatchesExpected && !oldMatchesExpected) {
        return {
          handled: true,
          status: 'conflict',
          code: 'conflict',
          error: 'Case-only rename content changed; refusing ledger reject.',
        };
      }
      const currentContent = newMatchesExpected ? newCurrent.content : oldCurrent.content;
      try {
        await renamePathWithRetry(newFilePath, oldFilePath, { syncDirectories: true });
        if (currentContent !== oldContent) {
          await this.atomicReplaceTextFile(oldFilePath, currentContent, oldContent);
        }
        return { handled: true, status: 'applied' };
      } catch (error) {
        return {
          handled: true,
          status: 'error',
          code: 'io-error',
          error: `Failed to reject case-only ledger rename: ${String(error)}`,
        };
      }
    }

    if (newCurrent.missing) {
      if (oldMatchesExpected) return { handled: true, status: 'applied' };
      // Crash after the durable path move but before the content replacement.
      if (!oldCurrent.missing && this.hashText(oldCurrent.content) === newHash) {
        try {
          await this.atomicReplaceTextFile(oldFilePath, oldCurrent.content, oldContent);
          return { handled: true, status: 'applied' };
        } catch (error) {
          return {
            handled: true,
            status: 'error',
            code: 'io-error',
            error: `Failed to finish interrupted ledger rename reject: ${String(error)}`,
          };
        }
      }
      return {
        handled: true,
        status: 'conflict',
        code: 'conflict',
        error: 'Renamed target path is missing; refusing to recreate the original path.',
      };
    }
    if (!newMatchesExpected) {
      return {
        handled: true,
        status: 'conflict',
        code: 'conflict',
        error: 'Renamed file was modified since review was computed; refusing ledger reject.',
      };
    }
    // Compatibility recovery for the old create-then-delete implementation.
    if (!oldCurrent.missing) {
      if (!oldMatchesExpected) {
        return {
          handled: true,
          status: 'conflict',
          code: 'conflict',
          error: 'Original rename path already exists with different content; refusing overwrite.',
        };
      }
      try {
        await this.deleteExpectedTextFile(newFilePath, newCurrent.content);
        return { handled: true, status: 'applied' };
      } catch (error) {
        return {
          handled: true,
          status: 'error',
          code: 'io-error',
          error: `Failed to finish legacy ledger rename reject: ${String(error)}`,
        };
      }
    }

    try {
      await renamePathWithRetry(newFilePath, oldFilePath, { syncDirectories: true });
      if (newCurrent.content !== oldContent) {
        await this.atomicReplaceTextFile(oldFilePath, newCurrent.content, oldContent);
      }
      return { handled: true, status: 'applied' };
    } catch (error) {
      return {
        handled: true,
        status: 'error',
        code: 'io-error',
        error: `Failed to reject ledger rename: ${String(error)}`,
      };
    }
  }

  private async restoreRejectedLedgerRename(
    snippets: SnippetDiff[],
    relation: LedgerChangeRelation,
    original: string | null,
    modified: string | null
  ): Promise<void> {
    const oldSnippet =
      snippets.find(
        (snippet) =>
          snippet.ledger?.operation === 'delete' &&
          this.pathMatchesRelationPath(snippet.filePath, relation.oldPath)
      ) ?? snippets.find((snippet) => snippet.ledger?.operation === 'delete');
    const newSnippet =
      snippets.find(
        (snippet) =>
          snippet.ledger?.operation === 'create' &&
          this.pathMatchesRelationPath(snippet.filePath, relation.newPath)
      ) ?? snippets.find((snippet) => snippet.ledger?.operation === 'create');
    const oldFilePath =
      oldSnippet?.filePath ??
      this.resolveRelatedLedgerPath(newSnippet?.filePath, relation.newPath, relation.oldPath);
    const newFilePath = newSnippet?.filePath;
    const oldContent = oldSnippet?.ledger?.originalFullContent ?? original;
    const newContent = newSnippet?.ledger?.modifiedFullContent ?? modified;

    if (!oldFilePath || !newFilePath || oldContent === null || newContent === null) {
      throw new Error('Ledger rename recovery metadata is incomplete.');
    }
    if (
      snippets.some(
        (snippet) =>
          snippet.ledger?.beforeState?.unavailableReason ||
          snippet.ledger?.afterState?.unavailableReason
      )
    ) {
      throw new Error('Ledger rename recovery content is unavailable.');
    }

    const oldCurrent = await this.readCurrentText(oldFilePath);
    const oldReadError = getCurrentTextReadError(oldCurrent);
    if (oldReadError) throw new Error(oldReadError);
    const newCurrent = await this.readCurrentText(newFilePath);
    const newReadError = getCurrentTextReadError(newCurrent);
    if (newReadError) throw new Error(newReadError);
    const aliased =
      !oldCurrent.missing &&
      !newCurrent.missing &&
      (await this.pathsReferToSameFile(oldFilePath, newFilePath));

    if (aliased) {
      if (newCurrent.content === newContent) return;
      if (newCurrent.content !== oldContent) {
        throw new Error('Case-only rename content changed after rejection; refusing Undo.');
      }
      try {
        await renamePathWithRetry(oldFilePath, newFilePath, { syncDirectories: true });
        if (oldContent !== newContent) {
          await this.atomicReplaceTextFile(newFilePath, oldContent, newContent);
        }
        return;
      } catch (error) {
        throw new Error(`Failed to restore case-only ledger rename: ${String(error)}`);
      }
    }

    if (oldCurrent.missing) {
      if (!newCurrent.missing && newCurrent.content === newContent) return;
      // Crash after the path move but before publishing the target content.
      if (!newCurrent.missing && newCurrent.content === oldContent) {
        await this.atomicReplaceTextFile(newFilePath, oldContent, newContent);
        return;
      }
      throw new Error('Original rename path changed after rejection; refusing Undo.');
    }
    if (oldCurrent.content !== oldContent) {
      throw new Error('Original rename path changed after rejection; refusing Undo.');
    }
    if (!newCurrent.missing) {
      throw new Error('Renamed target path already exists; refusing Undo.');
    }

    try {
      await renamePathWithRetry(oldFilePath, newFilePath, { syncDirectories: true });
      if (oldContent !== newContent) {
        await this.atomicReplaceTextFile(newFilePath, oldContent, newContent);
      }
    } catch (error) {
      throw new Error(`Failed to restore ledger rename: ${String(error)}`);
    }
  }

  private pathMatchesRelationPath(filePath: string, relationPath: string): boolean {
    const caseInsensitive =
      this.isWindowsReviewPath(filePath) || this.isWindowsReviewPath(relationPath);
    const normalizedFilePath = this.normalizeRelationComparisonPath(filePath, caseInsensitive);
    const normalizedRelationPath = this.normalizeRelationComparisonPath(
      relationPath,
      caseInsensitive
    );
    return (
      normalizedFilePath === normalizedRelationPath ||
      normalizedFilePath.endsWith(`/${normalizedRelationPath}`)
    );
  }

  private resolveRelatedLedgerPath(
    anchorPath: string | undefined,
    anchorRelationPath: string,
    targetRelationPath: string
  ): string | null {
    if (!anchorPath) {
      return null;
    }
    const slashAnchor = anchorPath.replace(/\\/g, '/');
    const slashRelation = anchorRelationPath.replace(/\\/g, '/');
    const caseInsensitive =
      this.isWindowsReviewPath(anchorPath) || this.isWindowsReviewPath(anchorRelationPath);
    const normalizedAnchor = this.normalizeRelationComparisonPath(anchorPath, caseInsensitive);
    const normalizedRelation = this.normalizeRelationComparisonPath(
      anchorRelationPath,
      caseInsensitive
    );
    if (!this.matchesRelationSuffix(normalizedAnchor, normalizedRelation)) {
      return null;
    }
    return `${slashAnchor.slice(0, slashAnchor.length - slashRelation.length)}${targetRelationPath.replace(/\\/g, '/')}`;
  }

  private normalizeRelationComparisonPath(filePath: string, caseInsensitive: boolean): string {
    const normalized = normalizePathForComparison(filePath);
    return caseInsensitive ? normalized.toLowerCase() : normalized;
  }

  private isWindowsReviewPath(filePath: string): boolean {
    return isWindowsishPath(filePath) || filePath.includes('\\');
  }

  private matchesRelationSuffix(normalizedPath: string, normalizedRelationPath: string): boolean {
    return (
      normalizedPath === normalizedRelationPath ||
      normalizedPath.endsWith(`/${normalizedRelationPath}`)
    );
  }

  private async checkLedgerCurrentHash(
    filePath: string,
    expectedHash: string | undefined
  ): Promise<{ ok: true } | { ok: false; outcome: LedgerApplyOutcome }> {
    if (!expectedHash) {
      return {
        ok: false,
        outcome: {
          handled: true,
          status: 'error',
          code: 'manual-review-required',
          error: 'Ledger expected content hash is unavailable; refusing automatic apply.',
        },
      };
    }
    const current = await this.readCurrentText(filePath);
    if (current.missing) {
      return {
        ok: false,
        outcome: {
          handled: true,
          status: 'conflict',
          code: 'conflict',
          error: 'File is missing on disk; refusing ledger apply.',
        },
      };
    }
    const currentError = getCurrentTextReadError(current);
    if (currentError) {
      return {
        ok: false,
        outcome: {
          handled: true,
          status: 'error',
          code: 'io-error',
          error: currentError,
        },
      };
    }
    if (this.hashText(current.content) !== expectedHash) {
      return {
        ok: false,
        outcome: {
          handled: true,
          status: 'conflict',
          code: 'conflict',
          error: 'File was modified since review was computed; refusing ledger apply.',
        },
      };
    }
    return { ok: true };
  }

  private async readCurrentText(filePath: string): Promise<CurrentTextReadResult> {
    try {
      return { missing: false, content: await readFile(filePath, 'utf8') };
    } catch (err) {
      const code =
        err && typeof err === 'object' && 'code' in err
          ? String((err as { code?: unknown }).code)
          : '';
      if (code === 'ENOENT') {
        return { missing: true, content: '' };
      }
      return { missing: false, content: '', error: `Не удалось прочитать файл: ${String(err)}` };
    }
  }

  private async atomicReplaceTextFile(
    filePath: string,
    expectedCurrentContent: string,
    nextContent: string
  ): Promise<void> {
    const initial = await this.assertSafeExpectedFile(filePath, expectedCurrentContent);
    await atomicWriteAsync(filePath, nextContent, {
      mode: initial.mode & 0o7777,
      durability: 'strict',
      syncDirectory: true,
      beforeCommit: async () => {
        const latest = await this.assertSafeExpectedFile(filePath, expectedCurrentContent);
        if (latest.dev !== initial.dev || latest.ino !== initial.ino) {
          throw new Error('File changed during review update; refusing to overwrite');
        }
      },
    });
  }

  private async assertSafeExpectedFile(
    filePath: string,
    expectedCurrentContent: string
  ): Promise<{ dev: number; ino: number; mode: number }> {
    let stats;
    try {
      stats = await lstat(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'ENOTDIR') {
        throw Object.assign(new Error('File changed during review update; refusing to overwrite'), {
          code,
        });
      }
      throw error;
    }
    if (stats.isSymbolicLink() || !stats.isFile() || stats.nlink > 1) {
      throw new Error('Review mutation refuses symbolic or multiply-linked files');
    }
    const current = await this.readCurrentText(filePath);
    const currentError = getCurrentTextReadError(current);
    if (current.missing || currentError || current.content !== expectedCurrentContent) {
      throw new Error(currentError ?? 'File changed during review update; refusing to overwrite');
    }
    return { dev: stats.dev, ino: stats.ino, mode: stats.mode };
  }

  private async deleteExpectedTextFile(
    filePath: string,
    expectedCurrentContent: string
  ): Promise<void> {
    try {
      const initial = await this.assertSafeExpectedFile(filePath, expectedCurrentContent);
      const latest = await this.assertSafeExpectedFile(filePath, expectedCurrentContent);
      if (latest.dev !== initial.dev || latest.ino !== initial.ino) {
        throw new Error('File changed during review delete; refusing to remove it');
      }
      await unlinkPathDurably(filePath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT' && code !== 'ENOTDIR') throw error;
    }
  }

  private async pathsReferToSameFile(firstPath: string, secondPath: string): Promise<boolean> {
    if (firstPath === secondPath) return true;

    const firstNormalized = normalizePathForComparison(firstPath).normalize('NFC');
    const secondNormalized = normalizePathForComparison(secondPath).normalize('NFC');
    if (firstNormalized.toLowerCase() !== secondNormalized.toLowerCase()) {
      // Equal inode alone can mean an arbitrary hardlink, not a case-only rename alias.
      return false;
    }

    try {
      const [first, second] = await Promise.all([lstat(firstPath), lstat(secondPath)]);
      return Boolean(
        first && second && first.ino !== 0 && first.ino === second.ino && first.dev === second.dev
      );
    } catch {
      return false;
    }
  }

  private hashText(content: string): string {
    return createHash('sha256').update(content).digest('hex');
  }

  private tryStrictHunkLevelReject(
    original: string,
    modified: string,
    hunkIndices: number[]
  ): RejectResult | null {
    const newContent = rejectReviewChunks(original, modified, hunkIndices);
    return newContent === null ? null : { success: true, newContent, hadConflicts: false };
  }
}

function buildReviewChunkHashIndexMap(original: string, modified: string): Map<string, number[]> {
  const map = new Map<string, number[]>();
  for (const [rawIndex, hash] of Object.entries(
    buildReviewChunkContextHashes(original, modified)
  )) {
    const index = Number(rawIndex);
    const arr = map.get(hash);
    if (arr) arr.push(index);
    else map.set(hash, [index]);
  }
  return map;
}

function mapRejectedHunkIndicesByHashStrict(
  original: string,
  modified: string,
  rejectedIndices: number[],
  hunkContextHashes: Record<number, string> | undefined
): { ok: true; indices: number[] } | { ok: false; code: ApplyErrorCode; error: string } {
  if (rejectedIndices.length === 0) {
    return { ok: true, indices: [] };
  }
  if (!hunkContextHashes || Object.keys(hunkContextHashes).length === 0) {
    return {
      ok: false,
      code: 'manual-review-required',
      error: 'Partial reject requires stable hunk context hashes.',
    };
  }

  const hashMap = buildReviewChunkHashIndexMap(original, modified);
  const out = new Set<number>();
  for (const idx of rejectedIndices) {
    const hash = hunkContextHashes[idx];
    if (!hash) {
      return {
        ok: false,
        code: 'manual-review-required',
        error: 'Partial reject is missing a hunk context hash.',
      };
    }
    const candidates = hashMap.get(hash);
    if (!candidates || candidates.length === 0) {
      return {
        ok: false,
        code: 'conflict',
        error: 'Partial reject hunk context changed; please re-review.',
      };
    }
    if (candidates.length > 1) {
      return {
        ok: false,
        code: 'conflict',
        error: 'Partial reject hunk context is ambiguous; please re-review.',
      };
    }
    out.add(candidates[0]);
  }
  return { ok: true, indices: [...out].sort((a, b) => a - b) };
}

/**
 * Three-way merge using node-diff3.
 *
 * @param base   base version (common ancestor)
 * @param ours   "our" version (current state)
 * @param theirs "their" version (desired state)
 * @returns merged content and conflict indicator
 */
