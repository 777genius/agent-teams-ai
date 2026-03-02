/**
 * Go to Line dialog (Cmd+G) — custom replacement for CodeMirror's built-in gotoLine.
 *
 * Supports: line numbers, relative offsets (+5, -3), percentages (50%),
 * and optional column positions (42:10).
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { EditorView } from '@codemirror/view';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import { editorBridge } from '@renderer/utils/editorBridge';

// =============================================================================
// Types
// =============================================================================

interface GoToLineDialogProps {
  onClose: () => void;
}

// =============================================================================
// Line parsing
// =============================================================================

interface ParsedTarget {
  line: number;
  col?: number;
}

function parseLineInput(input: string, view: EditorView): ParsedTarget | null {
  const trimmed = input.trim();
  if (!trimmed) return null;

  // Split line:col
  const [linePart, colPart] = trimmed.split(':');
  const col = colPart ? parseInt(colPart, 10) : undefined;
  if (col !== undefined && (isNaN(col) || col < 1)) return null;

  const lineStr = linePart.trim();
  if (!lineStr) return null;

  const totalLines = view.state.doc.lines;

  // Percentage: "50%"
  if (lineStr.endsWith('%')) {
    const pct = parseFloat(lineStr.slice(0, -1));
    if (isNaN(pct)) return null;
    const line = Math.max(1, Math.min(totalLines, Math.round((pct / 100) * totalLines)));
    return { line, col };
  }

  // Relative: "+5" or "-3"
  if (lineStr.startsWith('+') || lineStr.startsWith('-')) {
    const offset = parseInt(lineStr, 10);
    if (isNaN(offset)) return null;
    const currentPos = view.state.selection.main.head;
    const currentLine = view.state.doc.lineAt(currentPos).number;
    const line = Math.max(1, Math.min(totalLines, currentLine + offset));
    return { line, col };
  }

  // Absolute: "42"
  const lineNum = parseInt(lineStr, 10);
  if (isNaN(lineNum)) return null;
  const line = Math.max(1, Math.min(totalLines, lineNum));
  return { line, col };
}

// =============================================================================
// Component
// =============================================================================

export const GoToLineDialog = ({ onClose }: GoToLineDialogProps): React.ReactElement => {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  // Focus on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Escape to close
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  const handleGo = useCallback(() => {
    const view = editorBridge.getView();
    if (!view) return;

    const target = parseLineInput(value, view);
    if (!target) return;

    const lineInfo = view.state.doc.line(target.line);
    const colOffset = target.col ? Math.min(target.col - 1, lineInfo.length) : 0;
    const pos = lineInfo.from + colOffset;

    view.dispatch({
      selection: { anchor: pos },
      effects: EditorView.scrollIntoView(pos, { y: 'center' }),
    });

    view.focus();
    onClose();
  }, [value, onClose]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        handleGo();
      }
    },
    [handleGo]
  );

  // Current line info for placeholder
  const view = editorBridge.getView();
  const totalLines = view?.state.doc.lines ?? 0;
  const currentLine = view ? view.state.doc.lineAt(view.state.selection.main.head).number : 0;

  return (
    <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[15vh]">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-black/40"
        onClick={onClose}
        onKeyDown={(e) => {
          if (e.key === 'Escape') onClose();
        }}
        role="presentation"
      />

      {/* Dialog */}
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Go to Line"
        className="relative z-10 w-[360px] overflow-hidden rounded-lg border border-border-emphasis bg-surface shadow-2xl"
      >
        <div className="flex flex-col gap-2 p-3">
          <div className="flex items-center justify-between">
            <span className="text-xs text-text-secondary">
              Go to Line{' '}
              <span className="text-text-muted">
                (current: {currentLine}, total: {totalLines})
              </span>
            </span>
          </div>

          <div className="flex items-center gap-2">
            <Input
              ref={inputRef}
              className="h-8 flex-1 bg-transparent text-sm"
              placeholder="Line number, +offset, -offset, or %"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={handleKeyDown}
              spellCheck={false}
              autoComplete="off"
            />
            <Button
              variant="secondary"
              size="sm"
              className="h-8 px-4"
              onClick={handleGo}
              disabled={!value.trim()}
            >
              Go
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
};
