import { useCallback, useEffect, useMemo, useRef } from 'react';

import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { python } from '@codemirror/lang-python';
import { xml } from '@codemirror/lang-xml';
import {
  acceptChunk,
  getChunks,
  goToNextChunk,
  goToPreviousChunk,
  rejectChunk,
  unifiedMergeView,
} from '@codemirror/merge';
import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, keymap } from '@codemirror/view';

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
  /** Called when editor content changes (debounced, only when readOnly=false) */
  onContentChanged?: (content: string) => void;
}

/** Detect language extension from file name */
function getLanguageExtension(fileName: string): Extension | null {
  const ext = fileName.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return javascript({
        jsx: ext === 'tsx' || ext === 'jsx',
        typescript: ext === 'ts' || ext === 'tsx',
      });
    case 'py':
      return python();
    case 'json':
    case 'jsonl':
      return json();
    case 'css':
    case 'scss':
      return css();
    case 'html':
    case 'htm':
      return html();
    case 'xml':
    case 'svg':
      return xml();
    default:
      return null;
  }
}

/** Compute hunk index for the chunk at a given position */
function computeHunkIndexAtPos(state: EditorState, pos: number): number {
  const chunks = getChunks(state);
  if (!chunks) return 0;

  let index = 0;
  for (const chunk of chunks.chunks) {
    if (pos >= chunk.fromA && pos <= chunk.toA) {
      return index;
    }
    if (pos >= chunk.fromB && pos <= chunk.toB) {
      return index;
    }
    index++;
  }
  return 0;
}

