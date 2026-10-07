/**
 * Editable CodeMirror 6 editor with EditorState pooling.
 *
 * Single EditorView, Map<filePath, EditorState> in useRef.
 * Cmd+S keymap, debounced dirty flag, draft autosave to localStorage.
 * LRU eviction at >30 cached states.
 */

import { useCallback, useEffect, useRef } from 'react';

import { defaultKeymap, history, historyKeymap, redo, undo } from '@codemirror/commands';
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  indentOnInput,
  syntaxHighlighting,
} from '@codemirror/language';
import { gotoLine, search, searchKeymap } from '@codemirror/search';
import { Compartment, EditorState, StateEffect, Text } from '@codemirror/state';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import {
  EditorView,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers,
} from '@codemirror/view';
import {
  createSearchPanel,
  editorSearchPanelTheme,
} from '@renderer/components/team/editor/EditorSearchPanel';
import { useStore } from '@renderer/store';
import {
  getAsyncLanguageDesc,
  getSyncLanguageExtension,
} from '@renderer/utils/codemirrorLanguages';
import { buildSelectionInfo, SELECTION_DEBOUNCE_MS } from '@renderer/utils/codemirrorSelectionInfo';
import { baseEditorTheme } from '@renderer/utils/codemirrorTheme';
import { editorBridge } from '@renderer/utils/editorBridge';
import { EDITOR_DRAFT_MAX_CHARS } from '@shared/editorPolicy';

import type { Extension } from '@codemirror/state';
import type { EditorDocumentMode } from '@shared/editorPolicy';
import type { EditorSelectionInfo } from '@shared/types/editor';

// =============================================================================
// Constants
// =============================================================================

const AUTOSAVE_DELAY_MS = 30_000;
const MAX_DRAFT_SIZE = EDITOR_DRAFT_MAX_CHARS;
const MAX_DRAFTS = 10;
/** Compartment for dynamic line wrap toggling */
const lineWrapCompartment = new Compartment();

// =============================================================================
// Types
// =============================================================================

interface CodeMirrorEditorProps {
  /** Currently active file path (tab id) */
  filePath: string;
  /** Initial content to load if no cached state exists */
  content: string;
  /** File name for language detection */
  fileName: string;
  /** File modification time (for draft comparison) */
  mtimeMs?: number;
  mode?: EditorDocumentMode;
  readOnly?: boolean;
  /** Cursor position callback for status bar */
  onCursorChange?: (line: number, col: number) => void;
  /** Called when a draft was recovered from localStorage */
  onDraftRecovered?: (filePath: string) => void;
  /** Called when text selection changes (for floating action menu) */
  onSelectionChange?: (info: EditorSelectionInfo | null) => void;
  /** Called with the current document text on changes (debounced, for live preview) */
  onDocChange?: (content: string) => void;
}

// =============================================================================
// Extensions builder
// =============================================================================

