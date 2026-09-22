/**
 * Base CodeMirror 6 theme and shared extensions.
 *
 * Extracted from CodeMirrorDiffView.tsx — shared between diff view, config editor, and member editor.
 * Diff-specific styles (changedLine, deletedChunk, merge toolbar) stay in CodeMirrorDiffView.
 */

import { type Diagnostic, linter } from '@codemirror/lint';
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

  /* ---- Lint tooltips & diagnostics (dark-theme aware) ---- */
  '.cm-tooltip': {
    backgroundColor: 'var(--color-surface-raised)',
    color: 'var(--color-text)',
    border: '1px solid var(--color-border-emphasis)',
    borderRadius: '6px',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.4)',
  },
  '.cm-tooltip-lint': {
    padding: '0',
    borderRadius: '6px',
    overflow: 'hidden',
  },
  '.cm-diagnostic': {
    padding: '6px 10px',
    borderLeft: '3px solid transparent',
    fontSize: '12px',
    lineHeight: '1.4',
  },
  '.cm-diagnostic-error': {
    borderLeftColor: '#ef4444',
    color: '#fca5a5',
    backgroundColor: 'rgba(239, 68, 68, 0.08)',
  },
  '.cm-diagnostic-warning': {
    borderLeftColor: '#f59e0b',
    color: '#fcd34d',
    backgroundColor: 'rgba(245, 158, 11, 0.08)',
  },
  '.cm-diagnostic-info': {
    borderLeftColor: '#3b82f6',
    color: '#93c5fd',
    backgroundColor: 'rgba(59, 130, 246, 0.08)',
  },
  '.cm-lintRange-error': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy #ef4444',
    textUnderlineOffset: '3px',
  },
  '.cm-lintRange-warning': {
    backgroundImage: 'none',
    textDecoration: 'underline wavy #f59e0b',
    textUnderlineOffset: '3px',
  },

  /* ---- Search panel (dark-theme aware) ---- */
  '.cm-panels': {
    backgroundColor: 'var(--color-surface-raised)',
    color: 'var(--color-text)',
    borderTop: '1px solid var(--color-border)',
  },
  '.cm-panel input, .cm-panel button': {
    color: 'inherit',
  },
  '.cm-panel input[type="text"]': {
    backgroundColor: 'var(--color-surface)',
    border: '1px solid var(--color-border)',
    borderRadius: '4px',
    padding: '2px 6px',
    color: 'var(--color-text)',
  },
});

/** Shared JSON linter — validates JSON and reports syntax errors inline. */
export const jsonLinter = linter((view: EditorView) => {
  const diagnostics: Diagnostic[] = [];
  const text = view.state.doc.toString();
  try {
    JSON.parse(text);
  } catch (e) {
    if (e instanceof SyntaxError) {
      const match = /position (\d+)/.exec(e.message);
      const pos = match ? parseInt(match[1], 10) : 0;
      const safePos = Math.min(pos, text.length);
      diagnostics.push({
        from: safePos,
        to: Math.min(safePos + 1, text.length),
        severity: 'error',
        message: e.message,
      });
    }
  }
  return diagnostics;
});
