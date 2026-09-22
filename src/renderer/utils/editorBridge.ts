/**
 * Module-level singleton bridging Zustand store ↔ CodeMirror refs.
 *
 * CodeMirrorEditor calls register() on mount, unregister() on unmount.
 * Store actions (saveFile, saveAllFiles, closeEditor) use getContent()/destroy().
 *
 * Pattern: analogous to ConfirmDialog.tsx (module-level globalSetState).
 */

import type { EditorState } from '@codemirror/state';
import type { EditorView } from '@codemirror/view';

let stateCache: Map<string, EditorState> | null = null;
let scrollTopCache: Map<string, number> | null = null;
let activeView: EditorView | null = null;

export const editorBridge = {
  /** Called by CodeMirrorEditor on mount */
  register(sc: Map<string, EditorState>, stc: Map<string, number>, view: EditorView): void {
    stateCache = sc;
    scrollTopCache = stc;
    activeView = view;
  },

  /** Called by CodeMirrorEditor on unmount */
  unregister(): void {
    stateCache = null;
    scrollTopCache = null;
    activeView = null;
  },

  /** Check if bridge is registered (HMR guard) */
  get isRegistered(): boolean {
    return stateCache !== null;
  },

  /** Get content for a single file from cached EditorState */
  getContent(filePath: string): string | null {
    return stateCache?.get(filePath)?.doc.toString() ?? null;
  },

  /** Get content for all modified files */
  getAllModifiedContent(modifiedFiles: Record<string, boolean>): Map<string, string> {
    const result = new Map<string, string>();
    for (const fp of Object.keys(modifiedFiles)) {
      if (!modifiedFiles[fp]) continue;
      const content = stateCache?.get(fp)?.doc.toString();
      if (content !== undefined) result.set(fp, content);
    }
    return result;
  },

  /** Remove cached state for a single tab — called by closeTab() */
  deleteState(tabId: string): void {
    stateCache?.delete(tabId);
    scrollTopCache?.delete(tabId);
  },

  /** Full cleanup — called by closeEditor() */
  destroy(): void {
    activeView?.destroy();
    stateCache?.clear();
    scrollTopCache?.clear();
    activeView = null;
  },

  /** Remap cached state from oldPath to newPath (used by moveFileInTree) */
  remapState(oldPath: string, newPath: string): void {
    const state = stateCache?.get(oldPath);
    if (state) {
      stateCache!.delete(oldPath);
      stateCache!.set(newPath, state);
    }
    const scroll = scrollTopCache?.get(oldPath);
    if (scroll !== undefined) {
      scrollTopCache!.delete(oldPath);
      scrollTopCache!.set(newPath, scroll);
    }
  },

  /** Update view reference (on tab switch, view may be recreated) */
  updateView(view: EditorView): void {
    activeView = view;
  },

  /** Get current EditorView (for undo/redo toolbar) */
  getView(): EditorView | null {
    return activeView;
  },
};
