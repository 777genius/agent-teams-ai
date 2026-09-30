import { useEffect } from 'react';

import { redoDepth, undoDepth } from '@codemirror/commands';

import type { EditorView } from '@codemirror/view';

export interface ChangeReviewKeyboardEditorContext {
  editor: EditorView | null;
  hasDraft: boolean;
}

interface UseChangeReviewHistoryKeyboardShortcutsInput {
  active: boolean;
  editedCount: number;
  resolveEditorContext: (target: Element | null) => ChangeReviewKeyboardEditorContext;
  hasActionInFlight: () => boolean;
  getUndoCount: () => number;
  getRedoCount: () => number;
  undoLatest: () => Promise<void>;
  redoLatest: () => Promise<void>;
  reportManualDraftBlock: () => void;
}

export function useChangeReviewHistoryKeyboardShortcuts({
  active,
  editedCount,
  resolveEditorContext,
  hasActionInFlight,
  getUndoCount,
  getRedoCount,
  undoLatest,
  redoLatest,
  reportManualDraftBlock,
}: UseChangeReviewHistoryKeyboardShortcutsInput): void {
  useEffect(() => {
    if (!active) return;
    const handler = (event: KeyboardEvent): void => {
      if (!(event.metaKey || event.ctrlKey)) return;
      const isRedoShortcut =
        (event.code === 'KeyZ' && event.shiftKey) || (event.code === 'KeyY' && !event.shiftKey);
      const isUndoShortcut = event.code === 'KeyZ' && !event.shiftKey;
      if (!isUndoShortcut && !isRedoShortcut) return;

      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const { editor, hasDraft } = resolveEditorContext(document.activeElement);

      if (isRedoShortcut) {
        if (editor && redoDepth(editor.state) > 0) return;
        if (hasDraft) return;
        event.preventDefault();
        event.stopPropagation();
        if (hasActionInFlight() || editedCount > 0) return;
        if (getRedoCount() > 0) void redoLatest();
        return;
      }

      if (editor && undoDepth(editor.state) > 0 && (hasDraft || getUndoCount() === 0)) return;
      if (hasDraft) return;
      if (hasActionInFlight()) {
        event.preventDefault();
        event.stopPropagation();
        return;
      }

      if (getUndoCount() > 0) {
        event.preventDefault();
        event.stopPropagation();
        if (editedCount > 0) {
          reportManualDraftBlock();
          return;
        }
        void undoLatest();
        return;
      }

      // Native CodeMirror Undo would mutate only the visual document and
      // desynchronize it from the durable decision timeline.
      event.preventDefault();
      event.stopPropagation();
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [
    active,
    editedCount,
    getRedoCount,
    getUndoCount,
    hasActionInFlight,
    redoLatest,
    reportManualDraftBlock,
    resolveEditorContext,
    undoLatest,
  ]);
}