function buildEditableExtensions(
  fileName: string,
  onSave: () => void,
  onUpdate: () => void,
  onCursorMove: (line: number, col: number) => void,
  onSelectionEmit: (info: EditorSelectionInfo | null) => void,
  onScrollReposition: (info: EditorSelectionInfo | null) => void,
  reduced: boolean,
  readOnly: boolean
): Extension[] {
  const syncLang = reduced ? null : getSyncLanguageExtension(fileName);
  const asyncLang = reduced ? null : getAsyncLanguageDesc(fileName);

  const extensions: Extension[] = [
    // Theme
    baseEditorTheme,
    ...(reduced ? [] : [syntaxHighlighting(oneDarkHighlightStyle)]),
    EditorState.readOnly.of(readOnly),
    EditorView.editable.of(!readOnly),
    EditorView.clipboardInputFilter.of((text, state) => text.replace(/\r\n|\r|\n/g, state.lineBreak)),
    ...(readOnly ? [EditorState.transactionFilter.of((transaction) => transaction.docChanged ? [] : transaction)] : []),

    // UI
    lineNumbers(),
    highlightActiveLine(),
    highlightActiveLineGutter(),
    ...(reduced ? [] : [bracketMatching(), indentOnInput(), foldGutter()]),

    // History
    history(),

    // Search (Cmd+F) — custom panel with UI Kit
    search({ createPanel: createSearchPanel }),
    editorSearchPanelTheme,

    // Save keymap (Cmd+S / Ctrl+S)
    keymap.of([
      {
        key: 'Mod-s',
        run: () => {
          onSave();
          return true;
        },
      },
      // Undo/Redo already in historyKeymap, but explicitly add for toolbar
      {
        key: 'Mod-z',
        run: (view) => undo(view),
      },
      {
        key: 'Mod-Shift-z',
        run: (view) => redo(view),
      },
    ]),

    // Keymaps
    // Filter out built-in gotoLine (Alt-g) — replaced by custom GoToLineDialog
    keymap.of([
      ...defaultKeymap,
      ...historyKeymap,
      ...searchKeymap.filter((k) => k.run !== gotoLine),
      ...(reduced ? [] : foldKeymap),
    ]),

    // Update listener for dirty flag + cursor position + selection
    EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        onUpdate();
      }
      if (update.selectionSet || update.docChanged) {
        const pos = update.state.selection.main.head;
        const line = update.state.doc.lineAt(pos);
        onCursorMove(line.number, pos - line.from + 1);

        // Selection change detection
        const sel = update.state.selection.main;
        if (sel.empty) {
          onSelectionEmit(null);
        } else {
          onSelectionEmit(buildSelectionInfo(update.view, sel));
        }
      }
    }),

    // Re-emit selection coords on scroll — immediate (no debounce) to avoid drift
    EditorView.domEventHandlers({
      scroll: (_event, view) => {
        const sel = view.state.selection.main;
        if (sel.empty) return;
        onScrollReposition(buildSelectionInfo(view, sel));
      },
    }),
  ];

  if (syncLang) {
    extensions.push(syncLang);
  } else if (asyncLang) {
    extensions.push(asyncLang.support ?? []);
  }

  return extensions;
}

// =============================================================================
// Draft autosave helpers
// =============================================================================

function saveDraft(filePath: string, content: string): void {
  try {
    if (content.length > MAX_DRAFT_SIZE) return;

    const key = `editor-draft:${filePath}`;
    const value = JSON.stringify({ content, timestamp: Date.now() });
    localStorage.setItem(key, value);

    // Enforce max drafts limit
    enforceDraftLimit();
  } catch {
    // localStorage may be full or unavailable
  }
}

function enforceDraftLimit(): void {
  try {
    const drafts: { key: string; timestamp: number }[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const key = localStorage.key(i);
      if (!key?.startsWith('editor-draft:')) continue;
      try {
        const parsed = JSON.parse(localStorage.getItem(key)!) as { timestamp: number };
        drafts.push({ key, timestamp: parsed.timestamp });
      } catch {
        // corrupted draft — remove
        localStorage.removeItem(key);
      }
    }

    if (drafts.length > MAX_DRAFTS) {
      drafts.sort((a, b) => a.timestamp - b.timestamp);
      const toRemove = drafts.slice(0, drafts.length - MAX_DRAFTS);
      for (const d of toRemove) {
        localStorage.removeItem(d.key);
      }
    }
  } catch {
    // ignore
  }
}

// =============================================================================
// Component
// =============================================================================

const DOC_CHANGE_DEBOUNCE_MS = 150;

