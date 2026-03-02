/**
 * Base CodeMirror 6 theme using CSS variables.
 *
 * Extracted from CodeMirrorDiffView.tsx — shared between diff view and project editor.
 * Diff-specific styles (changedLine, deletedChunk, merge toolbar) stay in CodeMirrorDiffView.
 */

import { EditorView } from '@codemirror/view';

/** Base editor theme — general styling without diff-specific rules */
export const baseEditorTheme = EditorView.theme({
  '&': {
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-text)',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Consolas, monospace',
    fontSize: '13px',
    height: '100%',
  },
  '&.cm-focused': {
    outline: 'none',
  },
  '.cm-gutters': {
    backgroundColor: 'var(--color-surface)',
    borderRight: '1px solid var(--color-border)',
    color: 'var(--color-text-muted)',
    fontSize: '11px',
    minWidth: 'auto',
  },
  '.cm-lineNumbers .cm-gutterElement': {
    padding: '0 4px 0 8px',
    minWidth: '2ch',
    textAlign: 'right',
    opacity: '0.5',
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
});
