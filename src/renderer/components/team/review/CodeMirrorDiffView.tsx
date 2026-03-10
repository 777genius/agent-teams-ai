import React, { useCallback, useEffect, useRef } from 'react';

import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands';
import { foldGutter, foldKeymap, indentUnit, syntaxHighlighting } from '@codemirror/language';
import { goToNextChunk, goToPreviousChunk, unifiedMergeView } from '@codemirror/merge';
import { Compartment, EditorState, type Extension } from '@codemirror/state';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { EditorView, keymap, lineNumbers } from '@codemirror/view';
import {
  getAsyncLanguageDesc,
  getSyncLanguageExtension,
} from '@renderer/utils/codemirrorLanguages';
import { buildSelectionInfo } from '@renderer/utils/codemirrorSelectionInfo';
import { baseEditorTheme } from '@renderer/utils/codemirrorTheme';

import {
  acceptChunk,
  getChunks,
  mergeUndoSupport,
  mirrorEditsAfterResolve,
  rejectChunk,
} from './CodeMirrorDiffUtils';
import { portionCollapseExtension } from './portionCollapse';

import type { EditorSelectionInfo } from '@shared/types/editor';

interface CodeMirrorDiffViewProps {
  original: string;
  modified: string;
  fileName: string;
  maxHeight?: string;
  readOnly?: boolean;
  showMergeControls?: boolean;
  collapseUnchanged?: boolean;
  collapseMargin?: number;
  onHunkAccepted?: (hunkIndex: number) => void;
  onHunkRejected?: (hunkIndex: number) => void;
  /** Called when the user scrolls to the end of the diff (auto-viewed) */
  onFullyViewed?: () => void;
  /** Ref to expose the EditorView for external navigation */
  editorViewRef?: React.RefObject<EditorView | null>;
  /** Called whenever the internal EditorView is created or destroyed */
  onViewChange?: (view: EditorView | null) => void;
  /** Called when editor content changes (debounced, only when readOnly=false) */
  onContentChanged?: (content: string) => void;
  /** Cached EditorState to restore (preserves undo history between file switches) */
  initialState?: EditorState;
  /** Use portion collapse instead of CM's collapseUnchanged (Expand N / Expand All buttons) */
  usePortionCollapse?: boolean;
  /** Lines per "Expand N" click (only with usePortionCollapse). Default: 100 */
  portionSize?: number;
  /** Called when text selection changes (for floating action menu) */
  onSelectionChange?: (info: EditorSelectionInfo | null) => void;
}

/** Compute hunk index for the chunk at a given position (B-side / modified doc).
 *  If the position falls inside a chunk, returns that chunk's index.
 *  Otherwise returns the nearest chunk by distance (avoids defaulting to 0). */
function computeHunkIndexAtPos(state: EditorState, pos: number): number {
  const chunks = getChunks(state);
  if (!chunks || chunks.chunks.length === 0) return 0;

  let nearestIndex = 0;
  let nearestDist = Infinity;

  let index = 0;
  for (const chunk of chunks.chunks) {
    // Exact match — position is inside this chunk
    if (pos >= chunk.fromB && pos <= chunk.toB) {
      return index;
    }
    // Track nearest chunk for fallback
    const dist = Math.min(Math.abs(pos - chunk.fromB), Math.abs(pos - chunk.toB));
    if (dist < nearestDist) {
      nearestDist = dist;
      nearestIndex = index;
    }
    index++;
  }
  return nearestIndex;
}

