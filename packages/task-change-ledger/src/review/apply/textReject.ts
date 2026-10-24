import { rejectReviewChunks } from './reviewChunks.js';
import { threeWayTextMerge } from './threeWayTextMerge.js';
import { readFile } from 'fs/promises';
import type { ConflictCheckResult, RejectResult, SnippetDiff } from '../../contracts.js';
import {
  type ApplyErrorCode,
  getCurrentTextReadError,
  withFileMutationLock,
  mapRejectedHunkIndicesByHashStrict,
  type ApplierContext,
} from './applyContext.js';

export function createTextReject(getContext: () => ApplierContext) {
  return {
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
    },
    async rejectHunks(
      _teamName: string,
      filePath: string,
      original: string,
      modified: string,
      hunkIndices: number[],
      _snippets: SnippetDiff[],
      hunkContextHashes?: Record<number, string>
    ): Promise<RejectResult> {
      const ctx = getContext();
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
          conflictDescription:
            'Не удалось применить reject: индекс CodeMirror chunk недействителен',
        };
      }

      return withFileMutationLock(filePath, async () => {
        const current = await ctx.readCurrentText(filePath);
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
          await ctx.atomicReplaceTextFile(filePath, current.content, newContent);
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
    },
    async rejectFile(
      _teamName: string,
      filePath: string,
      original: string,
      modified: string
    ): Promise<RejectResult> {
      const ctx = getContext();
      return withFileMutationLock(filePath, async () => {
        const current = await ctx.readCurrentText(filePath);
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
            await ctx.atomicReplaceTextFile(filePath, currentContent, mergeResult.content);
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
          await ctx.atomicReplaceTextFile(filePath, modified, original);
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
    },
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
    },
    async rejectNonLedgerNewFile(
      filePath: string,
      modified: string | null
    ): Promise<
      { status: 'applied' } | { status: 'conflict' | 'error'; error: string; code: ApplyErrorCode }
    > {
      const ctx = getContext();
      if (modified === null) {
        const current = await ctx.readCurrentText(filePath);
        if (current.missing) return { status: 'applied' };
        const currentError = getCurrentTextReadError(current);
        return {
          status: 'error',
          error:
            currentError ?? 'Cannot delete new file: expected modified content is unavailable.',
          code: currentError ? 'io-error' : 'unavailable',
        };
      }

      const current = await ctx.readCurrentText(filePath);
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
        await ctx.deleteExpectedTextFile(filePath, current.content);
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
    },
    tryStrictHunkLevelReject(
      original: string,
      modified: string,
      hunkIndices: number[]
    ): RejectResult | null {
      const newContent = rejectReviewChunks(original, modified, hunkIndices);
      return newContent === null ? null : { success: true, newContent, hadConflicts: false };
    },
  };
}
