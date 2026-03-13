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
  /** Global hunk offset for this file in the review order */
  globalHunkOffset?: number;
  /** Total hunk count across all review files */
  totalReviewHunks?: number;
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
  globalHunkOffset = 0,
  totalReviewHunks,
}: CodeMirrorDiffViewProps): React.ReactElement => {
  const rootRef = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const endSentinelRef = useRef<HTMLDivElement>(null);
  const lastPointerRef = useRef<{ x: number; y: number } | null>(null);
  const floatingToolbarRef = useRef<HTMLDivElement>(null);
  const floatingNavRef = useRef<HTMLDivElement>(null);
  const floatingCounterRef = useRef<HTMLSpanElement>(null);
  const activeChunkIndexRef = useRef<number | null>(null);
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

  const hideFloatingToolbar = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar) return;
    toolbar.style.display = 'none';
    activeChunkIndexRef.current = null;
  }, []);

  const positionFloatingToolbar = useCallback((view: EditorView, clientY: number) => {
    const toolbar = floatingToolbarRef.current;
    const root = rootRef.current;
    if (!toolbar || !root) return;

    const rootRect = root.getBoundingClientRect();
    const scrollerRect = view.scrollDOM.getBoundingClientRect();
    const toolbarWidth = toolbar.offsetWidth || 200;
    const toolbarHeight = toolbar.offsetHeight || 28;
    const margin = 12;

    const left = scrollerRect.right - rootRect.left - toolbarWidth - margin;
    const clampedTop = Math.max(
      scrollerRect.top,
      Math.min(clientY - toolbarHeight / 2, scrollerRect.bottom - toolbarHeight)
    );

    toolbar.style.left = `${left}px`;
    toolbar.style.top = `${clampedTop - rootRect.top}px`;
  }, []);

  const resolveDeletedChunkIndex = useCallback(
    (deletedChunk: Element, view: EditorView): number => {
      try {
        return computeHunkIndexAtPos(view.state, view.posAtDOM(deletedChunk));
      } catch {
        return -1;
      }
    },
    []
  );

  const findHoveredChunkIndex = useCallback(
    (clientX: number, clientY: number, view: EditorView): number => {
      const hoveredElement = document.elementFromPoint(clientX, clientY);
      if (!hoveredElement) return -1;
      if (hoveredElement.closest('[data-review-floating-toolbar="true"]')) {
        return activeChunkIndexRef.current ?? -1;
      }

      const deletedChunk = hoveredElement.closest('.cm-deletedChunk');
      if (deletedChunk) {
        return resolveDeletedChunkIndex(deletedChunk, view);
      }

      if (
        !hoveredElement.closest(
          '.cm-changedLine, .cm-insertedLine, .cm-inlineChangedLine, .cm-changedText, .cm-deletedText'
        )
      ) {
        return -1;
      }

      const pos = view.posAtCoords({ x: clientX, y: clientY });
      if (pos === null) return -1;
      const chunks = getChunks(view.state);
      if (!chunks) return -1;

      for (let i = 0; i < chunks.chunks.length; i++) {
        const chunk = chunks.chunks[i];
        const chunkEnd = Math.min(view.state.doc.length, chunk.endB);
        if (pos >= chunk.fromB && pos <= chunkEnd) {
          return i;
        }
      }

      return -1;
    },
    [resolveDeletedChunkIndex]
  );

  const updateFloatingToolbar = useCallback(
    (
      view: EditorView,
      clientY: number,
      options?: { clientX?: number; followCursor?: boolean }
    ): void => {
      if (!showMergeControls) {
        hideFloatingToolbar();
        return;
      }

      const toolbar = floatingToolbarRef.current;
      const nav = floatingNavRef.current;
      const counter = floatingCounterRef.current;
      const chunks = getChunks(view.state);

      if (!toolbar || !chunks || chunks.chunks.length === 0) {
        hideFloatingToolbar();
        return;
      }

      let activeIndex =
        options?.clientX !== undefined ? findHoveredChunkIndex(options.clientX, clientY, view) : -1;

      if (activeIndex < 0) {
        hideFloatingToolbar();
        return;
      }

      activeIndex = Math.max(0, Math.min(activeIndex, chunks.chunks.length - 1));
      activeChunkIndexRef.current = activeIndex;

      if (counter) {
        const displayIndex = globalHunkOffset + activeIndex + 1;
        const displayTotal = totalReviewHunks ?? chunks.chunks.length;
        counter.textContent = `${displayIndex} of ${displayTotal}`;
      }
      if (nav) {
        nav.style.display = chunks.chunks.length > 1 ? '' : 'none';
      }

      toolbar.style.display = 'flex';
      const scrollerRect = view.scrollDOM.getBoundingClientRect();
      const targetY = options?.followCursor
        ? clientY
        : (scrollerRect.top + scrollerRect.bottom) / 2;
      positionFloatingToolbar(view, targetY);
    },
    [
      findHoveredChunkIndex,
      globalHunkOffset,
      hideFloatingToolbar,
      positionFloatingToolbar,
      showMergeControls,
      totalReviewHunks,
    ]
  );

  const actOnActiveChunk = useCallback(
    (decision: 'accept' | 'reject') => {
      const view = viewRef.current;
      const activeChunkIndex = activeChunkIndexRef.current;
      if (!view || activeChunkIndex === null) return;

      const chunks = getChunks(view.state);
      const chunk = chunks?.chunks[activeChunkIndex];
      if (!chunk) return;

      if (decision === 'accept') {
        acceptChunk(view, chunk.fromB);
        onAcceptRef.current?.(activeChunkIndex);
      } else {
        rejectChunk(view, chunk.fromB);
        onRejectRef.current?.(activeChunkIndex);
      }

      scrollToNextChunk();
      requestAnimationFrame(() => {
        const scrollerRect = view.scrollDOM.getBoundingClientRect();
        updateFloatingToolbar(view, (scrollerRect.top + scrollerRect.bottom) / 2);
      });
    },
    [scrollToNextChunk, updateFloatingToolbar]
  );

  const moveBetweenChunks = useCallback(
    (direction: 'prev' | 'next') => {
      const view = viewRef.current;
      if (!view) return;
      if (direction === 'prev') {
        goToPreviousChunk(view);
      } else {
        goToNextChunk(view);
      }

      requestAnimationFrame(() => {
        const scrollerRect = view.scrollDOM.getBoundingClientRect();
        updateFloatingToolbar(view, (scrollerRect.top + scrollerRect.bottom) / 2);
      });
    },
    [updateFloatingToolbar]
  );

  useEffect(() => {
    if (!showMergeControls) return;

    const repositionToolbar = (): void => {
      const view = viewRef.current;
      const root = rootRef.current;
      const toolbar = floatingToolbarRef.current;
      if (!view || !root || !toolbar || toolbar.style.display === 'none') return;

      const pointer = lastPointerRef.current;
      const rootRect = root.getBoundingClientRect();
      const pointerInsideRoot =
        pointer &&
        pointer.x >= rootRect.left &&
        pointer.x <= rootRect.right &&
        pointer.y >= rootRect.top &&
        pointer.y <= rootRect.bottom;

      if (pointerInsideRoot) {
        updateFloatingToolbar(view, pointer.y, {
          clientX: pointer.x,
          followCursor: true,
        });
        return;
      }

      const scrollerRect = view.scrollDOM.getBoundingClientRect();
      updateFloatingToolbar(view, (scrollerRect.top + scrollerRect.bottom) / 2);
    };

    window.addEventListener('scroll', repositionToolbar, true);
    window.addEventListener('resize', repositionToolbar);
    return () => {
      window.removeEventListener('scroll', repositionToolbar, true);
      window.removeEventListener('resize', repositionToolbar);
    };
  }, [showMergeControls, updateFloatingToolbar]);

  /** Build unified merge view extension. Extracted for dynamic compartment reconfigure. */
  const buildMergeExtension = useCallback(
    (collapse: boolean, margin: number): Extension => {
      const mergeConfig: Parameters<typeof unifiedMergeView>[0] = {
        original,
        highlightChanges: false,
        gutter: true,
        syntaxHighlightDeletions: true,
      };

      // We render our own floating merge toolbar outside CodeMirror's DeletionWidget DOM.
      mergeConfig.mergeControls = false;

      if (collapse && !usePortionCollapse) {
        mergeConfig.collapseUnchanged = {
          margin,
          minSize: 4,
        };
      }

      return unifiedMergeView(mergeConfig);
    },
    [original, usePortionCollapse]
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

    // External merge toolbar: follows cursor without depending on CodeMirror's widget DOM.
    if (showMergeControls) {
      extensions.push(
        EditorView.domEventHandlers({
          mouseleave() {
            return false;
          },
          scroll(_event, view) {
            const scrollerRect = view.scrollDOM.getBoundingClientRect();
            const pointer = lastPointerRef.current;
            const pointerInsideScroller =
              pointer &&
              pointer.x >= scrollerRect.left &&
              pointer.x <= scrollerRect.right &&
              pointer.y >= scrollerRect.top &&
              pointer.y <= scrollerRect.bottom;
            const targetY = pointerInsideScroller
              ? pointer.y
              : (scrollerRect.top + scrollerRect.bottom) / 2;

            updateFloatingToolbar(view, targetY, {
              clientX: pointerInsideScroller ? pointer.x : undefined,
              followCursor: Boolean(pointerInsideScroller),
            });
            return false;
          },
        })
      );

      // Ensure at least one toolbar is visible (initial load + after accept/reject)
      extensions.push(
        EditorView.updateListener.of((update) => {
          requestAnimationFrame(() => {
            const v = update.view;
            const scrollerRect = v.scrollDOM.getBoundingClientRect();
            updateFloatingToolbar(v, (scrollerRect.top + scrollerRect.bottom) / 2);
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
  }, [
    readOnly,
    showMergeControls,
    buildMergeExtension,
    usePortionCollapse,
    portionSize,
    original,
    updateFloatingToolbar,
  ]);

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
      hideFloatingToolbar();
      view.destroy();
      viewRef.current = null;
      if (extRef) {
        (extRef as React.MutableRefObject<EditorView | null>).current = null;
      }
      // Notify parent that the EditorView was destroyed
      onViewChangeRef.current?.(null);
    };
    // We intentionally rebuild the entire editor when key props change
  }, [original, modified, buildExtensions, initialState, hideFloatingToolbar]);

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
    <div
      ref={rootRef}
      role="presentation"
      className="relative flex flex-col"
      style={{ maxHeight }}
      onMouseMove={(e) => {
        lastPointerRef.current = { x: e.clientX, y: e.clientY };
        const view = viewRef.current;
        if (!view) return;
        updateFloatingToolbar(view, e.clientY, {
          clientX: e.clientX,
          followCursor: true,
        });
      }}
      onMouseLeave={() => {
        lastPointerRef.current = null;
        hideFloatingToolbar();
      }}
    >
      <div ref={containerRef} className="flex-1 overflow-hidden rounded-lg border border-border" />
      {showMergeControls && (
        <div
          ref={floatingToolbarRef}
          data-review-floating-toolbar="true"
          className="pointer-events-none absolute z-20 hidden items-center gap-0.5"
        >
          <div
            ref={floatingNavRef}
            className="pointer-events-auto flex items-center overflow-hidden rounded-md border border-border bg-surface-raised"
            style={{ display: 'none' }}
          >
            <button
              type="button"
              className="px-2 py-[3px] text-[13px] leading-5 text-text-secondary transition-colors hover:bg-[var(--diff-merge-nav-hover-bg)]"
              title="Previous chunk"
              onMouseDown={(e) => {
                e.preventDefault();
                moveBetweenChunks('prev');
              }}
            >
              {'\u2227'}
            </button>
            <span
              ref={floatingCounterRef}
              className="whitespace-nowrap px-1 text-xs text-text-secondary"
            />
            <button
              type="button"
              className="px-2 py-[3px] text-[13px] leading-5 text-text-secondary transition-colors hover:bg-[var(--diff-merge-nav-hover-bg)]"
              title="Next chunk"
              onMouseDown={(e) => {
                e.preventDefault();
                moveBetweenChunks('next');
              }}
            >
              {'\u2228'}
            </button>
          </div>
          <button
            type="button"
            className="pointer-events-auto rounded px-2.5 py-[3px] text-xs font-medium leading-5 transition-colors hover:[background-color:var(--diff-merge-undo-hover-bg)]"
            style={{
              color: 'var(--diff-merge-undo-color)',
              backgroundColor: 'var(--diff-merge-undo-bg)',
              border: '1px solid var(--diff-merge-undo-border)',
            }}
            title="Reject change (⌘N)"
            onMouseDown={(e) => {
              e.preventDefault();
              actOnActiveChunk('reject');
            }}
          >
            {'Undo '}
            <kbd className="ml-1 text-[10px] text-text-muted">{'\u2318N'}</kbd>
          </button>
          <button
            type="button"
            className="pointer-events-auto rounded px-2.5 py-[3px] text-xs font-medium leading-5 transition-colors hover:[background-color:var(--diff-merge-keep-hover-bg)]"
            style={{
              color: 'var(--diff-merge-keep-color)',
              backgroundColor: 'var(--diff-merge-keep-bg)',
              border: '1px solid var(--diff-merge-keep-border)',
            }}
            title="Accept change (⌘Y)"
            onMouseDown={(e) => {
              e.preventDefault();
              actOnActiveChunk('accept');
            }}
          >
            {'Keep '}
            <kbd className="ml-1 text-[10px] text-[var(--diff-merge-keep-kbd)]">{'\u2318Y'}</kbd>
          </button>
        </div>
      )}
      {/* Invisible sentinel for auto-viewed detection */}
      <div ref={endSentinelRef} className="h-px shrink-0" />
    </div>
  );
};
