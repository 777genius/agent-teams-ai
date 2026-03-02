import { invertedEffects } from '@codemirror/commands';
import {
  acceptChunk,
  getChunks,
  getOriginalDoc,
  originalDocChangeEffect,
  rejectChunk,
  updateOriginalDoc,
} from '@codemirror/merge';
import { ChangeSet, type ChangeSpec, EditorState, type StateEffect } from '@codemirror/state';
import { type EditorView } from '@codemirror/view';
import { computeDiffContextHash } from '@shared/utils/diffContextHash';
import { structuredPatch } from 'diff';

/**
 * Teaches CM history to undo acceptChunk operations (updateOriginalDoc effects).
 * Without this, Cmd+Z only works for rejectChunk (document changes) but not acceptChunk.
 */
export const mergeUndoSupport = invertedEffects.of((tr) => {
  const effects: StateEffect<unknown>[] = [];
  for (const effect of tr.effects) {
    if (effect.is(updateOriginalDoc)) {
      const prevOriginal = getOriginalDoc(tr.startState);
      const inverseSpecs: ChangeSpec[] = [];
      effect.value.changes.iterChanges((fromA: number, toA: number, fromB: number, toB: number) => {
        inverseSpecs.push({
          from: fromB,
          to: toB,
          insert: prevOriginal.sliceString(fromA, toA),
        });
      });
      const inverseChanges = ChangeSet.of(inverseSpecs, effect.value.doc.length);
      effects.push(updateOriginalDoc.of({ doc: prevOriginal, changes: inverseChanges }));
    }
  }
  return effects;
});

/** Accept all remaining chunks in one transaction (single Cmd+Z to undo) */
export function acceptAllChunks(view: EditorView): boolean {
  const result = getChunks(view.state);
  if (!result || result.chunks.length === 0) return false;

  const orig = getOriginalDoc(view.state);
  // More robust than per-chunk: merge chunk ranges can be inconsistent for "empty" originals
  // (e.g. whitespace-only or reconstruction edge cases), which can throw RangeError.
  // Accept-all semantics are simply: make original equal to current modified doc.
  const changes = ChangeSet.of(
    [{ from: 0, to: orig.length, insert: view.state.doc.toString() }],
    orig.length
  );
  view.dispatch({
    effects: updateOriginalDoc.of({ doc: changes.apply(orig), changes }),
  });
  return true;
}

/** Reject all remaining chunks in one transaction (single Cmd+Z to undo) */
export function rejectAllChunks(view: EditorView): boolean {
  const result = getChunks(view.state);
  if (!result || result.chunks.length === 0) return false;

  const orig = getOriginalDoc(view.state);
  // Same robustness principle as acceptAllChunks: reject-all semantics are simply
  // "restore the current doc to the original baseline" in one edit.
  view.dispatch({
    changes: [{ from: 0, to: view.state.doc.length, insert: orig.toString() }],
  });
  return true;
}

/**
 * After all diff chunks are accepted, mirrors user edits to the original doc
 * so no new diffs appear. Makes editing feel like a regular editor (Cursor-like).
 */
export const mirrorEditsAfterResolve = EditorState.transactionExtender.of((tr) => {
  if (!tr.docChanged) return null;

  // Skip if transaction already updates original (undo/redo inverse, explicit accept)
  if (tr.effects.some((e) => e.is(updateOriginalDoc))) return null;

  // Only mirror when ALL chunks are resolved
  const result = getChunks(tr.startState);
  if (!result || result.chunks.length > 0) return null;

  // Mirror edit to original doc (same ChangeSet applies because original === modified)
  return { effects: originalDocChangeEffect(tr.startState, tr.changes) };
});

/**
 * Replay persisted per-hunk decisions on a freshly mounted editor.
 * Processes chunks in reverse order to preserve earlier chunk positions.
 */