/** Custom dark theme for diff view using CSS variables */
const diffTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-text)',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: '13px',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--color-surface)',
    borderRight: '1px solid var(--color-border)',
    color: 'var(--color-text-muted)',
    fontSize: '12px',
  },
  '.cm-activeLineGutter': {
    backgroundColor: 'transparent',
  },
  '.cm-activeLine': {
    backgroundColor: 'transparent',
  },
  '.cm-scroller': {
    overflow: 'auto',
  },
  '.cm-content': {
    caretColor: 'var(--color-text)',
  },
  '.cm-cursor': {
    borderLeftColor: 'var(--color-text)',
  },
  '.cm-selectionBackground': {
    backgroundColor: 'rgba(59, 130, 246, 0.3) !important',
  },
  // Diff-specific styles
  '.cm-changedLine': {
    backgroundColor: 'var(--diff-added-bg, rgba(46, 160, 67, 0.15))',
  },
  '.cm-deletedChunk': {
    backgroundColor: 'var(--diff-removed-bg, rgba(248, 81, 73, 0.15))',
  },
  '.cm-insertedLine': {
    backgroundColor: 'var(--diff-added-bg, rgba(46, 160, 67, 0.15))',
  },
  '.cm-deletedLine': {
    backgroundColor: 'var(--diff-removed-bg, rgba(248, 81, 73, 0.15))',
  },
  // Merge control buttons
  '.cm-merge-accept': {
    cursor: 'pointer',
    padding: '0 4px',
    margin: '0 2px',
    borderRadius: '3px',
    fontSize: '11px',
    fontWeight: '500',
    lineHeight: '18px',
    display: 'inline-block',
    color: '#3fb950',
    backgroundColor: 'rgba(46, 160, 67, 0.15)',
    border: '1px solid rgba(46, 160, 67, 0.3)',
    '&:hover': {
      backgroundColor: 'rgba(46, 160, 67, 0.3)',
    },
  },
  '.cm-merge-reject': {
    cursor: 'pointer',
    padding: '0 4px',
    margin: '0 2px',
    borderRadius: '3px',
    fontSize: '11px',
    fontWeight: '500',
    lineHeight: '18px',
    display: 'inline-block',
    color: '#f85149',
    backgroundColor: 'rgba(248, 81, 73, 0.15)',
    border: '1px solid rgba(248, 81, 73, 0.3)',
    '&:hover': {
      backgroundColor: 'rgba(248, 81, 73, 0.3)',
    },
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
  onContentChanged,
}: CodeMirrorDiffViewProps) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const endSentinelRef = useRef<HTMLDivElement>(null);
  // Local ref to hold externalViewRef for syncing via useEffect
  const externalViewRefHolder = useRef(externalViewRef);

  // Stabilize callbacks via useEffect (cannot update refs during render)
  const onAcceptRef = useRef(onHunkAccepted);
  const onRejectRef = useRef(onHunkRejected);
  const onContentChangedRef = useRef(onContentChanged);
  const debounceTimer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => {
    onAcceptRef.current = onHunkAccepted;
    onRejectRef.current = onHunkRejected;
    onContentChangedRef.current = onContentChanged;
    externalViewRefHolder.current = externalViewRef;
  }, [onHunkAccepted, onHunkRejected, onContentChanged, externalViewRef]);

  // Auto-scroll to next chunk after accept/reject (deferred to let CM recalculate)
  const scrollToNextChunk = useCallback(() => {
    requestAnimationFrame(() => {
      if (viewRef.current) goToNextChunk(viewRef.current);
    });
  }, []);

  const langExtension = useMemo(() => getLanguageExtension(fileName), [fileName]);

  const buildExtensions = useCallback(() => {
    const extensions: Extension[] = [
      diffTheme,
      EditorView.editable.of(!readOnly),
      EditorState.readOnly.of(readOnly),
    ];

    // Undo/redo support and standard editing keybindings
    if (!readOnly) {
      extensions.push(history());
      extensions.push(keymap.of([...defaultKeymap, ...historyKeymap]));
    }

    if (langExtension) {
      extensions.push(langExtension);
    }

    // Keyboard shortcuts for chunk navigation and accept/reject
    extensions.push(
      keymap.of([
        {
          key: 'Mod-y',
          run: (view) => {
            acceptChunk(view);
            requestAnimationFrame(() => goToNextChunk(view));
            return true;
          },
        },
        {
          key: 'Mod-n',
          run: (view) => {
            rejectChunk(view);
            requestAnimationFrame(() => goToNextChunk(view));
            return true;
          },
        },
        {
          key: 'Alt-j',
          run: (view) => {
            goToNextChunk(view);
            return true;
          },
        },
        {
          key: 'Ctrl-Alt-ArrowDown',
          run: goToNextChunk,
        },
        {
          key: 'Ctrl-Alt-ArrowUp',
          run: goToPreviousChunk,
        },
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

    // Unified merge view
    const mergeConfig: Parameters<typeof unifiedMergeView>[0] = {
      original,
      highlightChanges: true,
      gutter: true,
      syntaxHighlightDeletions: true,
    };

    if (collapseUnchangedProp) {
      mergeConfig.collapseUnchanged = {
        margin: collapseMargin,
        minSize: 4,
      };
    }

    if (showMergeControls) {
      mergeConfig.mergeControls = (type, action) => {
        const btn = document.createElement('button');

        if (type === 'accept') {
          btn.textContent = '\u2713';
          btn.title = 'Accept change';
          btn.className = 'cm-merge-accept';
          btn.onmousedown = (e) => {
            e.preventDefault();
            const view = viewRef.current;
            if (view) {
              const pos = view.posAtDOM(btn);
              const hunkIndex = computeHunkIndexAtPos(view.state, pos);
              action(e);
              onAcceptRef.current?.(hunkIndex);
              scrollToNextChunk();
            }
          };
        } else {
          btn.textContent = '\u2717';
          btn.title = 'Reject change';
          btn.className = 'cm-merge-reject';
          btn.onmousedown = (e) => {
            e.preventDefault();
            const view = viewRef.current;
            if (view) {
              const pos = view.posAtDOM(btn);
              const hunkIndex = computeHunkIndexAtPos(view.state, pos);
              action(e);
              onRejectRef.current?.(hunkIndex);
              scrollToNextChunk();
            }
          };
        }

        return btn;
      };
    }

    extensions.push(unifiedMergeView(mergeConfig));

    return extensions;
  }, [
    original,
    readOnly,
    langExtension,
    showMergeControls,
    collapseUnchangedProp,
    collapseMargin,
    scrollToNextChunk,
  ]);

  useEffect(() => {
    if (!containerRef.current) return;

    // Destroy previous view
    if (viewRef.current) {
      viewRef.current.destroy();
      viewRef.current = null;
    }

    const view = new EditorView({
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

    return () => {
      view.destroy();
      viewRef.current = null;
      if (extRef) {
        (extRef as React.MutableRefObject<EditorView | null>).current = null;
      }
    };
    // We intentionally rebuild the entire editor when key props change
  }, [original, modified, buildExtensions]);

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
      { threshold: 1.0 }
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

// Re-export merge utils for external use
export { acceptChunk, getChunks, rejectChunk };
