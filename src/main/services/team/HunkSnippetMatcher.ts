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

      // Extract added/removed content from hunk
      const addedLines = hunk.lines.filter((l) => l.startsWith('+')).map((l) => l.slice(1));
      const removedLines = hunk.lines.filter((l) => l.startsWith('-')).map((l) => l.slice(1));
      const addedContent = addedLines.join('\n');
      const removedContent = removedLines.join('\n');

      for (let sIdx = 0; sIdx < snippets.length; sIdx++) {
        const snippet = snippets[sIdx];

        // Content overlap: check if snippet's strings appear in hunk's diff content
        if (this.hasContentOverlap(snippet, addedContent, removedContent)) {
          snippetSet.add(sIdx);
        }
      }

      mapping.set(hunkIdx, snippetSet);
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
   * Check if a snippet's content overlaps with hunk's added/removed content.
   */
  private hasContentOverlap(
    snippet: SnippetDiff,
    hunkAddedContent: string,
    hunkRemovedContent: string
  ): boolean {
    // Skip empty snippets
    if (!snippet.newString && !snippet.oldString) return false;

    if (snippet.type === 'write-new' || snippet.type === 'write-update') {
      // For Write: check if hunk's added content is a substring of snippet's newString
      if (snippet.newString && hunkAddedContent) {
        return snippet.newString.includes(hunkAddedContent);
      }
      return false;
    }

    // For Edit/MultiEdit: check bidirectional overlap
    const matchesNew = snippet.newString
      ? hunkAddedContent.includes(snippet.newString) || snippet.newString.includes(hunkAddedContent)
      : false;

    const matchesOld = snippet.oldString
      ? hunkRemovedContent.includes(snippet.oldString) ||
        snippet.oldString.includes(hunkRemovedContent)
      : false;

    // Both directions match = high confidence
    if (matchesNew && matchesOld) return true;

    // Single direction match = acceptable for Edit
    if (matchesNew || matchesOld) return true;

    return false;
  }
}
