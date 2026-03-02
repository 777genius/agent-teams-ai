import { computeDiffContextHash } from '@shared/utils/diffContextHash';
import { createLogger } from '@shared/utils/logger';
import { applyPatch, structuredPatch } from 'diff';
import { readFile, unlink, writeFile } from 'fs/promises';
import { diff3Merge } from 'node-diff3';

import { HunkSnippetMatcher } from './HunkSnippetMatcher';

import type {
  ApplyReviewRequest,
  ApplyReviewResult,
  ConflictCheckResult,
  FileChangeWithContent,
  RejectResult,
  SnippetDiff,
} from '@shared/types';
import type { StructuredPatchHunk } from 'diff';

const logger = createLogger('Service:ReviewApplierService');

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
  private readonly matcher = new HunkSnippetMatcher();

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
   *
   * PRIMARY approach: snippet-level replacement with positional reverse.
   * FALLBACK: hunk-level inverse patch when snippet replacement fails.
   */
  async rejectHunks(
    _teamName: string,
    filePath: string,
    original: string,
    modified: string,
    hunkIndices: number[],
    snippets: SnippetDiff[]
  ): Promise<RejectResult> {
    // Try snippet-level reverse first (most accurate)
    const snippetResult = this.trySnippetLevelReject(original, modified, hunkIndices, snippets);
    if (snippetResult) {
      try {
        await writeFile(filePath, snippetResult.newContent, 'utf8');
        return snippetResult;
      } catch (err) {
        return {
          success: false,
          newContent: modified,
          hadConflicts: false,
          conflictDescription: `Не удалось записать файл: ${String(err)}`,
        };
      }
    }

    // Fallback: hunk-level inverse patch
    const patchResult = this.tryHunkLevelReject(original, modified, hunkIndices);
    if (patchResult) {
      try {
        await writeFile(filePath, patchResult.newContent, 'utf8');
        return patchResult;
      } catch (err) {
        return {
          success: false,
          newContent: modified,
          hadConflicts: false,
          conflictDescription: `Не удалось записать файл: ${String(err)}`,
        };
      }
    }

    // Both approaches failed — try three-way merge as last resort
    const mergeResult = threeWayMerge(original, modified, original);
    if (!mergeResult.hasConflicts) {
      try {
        await writeFile(filePath, mergeResult.content, 'utf8');
        return {
          success: true,
          newContent: mergeResult.content,
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
    }

    return {
      success: false,
      newContent: modified,
      hadConflicts: true,
      conflictDescription: 'Не удалось применить reject: все стратегии завершились неудачно',
    };
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
    // Check for conflicts first
    const conflict = await this.checkConflict(filePath, modified);
    if (conflict.hasConflict) {
      // File was modified since review — try three-way merge
      const currentContent = conflict.currentContent;
      const mergeResult = threeWayMerge(modified, currentContent, original);

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
        await writeFile(filePath, mergeResult.content, 'utf8');
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
      await writeFile(filePath, original, 'utf8');
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
    // Try snippet-level reverse
    const snippetResult = this.trySnippetLevelReject(original, modified, hunkIndices, snippets);
    if (snippetResult) {
      return { preview: snippetResult.newContent, hasConflicts: false };
    }

    // Fallback: hunk-level inverse patch
    const patchResult = this.tryHunkLevelReject(original, modified, hunkIndices);
    if (patchResult) {
      return { preview: patchResult.newContent, hasConflicts: patchResult.hadConflicts };
    }

    // Final fallback — three-way merge
    const mergeResult = threeWayMerge(original, modified, original);
    return { preview: mergeResult.content, hasConflicts: mergeResult.hasConflicts };
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
      const hasWriteNewSnippet = fileContent.snippets.some((s) => s.type === 'write-new');

      // Special case: rejecting an entirely new file should remove it from disk.
      // IMPORTANT: Do NOT delete on partial reject — users may want to keep parts of the new file.
      const shouldDeleteNewFile =
        fileContent.isNewFile &&
        hasWriteNewSnippet &&
        original === '' &&
        (decision.fileDecision === 'rejected' || allHunksRejected);

      if (shouldDeleteNewFile) {
        // If we have an expected modified baseline, guard against deleting a user-modified file.
        if (modified !== null) {
          const conflict = await this.checkConflict(decision.filePath, modified);
          if (conflict.hasConflict) {
            conflicts++;
            errors.push({
              filePath: decision.filePath,
              error:
                'File was modified since review was computed; refusing to delete new file automatically.',
            });
            continue;
          }
        } else {
          // No baseline — safest behavior is to only treat "already missing" as success.
          try {
            await readFile(decision.filePath, 'utf8');
          } catch {
            applied++;
            continue;
          }
          errors.push({
            filePath: decision.filePath,
            error: 'Cannot delete new file: expected modified content is unavailable.',
          });
          continue;
        }

        try {
          await unlink(decision.filePath);
          applied++;
        } catch (err) {
          const msg = String(err);
          if (msg.includes('ENOENT')) {
            applied++;
          } else {
            errors.push({
              filePath: decision.filePath,
              error: `Failed to delete new file: ${msg}`,
            });
          }
        }
        continue;
      }

      if (original === null || modified === null) {
        errors.push({
          filePath: decision.filePath,
          error: 'Содержимое файла недоступно для применения review',
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

          const mappedRejected =
            decision.hunkContextHashes && Object.keys(decision.hunkContextHashes).length > 0
              ? mapRejectedHunkIndicesByHash(
                  original,
                  modified,
                  rejectedHunkIndices,
                  decision.hunkContextHashes
                )
              : rejectedHunkIndices;

          const result = await this.rejectHunks(
            request.teamName,
            decision.filePath,
            original,
            modified,
            mappedRejected,
            fileContent.snippets
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
  async saveEditedFile(filePath: string, content: string): Promise<{ success: boolean }> {
    await writeFile(filePath, content, 'utf8');
    return { success: true };
  }

  // ── Private: Rejection strategies ──

  /**
   * Snippet-level rejection: reverse specific snippets by position (most accurate).
   *
   * Uses HunkSnippetMatcher with content overlap analysis to map
   * hunk indices → snippet indices, then reverses matched snippets.
   */
  private trySnippetLevelReject(
    original: string,
    modified: string,
    hunkIndices: number[],
    snippets: SnippetDiff[]
  ): RejectResult | null {
    // Safety: never use full-file Write snippets for snippet-level rejection.
    // They are not localized, and matching a single hunk to a full-file write
    // can incorrectly delete/overwrite large parts of the file.
    const validSnippets = snippets.filter(
      (s) => !s.isError && s.type !== 'write-new' && s.type !== 'write-update'
    );
    if (validSnippets.length === 0) return null;

    // Pass pre-filtered snippets — matcher returns indices relative to this array
    const hunkToSnippets = this.matcher.matchHunksToSnippets(
      original,
      modified,
      hunkIndices,
      validSnippets
    );

    // Safety: if any requested hunk maps ambiguously, do NOT attempt snippet-level replacement.
    // Fall back to hunk-level inverse patch which is positional and safer.
    for (const hunkIdx of hunkIndices) {
      const set = hunkToSnippets.get(hunkIdx);
      if (set?.size !== 1) {
        return null;
      }
    }

    // Collect all unique snippet indices to reject
    const snippetIndices = new Set<number>();
    for (const indices of hunkToSnippets.values()) {
      indices.forEach((idx) => snippetIndices.add(idx));
    }

    const snippetsToReject = Array.from(snippetIndices)
      .map((idx) => validSnippets[idx])
      .filter(Boolean);

    if (snippetsToReject.length === 0) return null;

    let content = modified;

    // Find positions using disambiguation and sort descending for safe replacement
    const positioned = snippetsToReject
      .map((snippet) => {
        const pos = this.matcher.findSnippetPosition(snippet, content);
        return { snippet, pos };
      })
      .filter((item) => item.pos !== -1)
      .sort((a, b) => b.pos - a.pos);

    if (positioned.length !== snippetsToReject.length) {
      // Some snippets' newStrings not found — can't do snippet-level
      return null;
    }

    for (const { snippet, pos } of positioned) {
      if (snippet.type === 'write-new') {
        // Can't partially reject a file creation at snippet level
        continue;
      }

      if (snippet.replaceAll) {
        content = content.split(snippet.newString).join(snippet.oldString);
      } else {
        content =
          content.substring(0, pos) +
          snippet.oldString +
          content.substring(pos + snippet.newString.length);
      }
    }

    return {
      success: true,
      newContent: content,
      hadConflicts: false,
    };
  }

  /**
   * Hunk-level rejection: create inverse patch for rejected hunks and apply it.
   */
  private tryHunkLevelReject(
    original: string,
    modified: string,
    hunkIndices: number[]
  ): RejectResult | null {
    // Create structured patch
    const patch = structuredPatch('file', 'file', original, modified);

    if (!patch.hunks || patch.hunks.length === 0) return null;

    // Validate hunk indices
    const validIndices = hunkIndices.filter((idx) => idx >= 0 && idx < patch.hunks.length);
    if (validIndices.length === 0) return null;

    // Build a partial inverse patch: only reverse the rejected hunks
    const inversedHunks: StructuredPatchHunk[] = [];
    for (const idx of validIndices) {
      const hunk = patch.hunks[idx];
      if (!hunk) continue;
      inversedHunks.push(invertHunk(hunk));
    }

    if (inversedHunks.length === 0) return null;

    // Create a partial inverse patch with the inverted hunks
    const inversePatch = {
      oldFileName: 'file',
      newFileName: 'file',
      oldHeader: undefined,
      newHeader: undefined,
      hunks: inversedHunks,
    };

    // Apply the inverse patch to the modified content
    const result = applyPatch(modified, inversePatch, { fuzzFactor: 2 });

    if (result === false) {
      logger.debug('Hunk-level inverse patch не удался');
      return null;
    }

    return {
      success: true,
      newContent: result,
      hadConflicts: false,
    };
  }
}

function buildHunkHashIndexMap(original: string, modified: string): Map<string, number[]> {
  const patch = structuredPatch('file', 'file', original, modified);
  const hunks = patch.hunks ?? [];
  const map = new Map<string, number[]>();
  for (let i = 0; i < hunks.length; i++) {
    const hunk = hunks[i];
    const oldSideContent = hunk.lines
      .filter((l) => !l.startsWith('+'))
      .map((l) => l.slice(1))
      .join('\n');
    const newSideContent = hunk.lines
      .filter((l) => !l.startsWith('-'))
      .map((l) => l.slice(1))
      .join('\n');
    const hash = computeDiffContextHash(oldSideContent, newSideContent);
    const arr = map.get(hash);
    if (arr) arr.push(i);
    else map.set(hash, [i]);
  }
  return map;
}

function mapRejectedHunkIndicesByHash(
  original: string,
  modified: string,
  rejectedIndices: number[],
  hunkContextHashes: Record<number, string>
): number[] {
  const hashMap = buildHunkHashIndexMap(original, modified);
  const out = new Set<number>();

  for (const idx of rejectedIndices) {
    const hash = hunkContextHashes[idx];
    if (!hash) {
      out.add(idx);
      continue;
    }
    const candidates = hashMap.get(hash);
    if (candidates?.length === 1) {
      out.add(candidates[0]);
    } else {
      // Ambiguous or missing — fall back to index to preserve prior behavior.
      out.add(idx);
    }
  }

  return [...out].sort((a, b) => a - b);
}

// ── Module-level helpers ──

/**
 * Invert a single hunk: swap added/removed lines, swap old/new start/lines.
 */
function invertHunk(hunk: StructuredPatchHunk): StructuredPatchHunk {
  const invertedLines = hunk.lines.map((line) => {
    if (line.startsWith('+')) return '-' + line.substring(1);
    if (line.startsWith('-')) return '+' + line.substring(1);
    return line; // context lines remain unchanged
  });

  return {
    oldStart: hunk.newStart,
    oldLines: hunk.newLines,
    newStart: hunk.oldStart,
    newLines: hunk.oldLines,
    lines: invertedLines,
  };
}

/**
 * Three-way merge using node-diff3.
 *
 * @param base   base version (common ancestor)
 * @param ours   "our" version (current state)
 * @param theirs "their" version (desired state)
 * @returns merged content and conflict indicator
 */
function threeWayMerge(
  base: string,
  ours: string,
  theirs: string
): { content: string; hasConflicts: boolean } {
  const regions = diff3Merge(ours, base, theirs);
  let hasConflicts = false;
  const parts: string[] = [];

  for (const region of regions) {
    if (region.ok) {
      parts.push(region.ok.join('\n'));
    } else if (region.conflict) {
      hasConflicts = true;
      // Include conflict markers for visibility
      parts.push('<<<<<<< current');
      parts.push(region.conflict.a.join('\n'));
      parts.push('=======');
      parts.push(region.conflict.b.join('\n'));
      parts.push('>>>>>>> original');
    }
  }

  return {
    content: parts.join('\n'),
    hasConflicts,
  };
}