export function replayHunkDecisions(
  view: EditorView,
  filePath: string,
  hunkDecisions: Record<string, string>
): void {
  const result = getChunks(view.state);
  if (!result || result.chunks.length === 0) return;

  // Collect decisions that need replaying
  const toReplay: { index: number; decision: 'accepted' | 'rejected' }[] = [];
  for (let i = 0; i < result.chunks.length; i++) {
    const key = `${filePath}:${i}`;
    const d = hunkDecisions[key];
    if (d === 'accepted' || d === 'rejected') {
      toReplay.push({ index: i, decision: d });
    }
  }

  if (toReplay.length === 0) return;

  // Process in reverse order — removing a later chunk doesn't shift earlier positions
  for (let i = toReplay.length - 1; i >= 0; i--) {
    const { index, decision } = toReplay[i];
    const currentChunks = getChunks(view.state);
    if (!currentChunks || index >= currentChunks.chunks.length) continue;

    const chunk = currentChunks.chunks[index];
    if (decision === 'accepted') {
      acceptChunk(view, chunk.fromB);
    } else {
      rejectChunk(view, chunk.fromB);
    }
  }
}

/**
 * Replay persisted decisions, attempting to map original hunk indices to the current
 * CodeMirror chunk indices using context hashes when available.
 *
 * Falls back to index-based replay when hashes are missing or ambiguous.
 */
export function replayHunkDecisionsSmart(
  view: EditorView,
  filePath: string,
  hunkDecisions: Record<string, string>,
  hunkContextHashes?: Record<number, string>
): void {
  const result = getChunks(view.state);
  if (!result || result.chunks.length === 0) return;

  const chunkCount = result.chunks.length;

  // Build current hunk hash -> indices map (only if we can build a patch that matches chunk count)
  let hashToIndices: Map<string, number[]> | null = null;
  if (hunkContextHashes && Object.keys(hunkContextHashes).length > 0) {
    const original = getOriginalDoc(view.state).toString();
    const modified = view.state.doc.toString();
    const patch = structuredPatch('file', 'file', original, modified);
    const hunks = patch.hunks ?? [];
    if (hunks.length === chunkCount) {
      hashToIndices = new Map<string, number[]>();
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
        const arr = hashToIndices.get(hash);
        if (arr) arr.push(i);
        else hashToIndices.set(hash, [i]);
      }
    }
  }

  // Collect all decided indices from the decision map (don't assume contiguous 0..N)
  const prefix = `${filePath}:`;
  const decided: { mappedIndex: number; decision: 'accepted' | 'rejected' }[] = [];
  const usedMapped = new Set<number>();

  for (const [key, val] of Object.entries(hunkDecisions)) {
    if (!key.startsWith(prefix)) continue;
    if (val !== 'accepted' && val !== 'rejected') continue;
    const raw = key.slice(prefix.length);
    const origIndex = Number.parseInt(raw, 10);
    if (Number.isNaN(origIndex)) continue;

    let mappedIndex = origIndex;
    const hash = hunkContextHashes?.[origIndex];
    if (hash && hashToIndices) {
      const candidates = hashToIndices.get(hash);
      if (candidates?.length === 1) {
        mappedIndex = candidates[0];
      }
    }

    if (mappedIndex < 0 || mappedIndex >= chunkCount) continue;
    if (usedMapped.has(mappedIndex)) continue;
    usedMapped.add(mappedIndex);
    decided.push({ mappedIndex, decision: val });
  }

  if (decided.length === 0) return;

  // Replay from later to earlier indices so chunk removals don't shift earlier ones.
  decided.sort((a, b) => b.mappedIndex - a.mappedIndex);

  for (const { mappedIndex, decision } of decided) {
    const currentChunks = getChunks(view.state);
    if (!currentChunks || mappedIndex >= currentChunks.chunks.length) continue;
    const chunk = currentChunks.chunks[mappedIndex];
    if (decision === 'accepted') {
      acceptChunk(view, chunk.fromB);
    } else {
      rejectChunk(view, chunk.fromB);
    }
  }
}

/**
 * Compute the chunk index at a given position in the modified document (B-side).
 * Returns the index of the chunk containing pos, or the nearest chunk when pos is outside.
 */
export function computeChunkIndexAtPos(state: EditorState, pos: number): number {
  const chunks = getChunks(state);
  if (!chunks || chunks.chunks.length === 0) return 0;

  let nearestIndex = 0;
  let nearestDist = Infinity;

  for (let i = 0; i < chunks.chunks.length; i++) {
    const chunk = chunks.chunks[i];
    if (pos >= chunk.fromB && pos <= chunk.toB) return i;
    const dist = Math.min(Math.abs(pos - chunk.fromB), Math.abs(pos - chunk.toB));
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestIndex = i;
    }
  }

  return nearestIndex;
}

export { acceptChunk, getChunks, rejectChunk };