export const CodeMirrorEditor = ({
  filePath,
  content,
  fileName,
  mtimeMs,
  mode,
  readOnly = false,
  onCursorChange,
  onDraftRecovered,
  onSelectionChange,
  onDocChange,
}: CodeMirrorEditorProps): React.ReactElement => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const reduced = mode === 'large' || readOnly;
  const stateCacheRef = useRef(editorBridge.states);
  const scrollTopCacheRef = useRef(editorBridge.scrolls);

  // Autosave debounce
  const autosaveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Selection debounce
  const selectionTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Doc change debounce (live preview)
  const docChangeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const markFileModified = useStore((s) => s.markFileModified);
  const saveFile = useStore((s) => s.saveFile);
  const lineWrap = useStore((s) => s.editorLineWrap);

  // Stable callbacks via refs to avoid extension recreation
  const filePathRef = useRef(filePath);
  filePathRef.current = filePath;

  const onCursorChangeRef = useRef(onCursorChange);
  onCursorChangeRef.current = onCursorChange;

  const onDraftRecoveredRef = useRef(onDraftRecovered);
  onDraftRecoveredRef.current = onDraftRecovered;

  const onSelectionChangeRef = useRef(onSelectionChange);
  onSelectionChangeRef.current = onSelectionChange;

  const onDocChangeRef = useRef(onDocChange);
  onDocChangeRef.current = onDocChange;

  const lineWrapRef = useRef(lineWrap);
  lineWrapRef.current = lineWrap;

  const handleSave = useCallback(() => {
    void saveFile(filePathRef.current);
  }, [saveFile]);

  const handleDocChanged = useCallback(() => {
    // Synchronous dirty state protects rapid save/tab-close before a debounce fires.
    if (readOnly) return;
    markFileModified(filePathRef.current);
    // Debounced autosave
    if (autosaveTimerRef.current) clearTimeout(autosaveTimerRef.current);
    autosaveTimerRef.current = setTimeout(() => {
      const view = viewRef.current;
      if (view && view.state.doc.length <= MAX_DRAFT_SIZE) {
        saveDraft(filePathRef.current, view.state.sliceDoc());
      }
    }, AUTOSAVE_DELAY_MS);

    // Live content callback for markdown preview
    if (docChangeTimerRef.current) clearTimeout(docChangeTimerRef.current);
    docChangeTimerRef.current = setTimeout(() => {
      const view = viewRef.current;
      if (view && !reduced && onDocChangeRef.current) onDocChangeRef.current(view.state.sliceDoc());
    }, DOC_CHANGE_DEBOUNCE_MS);
  }, [markFileModified, readOnly, reduced]);

  const handleCursorMove = useCallback((line: number, col: number) => {
    onCursorChangeRef.current?.(line, col);
  }, []);

  const handleSelectionEmit = useCallback((info: EditorSelectionInfo | null) => {
    if (!info) {
      // Empty selection — clear immediately
      if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
      onSelectionChangeRef.current?.(null);
      return;
    }

    // Non-empty selection — debounce to prevent flicker during rapid selection changes
    if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
    selectionTimerRef.current = setTimeout(() => {
      // Enrich with filePath (not available inside extension builder)
      onSelectionChangeRef.current?.({ ...info, filePath: filePathRef.current });
    }, SELECTION_DEBOUNCE_MS);
  }, []);

  // Immediate position update during scroll — no debounce to avoid menu drift
  const handleScrollReposition = useCallback((info: EditorSelectionInfo | null) => {
    if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
    if (info) {
      onSelectionChangeRef.current?.({ ...info, filePath: filePathRef.current });
    } else {
      onSelectionChangeRef.current?.(null);
    }
  }, []);

  // Mount: create EditorView, register bridge
  useEffect(() => {
    if (!containerRef.current) return;

    const extensions = buildEditableExtensions(
      fileName,
      handleSave,
      handleDocChanged,
      handleCursorMove,
      handleSelectionEmit,
      handleScrollReposition,
      reduced,
      readOnly
    );

    // Line wrap (dynamically reconfigurable via Compartment)
    extensions.push(lineWrapCompartment.of(!reduced && lineWrapRef.current ? EditorView.lineWrapping : []));

    // Check for cached state or draft recovery
    editorBridge.prepareState(filePath, mtimeMs, readOnly, !!useStore.getState().editorModifiedFiles[filePath] || !!useStore.getState().editorSaving[filePath]);
    let initialState = stateCacheRef.current.get(filePath);
    if (initialState) initialState = initialState.update({ effects: StateEffect.reconfigure.of([extensions, EditorState.lineSeparator.of(initialState.lineBreak)]) }).state;
    if (!initialState) {
      let initialContent = content;
      let draftRecovered = false;

      // Draft recovery: compare draft.timestamp with file mtimeMs
      try {
        const draftJson = !readOnly && !reduced ? localStorage.getItem(`editor-draft:${filePath}`) : null;
        if (draftJson) {
          const draft = JSON.parse(draftJson) as { content: string; timestamp: number };
          const fileMtime = mtimeMs ?? 0;

          if (typeof draft.content === 'string' && draft.content.length <= MAX_DRAFT_SIZE &&
              (fileMtime === 0 || draft.timestamp > fileMtime)) {
            // Draft is newer than file (or file is new) — recover draft
            initialContent = draft.content;
            draftRecovered = true;
          } else {
            // File was modified after draft — draft is stale, delete silently
            localStorage.removeItem(`editor-draft:${filePath}`);
          }
        }
      } catch {
        // ignore
      }

      const lineSeparator = content.includes('\r\n') ? '\r\n'
        : content.includes('\r') && !content.includes('\n') ? '\r' : '\n';
      initialState = EditorState.create({
        // Parse every input newline independently of the uniform serialization separator.
        doc: Text.of(initialContent.split(/\r\n|\r|\n/)),
        extensions: [extensions, EditorState.lineSeparator.of(lineSeparator)],
      });
      stateCacheRef.current.set(filePath, initialState);

      // Signal draft recovery after state creation
      if (draftRecovered) {
        // Mark as modified so dirty indicator shows
        markFileModified(filePath);
        onDraftRecoveredRef.current?.(filePath);
      }
    }

    const sessionState = useStore.getState();
    editorBridge.touchState(filePath, { ...sessionState.editorModifiedFiles, ...sessionState.editorSaving });

    const view = new EditorView({
      state: initialState,
      parent: containerRef.current,
    });

    // Restore scroll position
    const savedScroll = scrollTopCacheRef.current.get(filePath);
    if (savedScroll !== undefined) {
      view.scrollDOM.scrollTop = savedScroll;
    }

    viewRef.current = view;

    // Register with bridge
    stateCacheRef.current.set(filePath, initialState);
    editorBridge.register(stateCacheRef.current, scrollTopCacheRef.current, view, filePath);

    // Report initial cursor position
    const pos = view.state.selection.main.head;
    const line = view.state.doc.lineAt(pos);
    onCursorChangeRef.current?.(line.number, pos - line.from + 1);

    // Capture ref values for cleanup — React hooks exhaustive-deps requires
    // refs used in cleanup to be captured in the effect body, not read
    // from .current inside the cleanup function.
    const revision = editorBridge.revision(filePath);
    const scrollTopCache = scrollTopCacheRef.current;
    const stateCache = stateCacheRef.current;
    const autosaveTimer = autosaveTimerRef;
    const selectionTimer = selectionTimerRef;
    const docChangeTimer = docChangeTimerRef;

    return () => {
      // Save scroll position before destroying
      if (editorBridge.revision(filePath) === revision) {
        scrollTopCache.set(filePath, view.scrollDOM.scrollTop);
        stateCache.set(filePath, view.state);
      }

      // Clear timers
      if (autosaveTimer.current) clearTimeout(autosaveTimer.current);
      if (selectionTimer.current) clearTimeout(selectionTimer.current);
      if (docChangeTimer.current) clearTimeout(docChangeTimer.current);

      editorBridge.releaseView(view);
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- Intentional: only re-mount when filePath changes (tab switch). Content/fileName changes with the same filePath should use the cached state.
  }, [filePath]);

  // Sync line wrap setting dynamically (including cached states on tab switch)
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: lineWrapCompartment.reconfigure(!reduced && lineWrap ? EditorView.lineWrapping : []),
    });
  }, [lineWrap, reduced]);

  // Publish cached/draft text on tab return and when preview is enabled, including empty text.
  useEffect(() => {
    const view = viewRef.current;
    if (view && !reduced && onDocChange) onDocChange(view.state.sliceDoc());
  }, [filePath, onDocChange, reduced]);

  // Scroll to pending line (from search-in-files result click)
  const pendingGoToLine = useStore((s) => s.editorPendingGoToLine);
  const setPendingGoToLine = useStore((s) => s.setPendingGoToLine);
  useEffect(() => {
    const view = viewRef.current;
    if (!view || !pendingGoToLine) return;

    const lineCount = view.state.doc.lines;
    const targetLine = Math.min(Math.max(1, pendingGoToLine), lineCount);
    const lineInfo = view.state.doc.line(targetLine);

    view.dispatch({
      selection: { anchor: lineInfo.from },
      effects: EditorView.scrollIntoView(lineInfo.from, { y: 'center' }),
    });

    setPendingGoToLine(null);
  }, [pendingGoToLine, setPendingGoToLine, filePath]);

  return <div ref={containerRef} data-editor-file={filePath} className="size-full overflow-hidden" />;
};
