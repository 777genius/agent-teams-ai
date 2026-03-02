/**
 * Shared utility for building EditorSelectionInfo from a CodeMirror EditorView.
 *
 * Used by both CodeMirrorEditor (project editor) and CodeMirrorDiffView (review dialog)
 * to extract selection details for the floating action menu.
 */

import type { EditorView } from '@codemirror/view';
import type { EditorSelectionInfo } from '@shared/types/editor';

export const SELECTION_DEBOUNCE_MS = 150;
export const MAX_SELECTION_TEXT = 5000;

/**
 * Build selection info from a CM6 EditorView and selection range.
 * Returns null if selection end is off-screen (coordsAtPos returns null).
 */
export function buildSelectionInfo(
  view: EditorView,
  sel: { from: number; to: number }
): EditorSelectionInfo | null {
  const coords = view.coordsAtPos(sel.to);
  if (!coords) return null;

  let text = view.state.sliceDoc(sel.from, sel.to);
  if (text.length > MAX_SELECTION_TEXT) {
    text = text.slice(0, MAX_SELECTION_TEXT) + '\u2026';
  }

  return {
    text,
    filePath: '', // filled by caller
    fromLine: view.state.doc.lineAt(sel.from).number,
    toLine: view.state.doc.lineAt(sel.to).number,
    screenRect: {
      top: coords.top,
      right: coords.right ?? coords.left,
      bottom: coords.bottom,
    },
  };
}