/** Diff-specific theme — merge toolbar, changed/deleted line backgrounds, collapse markers */
const diffSpecificTheme = EditorView.theme({
  '.cm-changedLine': { backgroundColor: 'var(--diff-cm-changed-bg) !important' },
  '.cm-deletedChunk': {
    backgroundColor: 'var(--diff-cm-deleted-bg)',
    position: 'relative',
    overflow: 'visible',
  },
  '.cm-insertedLine': { backgroundColor: 'var(--diff-cm-changed-bg) !important' },
  '.cm-deletedLine': { backgroundColor: 'var(--diff-cm-deleted-bg) !important' },
  // Merge toolbar — absolute, Y and left set dynamically by JS handlers
  '.cm-deletedChunk .cm-chunkButtons': {
    position: 'absolute',
    top: '0',
    zIndex: 10,
    display: 'flex',
    justifyContent: 'flex-end',
  },
  '.cm-merge-toolbar': {
    display: 'none',
    alignItems: 'center',
    gap: '2px',
    '&.cm-merge-toolbar-active': {
      display: 'flex',
    },
  },
  '.cm-merge-nav': {
    display: 'flex',
    alignItems: 'center',
    gap: '0',
    marginRight: '2px',
    border: '1px solid var(--color-border)',
    borderRadius: '6px',
    backgroundColor: 'var(--color-surface-raised)',
    overflow: 'hidden',
  },
  '.cm-merge-nav-btn': {
    border: 'none',
    background: 'transparent',
    color: 'var(--color-text-secondary)',
    cursor: 'pointer',
    padding: '3px 8px',
    fontSize: '13px',
    lineHeight: '20px',
    '&:hover': { background: 'var(--diff-merge-nav-hover-bg)' },
  },
  '.cm-merge-nav-counter': {
    fontSize: '12px',
    color: 'var(--color-text-secondary)',
    padding: '0 2px',
    whiteSpace: 'nowrap',
  },
  '.cm-merge-undo': {
    cursor: 'pointer',
    padding: '3px 10px',
    borderRadius: '5px',
    fontSize: '12px',
    fontWeight: '500',
    lineHeight: '20px',
    color: 'var(--diff-merge-undo-color)',
    backgroundColor: 'var(--diff-merge-undo-bg)',
    border: '1px solid var(--diff-merge-undo-border)',
    '&:hover': { backgroundColor: 'var(--diff-merge-undo-hover-bg)' },
    '& kbd': { fontSize: '10px', color: 'var(--color-text-muted)', marginLeft: '4px' },
  },
  '.cm-merge-keep': {
    cursor: 'pointer',
    padding: '3px 10px',
    borderRadius: '5px',
    fontSize: '12px',
    fontWeight: '500',
    lineHeight: '20px',
    color: 'var(--diff-merge-keep-color)',
    backgroundColor: 'var(--diff-merge-keep-bg)',
    border: '1px solid var(--diff-merge-keep-border)',
    '&:hover': { backgroundColor: 'var(--diff-merge-keep-hover-bg)' },
    '& kbd': { fontSize: '10px', color: 'var(--diff-merge-keep-kbd)', marginLeft: '4px' },
  },
  // Collapse unchanged region marker
  '.cm-collapsedLines': {
    backgroundColor: 'var(--color-surface-raised)',
    color: 'var(--color-text-muted)',
    fontSize: '12px',
    padding: '2px 8px',
    cursor: 'pointer',
    borderTop: '1px solid var(--color-border)',
    borderBottom: '1px solid var(--color-border)',
  },
});

/** When original is empty (all additions), avoid showing a stray "deleted" block at the top. */
const emptyOriginalOverrideTheme = EditorView.theme({
  '.cm-deletedChunk': {
    backgroundColor: 'transparent !important',
    paddingLeft: '0 !important',
  },
  '.cm-deletedLine': {
    backgroundColor: 'transparent !important',
  },
});

