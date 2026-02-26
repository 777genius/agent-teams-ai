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
  const specs: ChangeSpec[] = [];
  for (const chunk of result.chunks) {
    specs.push({
      from: chunk.fromA,
      to: chunk.toA,
      insert: view.state.doc.sliceString(chunk.fromB, chunk.toB),
    });
  }
  const changes = ChangeSet.of(specs, orig.length);
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
  const specs: ChangeSpec[] = [];
  for (const chunk of result.chunks) {
    specs.push({
      from: chunk.fromB,
      to: chunk.toB,
      insert: orig.sliceString(chunk.fromA, chunk.toA),
    });
  }
  view.dispatch({ changes: specs });
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

export { acceptChunk, getChunks, rejectChunk };
