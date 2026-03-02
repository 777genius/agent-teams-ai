import { computeDiffContextHash } from '@shared/utils/diffContextHash';
import { structuredPatch } from 'diff';

import type { SnippetDiff } from '@shared/types';

/**
 * Reliable hunk↔snippet matcher using content overlap analysis.
 *
 * Uses bidirectional substring matching between hunk added/removed lines
 * and snippet newString/oldString to determine which snippets correspond
 * to which diff hunks.
 *
 * Replaces the previous 1:1 hunkIndex→snippetIndex assumption.
 */
export class HunkSnippetMatcher {
  /**
   * Match hunk indices to their corresponding snippets.
   * Returns a Map where each hunk index maps to the set of matching snippet indices.
   *
   * @param snippets — MUST be pre-filtered (no isError entries).
   *   Returned indices are relative to this array.
   */
  matchHunksToSnippets(
    original: string,
    modified: string,
    hunkIndices: number[],
    snippets: SnippetDiff[]
  ): Map<number, Set<number>> {
    if (snippets.length === 0) return new Map();

    const patch = structuredPatch('file', 'file', original, modified);
    if (!patch.hunks || patch.hunks.length === 0) return new Map();

    const mapping = new Map<number, Set<number>>();

    for (const hunkIdx of hunkIndices) {
      if (hunkIdx < 0 || hunkIdx >= patch.hunks.length) continue;
      const hunk = patch.hunks[hunkIdx];
      const snippetSet = new Set<number>();
      const strongMatches = new Set<number>();

      // Reconstruct old/new side of hunk INCLUDING context lines.
      // Context lines (` ` prefix) are critical — without them, snippets whose
      // oldString spans unchanged lines between changed lines can't be matched.
      const oldSideContent = hunk.lines
        .filter((l) => !l.startsWith('+'))
        .map((l) => l.slice(1))
        .join('\n');
      const newSideContent = hunk.lines
        .filter((l) => !l.startsWith('-'))
        .map((l) => l.slice(1))
        .join('\n');

      for (let sIdx = 0; sIdx < snippets.length; sIdx++) {
        const snippet = snippets[sIdx];

        if (this.hasContentOverlap(snippet, oldSideContent, newSideContent)) {
          snippetSet.add(sIdx);
        }

        // Strong match: contextHash matches the hunk's contextual fingerprint.
        // This reduces false positives when repeated patterns exist in a file.
        if (snippet.contextHash) {
          const h = computeDiffContextHash(oldSideContent, newSideContent);
          if (h === snippet.contextHash) {
            strongMatches.add(sIdx);
          }
        }
      }

      mapping.set(hunkIdx, strongMatches.size > 0 ? strongMatches : snippetSet);
    }

    return mapping;
  }

  /**
   * Find the correct position of a snippet's newString in the content,
   * disambiguating when multiple occurrences exist.
   */
  findSnippetPosition(snippet: SnippetDiff, content: string): number {
    const { newString, oldString } = snippet;
    if (!newString) return -1; // Deletion — can't find empty string reliably

    const firstPos = content.indexOf(newString);
    if (firstPos === -1) return -1;

    // Fast path: only one occurrence — no ambiguity
    const lastPos = content.lastIndexOf(newString);
    if (firstPos === lastPos) return firstPos;

    // Multiple occurrences — collect all positions
    const positions: number[] = [];
    let searchStart = 0;
    while (true) {
      const pos = content.indexOf(newString, searchStart);
      if (pos === -1) break;
      positions.push(pos);
      searchStart = pos + 1;
    }

    // Disambiguate using oldString context
    if (oldString) {
      const oldTokens = oldString
        .split(/\s+/)
        .filter((t) => t.length > 3)
        .slice(0, 20); // Limit tokens to prevent excessive scanning

      if (oldTokens.length > 0) {
        let bestPos = firstPos;
        let bestScore = 0;

        for (const pos of positions) {
          const nearbyStart = Math.max(0, pos - 500);
          const nearbyEnd = Math.min(content.length, pos + newString.length + 500);
          const nearby = content.substring(nearbyStart, nearbyEnd);

          const matchScore = oldTokens.filter((t) => nearby.includes(t)).length;
          if (matchScore > bestScore) {
            bestScore = matchScore;
            bestPos = pos;
          }
        }

        return bestPos;
      }
    }

    return firstPos;
  }

  // ── Private helpers ──

  /**
   * Check if a snippet's content overlaps with a hunk's reconstructed file ranges.
   *
   * @param hunkOldSide — reconstructed original file text within hunk range (context + removed lines)
   * @param hunkNewSide — reconstructed modified file text within hunk range (context + added lines)
   */
  private hasContentOverlap(
    snippet: SnippetDiff,
    hunkOldSide: string,
    hunkNewSide: string
  ): boolean {
    if (!snippet.newString && !snippet.oldString) return false;

    if (snippet.type === 'write-new' || snippet.type === 'write-update') {
      // Full-file writes are intentionally excluded from localized hunk↔snippet matching.
      // They are handled by whole-file reject logic or hunk-level inverse patch.
      return false;
    }

    // For Edit/MultiEdit: check if snippet falls within hunk's file range
    const hasOld = snippet.oldString.length > 0;
    const hasNew = snippet.newString.length > 0;
    const matchesOld = hasOld ? hunkOldSide.includes(snippet.oldString) : false;
    const matchesNew = hasNew ? hunkNewSide.includes(snippet.newString) : false;

    // Prefer stricter matching when both sides exist to avoid over-matching.
    if (hasOld && hasNew) return matchesOld && matchesNew;
    if (hasOld) return matchesOld;
    return matchesNew;
  }
}