export const CodeMirrorDiffView = ({
  original,
  modified,
  fileName,
  maxHeight = '100%',
  readOnly = false,
  showMergeControls = false,
  collapseUnchanged: collapseUnchangedProp = true,
  collapseMargin = 3,
  onHunkAccepted,
  onHunkRejected,
  onFullyViewed,
  editorViewRef: externalViewRef,
  onViewChange,
  onContentChanged,
  initialState,
  usePortionCollapse = false,
  portionSize = 100,
  onSelectionChange,
}: CodeMirrorDiffViewProps): React.ReactElement => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const endSentinelRef = useRef<HTMLDivElement>(null);
  // Local ref to hold externalViewRef for syncing via useEffect
  const externalViewRefHolder = useRef(externalViewRef);

  // Stabilize callbacks via useEffect (cannot update refs during render)
  const onAcceptRef = useRef(onHunkAccepted);
  const onRejectRef = useRef(onHunkRejected);
  const onContentChangedRef = useRef(onContentChanged);
  const onViewChangeRef = useRef(onViewChange);
  const onSelectionChangeRef = useRef(onSelectionChange);
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    onAcceptRef.current = onHunkAccepted;
    onRejectRef.current = onHunkRejected;
    onContentChangedRef.current = onContentChanged;
    onViewChangeRef.current = onViewChange;
    onSelectionChangeRef.current = onSelectionChange;
    externalViewRefHolder.current = externalViewRef;
  }, [
    onHunkAccepted,
    onHunkRejected,
    onContentChanged,
    onViewChange,
    onSelectionChange,
    externalViewRef,
  ]);

  // Auto-scroll to next chunk after accept/reject (deferred to let CM recalculate)
  const scrollToNextChunk = useCallback(() => {
    requestAnimationFrame(() => {
      if (viewRef.current) goToNextChunk(viewRef.current);
    });
  }, []);

  // Compartment for lazy-injected language support
  const langCompartment = useRef(new Compartment());
  // Compartment for merge view — allows dynamic collapse reconfigure without editor recreation
  const mergeCompartment = useRef(new Compartment());
  // Compartment for portion collapse (separate from merge to allow independent reconfigure)
  const portionCompartment = useRef(new Compartment());

  // Collapse as ref — used in buildExtensions (initial value) without triggering full rebuild
  const collapseRef = useRef({ enabled: collapseUnchangedProp, margin: collapseMargin });
  useEffect(() => {
    collapseRef.current = { enabled: collapseUnchangedProp, margin: collapseMargin };
  }, [collapseUnchangedProp, collapseMargin]);

  /** Build unified merge view extension. Extracted for dynamic compartment reconfigure. */
  const buildMergeExtension = useCallback(
    (collapse: boolean, margin: number): Extension => {
      const mergeConfig: Parameters<typeof unifiedMergeView>[0] = {
        original,
        highlightChanges: false,
        gutter: true,
        syntaxHighlightDeletions: true,
      };

      // IMPORTANT: @codemirror/merge shows accept/reject buttons by default.
      // When our UI chooses to hide merge controls (e.g. "Missing on disk" preview),
      // explicitly disable them rather than relying on default behavior.
      if (!showMergeControls) {
        mergeConfig.mergeControls = false;
      }

      if (collapse && !usePortionCollapse) {
        mergeConfig.collapseUnchanged = {
          margin,
          minSize: 4,
        };
      }

      if (showMergeControls) {
        // NOTE: We intentionally do NOT use the `action` callback from @codemirror/merge.
        // CM's DeletionWidget caches DOM via a global WeakMap keyed by chunk.changes.
        // When EditorView is recreated (e.g. from cached initialState), toDOM() returns
        // the OLD cached DOM whose `action` closure references the DESTROYED view.
        // Instead, we call acceptChunk/rejectChunk directly with viewRef.current.
        //
        // CM calls mergeControls twice per chunk: 'accept' first, 'reject' second.
        // Both elements go into `.cm-chunkButtons`. We return the full toolbar for
        // 'accept' and a hidden span for 'reject'.
        mergeConfig.mergeControls = (type, _action) => {
          if (type === 'reject') {
            const empty = document.createElement('span');
            empty.style.display = 'none';
            return empty;
          }

          // --- Full toolbar for 'accept' ---
          const toolbar = document.createElement('div');
          toolbar.className = 'cm-merge-toolbar';

          // Navigation section (hidden by default, shown if >1 chunks)
          const nav = document.createElement('div');
          nav.className = 'cm-merge-nav';
          nav.style.display = 'none';

          const prevBtn = document.createElement('button');
          prevBtn.className = 'cm-merge-nav-btn';
          prevBtn.textContent = '\u2227';
          prevBtn.title = 'Previous chunk';
          prevBtn.onmousedown = (e) => {
            e.preventDefault();
            const v = viewRef.current;
            if (v) goToPreviousChunk(v);
          };

          const counter = document.createElement('span');
          counter.className = 'cm-merge-nav-counter';

          const nextBtn = document.createElement('button');
          nextBtn.className = 'cm-merge-nav-btn';
          nextBtn.textContent = '\u2228';
          nextBtn.title = 'Next chunk';
          nextBtn.onmousedown = (e) => {
            e.preventDefault();
            const v = viewRef.current;
            if (v) goToNextChunk(v);
          };

          nav.append(prevBtn, counter, nextBtn);
          toolbar.append(nav);

          // Helper: create button with label + kbd shortcut
          const makeBtn = (cls: string, label: string, shortcut: string): HTMLButtonElement => {
            const btn = document.createElement('button');
            btn.className = cls;
            btn.append(document.createTextNode(label + ' '));
            const kbd = document.createElement('kbd');
            kbd.textContent = shortcut;
            btn.append(kbd);
            return btn;
          };

          // Undo button (reject action)
          const undoBtn = makeBtn('cm-merge-undo', 'Undo', '\u2318N');
          undoBtn.title = 'Reject change (⌘N)';
          undoBtn.onmousedown = (e) => {
            e.preventDefault();
            const v = viewRef.current;
            if (v) {
              const pos = v.posAtDOM(toolbar);
              const idx = computeHunkIndexAtPos(v.state, pos);
              rejectChunk(v, pos);
              onRejectRef.current?.(idx);
              scrollToNextChunk();
            }
          };
          toolbar.append(undoBtn);

          // Keep button (accept action)
          const keepBtn = makeBtn('cm-merge-keep', 'Keep', '\u2318Y');
          keepBtn.title = 'Accept change (⌘Y)';
          keepBtn.onmousedown = (e) => {
            e.preventDefault();
            const v = viewRef.current;
            if (v) {
              const pos = v.posAtDOM(toolbar);
              const idx = computeHunkIndexAtPos(v.state, pos);
              acceptChunk(v, pos);
              onAcceptRef.current?.(idx);
              scrollToNextChunk();
            }
          };
          toolbar.append(keepBtn);

          // Deferred: compute chunk index + show nav if >1 chunks
          requestAnimationFrame(() => {
            const v = viewRef.current;
            if (!v) return;
            const chunks = getChunks(v.state);
            if (!chunks || chunks.chunks.length <= 1) return;
            const pos = v.posAtDOM(toolbar);
            const idx = computeHunkIndexAtPos(v.state, pos);
            counter.textContent = `${idx + 1} of ${chunks.chunks.length}`;
            nav.style.display = '';
          });

          return toolbar;
        };
      }

      return unifiedMergeView(mergeConfig);
    },
    [original, showMergeControls, scrollToNextChunk, usePortionCollapse]
  );

  const buildExtensions = useCallback(() => {
    const isEffectivelyEmptyOriginal = original.trim().length === 0;
    const extensions: Extension[] = [
      baseEditorTheme,
      diffSpecificTheme,
      ...(isEffectivelyEmptyOriginal ? [emptyOriginalOverrideTheme] : []),
      lineNumbers(),
      syntaxHighlighting(oneDarkHighlightStyle),
      foldGutter(),
      EditorView.editable.of(!readOnly),
      EditorState.readOnly.of(readOnly),
    ];

    // Undo/redo support and standard editing keybindings
    if (!readOnly) {
      extensions.push(history());
      extensions.push(mergeUndoSupport);
      extensions.push(mirrorEditsAfterResolve);
      extensions.push(indentUnit.of('  '));
      extensions.push(
        keymap.of([indentWithTab, ...defaultKeymap, ...historyKeymap, ...foldKeymap])
      );
    }

    // Language placeholder — actual language injected async via compartment reconfigure
    extensions.push(langCompartment.current.of([]));

    // Keyboard shortcuts for chunk navigation (within single editor).
    // NOTE: Mod-y, Mod-n, Alt-j are intentionally NOT here — they are handled by
    // useDiffNavigation's document handler (cross-file aware) and IPC handler (Cmd+N on macOS).
    // Registering them in CM keymap would call event.preventDefault(), blocking the
    // document handler's cross-file logic.
    extensions.push(
      keymap.of([
        {
          key: 'Ctrl-Alt-ArrowDown',
          run: goToNextChunk,
        },
        {
          key: 'Ctrl-Alt-ArrowUp',
          run: goToPreviousChunk,
        },
        ...foldKeymap,
      ])
    );

    // Debounced content change listener (only when editable)
    if (!readOnly) {
      extensions.push(
        EditorView.updateListener.of((update) => {
          if (update.docChanged) {
            clearTimeout(debounceTimer.current);
            debounceTimer.current = setTimeout(() => {
              onContentChangedRef.current?.(update.state.doc.toString());
            }, 300);
          }
        })
      );
    }

    // Selection change listener (for floating action menu)
    extensions.push(
      EditorView.updateListener.of((update) => {
        if (update.selectionSet || update.docChanged) {
          const sel = update.state.selection.main;
          if (sel.empty) {
            onSelectionChangeRef.current?.(null);
          } else {
            onSelectionChangeRef.current?.(buildSelectionInfo(update.view, sel));
          }
        }
      })
    );

    // Merge toolbar: always visible for nearest chunk, follows cursor when hovering on chunk
    if (showMergeControls) {
      // Helper: pin chunkButtons to right edge of visible viewport, accounting for horizontal scroll.
      // Uses getBoundingClientRect() so the offset from gutters / CM content padding is handled exactly.
      const pinToViewportRight = (btnContainer: HTMLElement, scroller: Element): void => {
        const scrollerRect = scroller.getBoundingClientRect();
        const chunkEl = btnContainer.parentElement;
        if (!chunkEl) return;
        const chunkRect = chunkEl.getBoundingClientRect();
        const btnWidth = btnContainer.offsetWidth || 200;
        const margin = 12;
        // left is relative to .cm-deletedChunk — so we compute from scroller's right edge
        btnContainer.style.left = `${scrollerRect.right - chunkRect.left - btnWidth - margin}px`;
        btnContainer.style.right = 'auto';
      };

      // Helper: position a chunkButtons container so it's below the change block,
      // but clamped to the visible viewport if that would be off-screen.
      const positionAtBottom = (chunkEl: Element, scroller: Element): void => {
        const btnContainer = chunkEl.querySelector<HTMLElement>('.cm-chunkButtons');
        if (!btnContainer) return;
        const parentRect = chunkEl.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        // "below block" = 100% of parent height
        let targetY = parentRect.bottom;
        const tbHeight = btnContainer.offsetHeight || 28;
        // Clamp: if bottom edge would go below visible area, pin to viewport bottom
        if (targetY + tbHeight > scrollerRect.bottom) {
          targetY = scrollerRect.bottom - tbHeight;
        }
        btnContainer.style.top = `${targetY - parentRect.top}px`;
        pinToViewportRight(btnContainer, scroller);
      };

      const positionAtCursor = (chunkEl: Element, clientY: number, scroller: Element): void => {
        const btnContainer = chunkEl.querySelector<HTMLElement>('.cm-chunkButtons');
        if (!btnContainer) return;
        const parentRect = chunkEl.getBoundingClientRect();
        const scrollerRect = scroller.getBoundingClientRect();
        const tbHeight = btnContainer.offsetHeight || 28;
        let targetY = clientY - tbHeight / 2;
        // Clamp to viewport
        if (targetY + tbHeight > scrollerRect.bottom) {
          targetY = scrollerRect.bottom - tbHeight;
        }
        if (targetY < scrollerRect.top) {
          targetY = scrollerRect.top;
        }
        btnContainer.style.top = `${targetY - parentRect.top}px`;
        pinToViewportRight(btnContainer, scroller);
      };

      // Find which chunk index the mouse is directly over (deleted or inserted area)
      const findHoveredChunkIndex = (event: MouseEvent, view: EditorView): number => {
        const el = document.elementFromPoint(event.clientX, event.clientY);
        if (!el) return -1;
        const deletedChunk = el.closest('.cm-deletedChunk');
        if (deletedChunk) {
          const all = view.dom.querySelectorAll('.cm-deletedChunk');
          return [...all].indexOf(deletedChunk);
        }
        if (el.closest('.cm-changedLine, .cm-insertedLine')) {
          const allChunks = getChunks(view.state);
          if (!allChunks) return -1;
          const pos = view.posAtCoords({ x: event.clientX, y: event.clientY });
          if (pos !== null) {
            for (let i = 0; i < allChunks.chunks.length; i++) {
              const chunk = allChunks.chunks[i];
              if (pos >= chunk.fromB && pos <= chunk.toB) return i;
            }
          }
        }
        return -1;
      };

      // Find chunk nearest to cursor Y (for default "below block" display)
      const findNearestChunkIndex = (clientY: number, view: EditorView): number => {
        const allChunkEls = view.dom.querySelectorAll('.cm-deletedChunk');
        let result = -1;
        if (allChunkEls.length > 0) {
          let bestIdx = 0;
          let bestDist = Infinity;
          allChunkEls.forEach((el, idx) => {
            const rect = el.getBoundingClientRect();
            const centerY = (rect.top + rect.bottom) / 2;
            const dist = Math.abs(clientY - centerY);
            if (dist < bestDist) {
              bestDist = dist;
              bestIdx = idx;
            }
          });
          result = bestIdx;
        }
        return result;
      };

      extensions.push(
        EditorView.domEventHandlers({
          mousemove(event, view) {
            const allChunks = getChunks(view.state);
            if (allChunks && allChunks.chunks.length > 0) {
              const scroller = view.scrollDOM;
              const allChunkEls = view.dom.querySelectorAll('.cm-deletedChunk');
              const hoveredIdx = findHoveredChunkIndex(event, view);
              const nearestIdx =
                hoveredIdx >= 0 ? hoveredIdx : findNearestChunkIndex(event.clientY, view);

              const toolbars = view.dom.querySelectorAll('.cm-merge-toolbar');
              toolbars.forEach((tb, idx) => {
                tb.classList.toggle('cm-merge-toolbar-active', idx === nearestIdx);
              });

              if (nearestIdx >= 0 && nearestIdx < allChunkEls.length) {
                const chunkEl = allChunkEls[nearestIdx] as HTMLElement;
                if (hoveredIdx >= 0) {
                  positionAtCursor(chunkEl, event.clientY, scroller);
                } else {
                  positionAtBottom(chunkEl, scroller);
                }
              }
            }
            return false;
          },
          mouseleave(_event, view) {
            // Keep active toolbar visible, reposition to "below block"
            const activeToolbar = view.dom.querySelector('.cm-merge-toolbar-active');
            if (activeToolbar) {
              const chunkEl = activeToolbar.closest('.cm-deletedChunk');
              if (chunkEl) positionAtBottom(chunkEl, view.scrollDOM);
            }
            return false;
          },
          scroll(_event, view) {
            // Reposition active toolbar on horizontal scroll so buttons stay at viewport edge
            const activeToolbar = view.dom.querySelector('.cm-merge-toolbar-active');
            if (activeToolbar) {
              const chunkEl = activeToolbar.closest('.cm-deletedChunk');
              if (chunkEl) {
                const btnContainer = chunkEl.querySelector<HTMLElement>('.cm-chunkButtons');
                if (btnContainer) {
                  pinToViewportRight(btnContainer, view.scrollDOM);
                }
              }
            }
            return false;
          },
        })
      );

      // Ensure at least one toolbar is visible (initial load + after accept/reject)
      extensions.push(
        EditorView.updateListener.of((update) => {
          if (update.view.dom.querySelector('.cm-merge-toolbar-active')) return;
          requestAnimationFrame(() => {
            const v = update.view;
            if (v.dom.querySelector('.cm-merge-toolbar-active')) return;
            const first = v.dom.querySelector('.cm-merge-toolbar');
            if (first) {
              first.classList.add('cm-merge-toolbar-active');
              const chunkEl = first.closest('.cm-deletedChunk');
              if (chunkEl) positionAtBottom(chunkEl, v.scrollDOM);
            }
          });
        })
      );
    }

    // Unified merge view (wrapped in compartment for dynamic collapse reconfigure)
    extensions.push(
      mergeCompartment.current.of(
        buildMergeExtension(collapseRef.current.enabled, collapseRef.current.margin)
      )
    );

    // Portion collapse — must come AFTER merge view so ChunkField is available
    extensions.push(
      portionCompartment.current.of(
        usePortionCollapse && collapseRef.current.enabled
          ? portionCollapseExtension({
              margin: collapseRef.current.margin,
              minSize: 4,
              portionSize,
            })
          : []
      )
    );

    return extensions;
  }, [readOnly, showMergeControls, buildMergeExtension, usePortionCollapse, portionSize, original]);

  useEffect(() => {
    if (!containerRef.current) return;

    // Destroy previous view
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    const view = initialState
      ? new EditorView({ state: initialState, parent: containerRef.current })
      : new EditorView({
          doc: modified,
          extensions: buildExtensions(),
          parent: containerRef.current,
        });

    viewRef.current = view;
    // Sync to external ref via holder
    const extRef = externalViewRefHolder.current;
    if (extRef) {
      (extRef as React.MutableRefObject<EditorView | null>).current = view;
    }
    // Notify parent that a new EditorView was created
    onViewChangeRef.current?.(view);

    return () => {
      clearTimeout(debounceTimer.current);
      view.destroy();
      viewRef.current = null;
      if (extRef) {
        (extRef as React.MutableRefObject<EditorView | null>).current = null;
      }
      // Notify parent that the EditorView was destroyed
      onViewChangeRef.current?.(null);
    };
    // We intentionally rebuild the entire editor when key props change
  }, [original, modified, buildExtensions, initialState]);

  // Inject language extension via compartment after editor creation
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;

    // Try synchronous (bundled) language first
    const syncLang = getSyncLanguageExtension(fileName);
    if (syncLang) {
      view.dispatch({ effects: langCompartment.current.reconfigure(syncLang) });
      return;
    }

    // Async fallback for rare languages via @codemirror/language-data
    const desc = getAsyncLanguageDesc(fileName);
    if (!desc) return;

    if (desc.support) {
      view.dispatch({ effects: langCompartment.current.reconfigure(desc.support) });
      return;
    }

    let cancelled = false;
    void desc.load().then((support: Extension) => {
      if (!cancelled && viewRef.current === view) {
        view.dispatch({ effects: langCompartment.current.reconfigure(support) });
      }
    });
    return () => {
      cancelled = true;
    };
  }, [fileName, buildExtensions, initialState, original, modified]);

  // Dynamic collapse toggle — reconfigure compartments in-place, preserving undo history
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: [
        mergeCompartment.current.reconfigure(
          buildMergeExtension(collapseUnchangedProp, collapseMargin)
        ),
        portionCompartment.current.reconfigure(
          usePortionCollapse && collapseUnchangedProp
            ? portionCollapseExtension({
                margin: collapseMargin,
                minSize: 4,
                portionSize,
              })
            : []
        ),
      ],
    });
  }, [collapseUnchangedProp, collapseMargin, buildMergeExtension, usePortionCollapse, portionSize]);

  // Auto-viewed detection via IntersectionObserver
  useEffect(() => {
    if (!endSentinelRef.current || !onFullyViewed) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onFullyViewed();
          }
        }
      },
      { threshold: 0.85 }
    );

    observer.observe(endSentinelRef.current);
    return () => observer.disconnect();
  }, [onFullyViewed]);

  return (
    <div className="flex flex-col" style={{ maxHeight }}>
      <div ref={containerRef} className="flex-1 overflow-hidden rounded-lg border border-border" />
      {/* Invisible sentinel for auto-viewed detection */}
      <div ref={endSentinelRef} className="h-px shrink-0" />
    </div>
  );
};
