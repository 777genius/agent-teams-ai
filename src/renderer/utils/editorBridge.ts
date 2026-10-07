/**
 * Module-level singleton bridging Zustand store ↔ CodeMirror refs.
 *
 * CodeMirrorEditor calls register() on mount, unregister() on unmount.
 * Store actions (saveFile, saveAllFiles, closeEditor) use getContent()/destroy().
 *
 * Pattern: analogous to ConfirmDialog.tsx (module-level globalSetState).
 */

import { EditorState } from '@codemirror/state';

import type { EditorView } from '@codemirror/view';

export interface EditorSaveSnapshot {
  content: string;
  document: EditorState['doc'];
  revision: string;
  session: number;
}

const states = new Map<string, EditorState>();
const scrolls = new Map<string, number>();
let sessionRevision = 0;
const revisions = new Map<string, number>();
const origins = new Map<string, { mtimeMs?: number; readOnly: boolean }>();
let stateCache: Map<string, EditorState> | null = states;
let scrollTopCache: Map<string, number> | null = scrolls;
let activeFilePath: string | null = null;
let activeView: EditorView | null = null;

export const editorBridge = {
  states,
  scrolls,
  revision(filePath: string): string { return `${sessionRevision}:${revisions.get(filePath) ?? 0}`; },
  /** Reuse dirty state; refresh clean state when the on-disk baseline/mode changes. */
  prepareState(filePath: string, mtimeMs: number | undefined, readOnly: boolean, dirty: boolean): void {
    const previous = origins.get(filePath);
    if (!dirty && previous && (previous.mtimeMs !== mtimeMs || previous.readOnly !== readOnly)) {
      this.deleteState(filePath);
    }
    origins.set(filePath, { mtimeMs, readOnly });
  },
  touchState(filePath: string, modified: Record<string, boolean>): void {
    const state = states.get(filePath);
    if (state) { states.delete(filePath); states.set(filePath, state); }
    let chars = [...states.values()].reduce((sum, entry) => sum + entry.doc.length, 0);
    for (const [key, entry] of states) {
      if (states.size <= 30 && chars * 2 <= 64 * 1024 * 1024) break;
      if (key === filePath || modified[key]) continue;
      chars -= entry.doc.length;
      this.deleteState(key);
    }
  },
  updateBaseline(filePath: string, mtimeMs: number): void {
    const origin = origins.get(filePath);
    if (origin) origins.set(filePath, { ...origin, mtimeMs });
  },
  releaseView(view: EditorView): void {
    if (activeView === view) { activeView = null; activeFilePath = null; }
  },
  /** Called by CodeMirrorEditor on mount */
  register(sc: Map<string, EditorState>, stc: Map<string, number>, view: EditorView, filePath?: string): void {
    stateCache = sc;
    scrollTopCache = stc;
    activeView = view;
    activeFilePath = filePath ?? null;
  },

  /** Called by CodeMirrorEditor on unmount */
  unregister(): void {
    activeView = null;
    activeFilePath = null;
  },

  /** Check if bridge is registered (HMR guard) */
  get isRegistered(): boolean {
    return stateCache !== null;
  },

  captureSave(filePath: string): EditorSaveSnapshot | null {
    const state = activeView && activeFilePath === filePath ? activeView.state : stateCache?.get(filePath);
    if (!state || state.facet(EditorState.readOnly)) return null;
    return { content: state.sliceDoc(), document: state.doc, revision: this.revision(filePath), session: sessionRevision };
  },
  matchesSaveSession(snapshot: EditorSaveSnapshot): boolean {
    return snapshot.session === sessionRevision;
  },
  matchesSaveTarget(filePath: string, snapshot: EditorSaveSnapshot): boolean {
    return this.revision(filePath) === snapshot.revision;
  },
  matchesSaveDocument(filePath: string, snapshot: EditorSaveSnapshot): boolean {
    const state = activeView && activeFilePath === filePath ? activeView.state : stateCache?.get(filePath);
    return this.matchesSaveTarget(filePath, snapshot) && state?.doc === snapshot.document;
  },
  /** Get content for a single file from cached EditorState */
  getContent(filePath: string): string | null {
    const state = activeView && activeFilePath === filePath ? activeView.state : stateCache?.get(filePath);
    // Read-only preview protection also covers direct store/bridge save callers.
    return state && !state.facet(EditorState.readOnly) ? state.sliceDoc() : null;
  },

  /** Get content for all modified files */
  getAllModifiedContent(modifiedFiles: Record<string, boolean>): Map<string, string> {
    const result = new Map<string, string>();
    for (const fp of Object.keys(modifiedFiles)) {
      if (!modifiedFiles[fp]) continue;
      const content = this.getContent(fp);
      if (content !== null) result.set(fp, content);
    }
    return result;
  },

  /** Remove cached state for a single tab — called by closeTab() */
  deleteState(tabId: string): void {
    revisions.set(tabId, (revisions.get(tabId) ?? 0) + 1);
    stateCache?.delete(tabId);
    origins.delete(tabId);
    scrollTopCache?.delete(tabId);
  },

  /** Full cleanup — called by closeEditor() */
  destroy(): void {
    sessionRevision++;
    revisions.clear();
    activeView?.destroy();
    stateCache?.clear();
    scrollTopCache?.clear();
    origins.clear();
    states.clear();
    scrolls.clear();
    stateCache = states;
    scrollTopCache = scrolls;
    activeView = null;
    activeFilePath = null;
  },

  /** Remap cached state from oldPath to newPath (used by moveFileInTree) */
  remapState(oldPath: string, newPath: string): void {
    const isActive = activeView && activeFilePath === oldPath;
    const state = isActive ? activeView!.state : stateCache?.get(oldPath);
    if (!state) return; // rename callers may remap the same path twice
    const scroll = isActive ? activeView!.scrollDOM.scrollTop : scrollTopCache?.get(oldPath);
    const origin = origins.get(oldPath);
    revisions.set(oldPath, (revisions.get(oldPath) ?? 0) + 1);
    stateCache!.delete(oldPath);
    stateCache!.set(newPath, state);
    scrollTopCache?.delete(oldPath);
    if (scroll !== undefined) scrollTopCache?.set(newPath, scroll);
    if (origin) { origins.delete(oldPath); origins.set(newPath, origin); }
    if (isActive) activeFilePath = newPath;
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
