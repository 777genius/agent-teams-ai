/**
 * Interactive overlay layer (z-20) for inline code chips.
 *
 * Positioned above the textarea, provides:
 * - Hover tooltip with code preview (first ~12 lines, CodeMirror syntax highlighting)
 * - X button to remove a chip
 *
 * Uses mirror div technique (calculateChipPositions) to position elements
 * exactly over the corresponding chip tokens in the textarea.
 */

import * as React from 'react';

import { syntaxHighlighting } from '@codemirror/language';
import { EditorState } from '@codemirror/state';
import { oneDarkHighlightStyle } from '@codemirror/theme-one-dark';
import { EditorView } from '@codemirror/view';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { chipDisplayLabel } from '@renderer/types/inlineChip';
import { calculateChipPositions } from '@renderer/utils/chipUtils';
import { getSyncLanguageExtension } from '@renderer/utils/codemirrorLanguages';
import { ExternalLink, X } from 'lucide-react';

import type { InlineChip } from '@renderer/types/inlineChip';
import type { ChipPosition } from '@renderer/utils/chipUtils';

// =============================================================================
// Compact read-only CodeMirror theme for tooltip preview
// =============================================================================

const chipPreviewTheme = EditorView.theme({
  '&': {
    fontSize: '11px',
    backgroundColor: 'var(--code-bg, #1e1e2e)',
    color: 'var(--color-text)',
  },
  '.cm-content': {
    padding: '8px 10px',
    fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, monospace',
    lineHeight: '1.6',
  },
  '&.cm-focused': { outline: 'none' },
  '.cm-scroller': { overflow: 'auto' },
  '.cm-gutters': { display: 'none' },
  '.cm-activeLine': { backgroundColor: 'transparent' },
  '.cm-selectionBackground': { backgroundColor: 'transparent' },
  '.cm-cursor': { display: 'none' },
});

// =============================================================================
// Code preview subcomponent (CodeMirror read-only)
// =============================================================================

const MAX_PREVIEW_LINES = 12;

/** Simple tooltip for file-level mention chips (no code preview). */
const ChipFilePreview = ({
  chip,
  onOpenInEditor,
  onRevealFolder,
}: {
  chip: InlineChip;
  onOpenInEditor?: (filePath: string) => void;
  onRevealFolder?: (folderPath: string) => void;
}): React.JSX.Element => {
  const displayPath = chip.displayPath ?? chip.filePath;
  const isFolder = chip.isFolder === true;
  return (
    <div className="max-w-md overflow-hidden rounded-md">
      <div className="flex items-center gap-2 bg-[var(--code-bg,#1e1e2e)] px-2.5 py-2">
        <span className="text-[11px] font-medium text-[var(--color-text)]">{chip.fileName}</span>
        <span className="flex-1 text-[10px] text-[var(--color-text-muted)]">{displayPath}</span>
        {isFolder && onRevealFolder ? (
          <button
            type="button"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onRevealFolder(chip.filePath);
            }}
          >
            <ExternalLink size={10} />
            Reveal
          </button>
        ) : !isFolder && onOpenInEditor ? (
          <button
            type="button"
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
            onClick={(e) => {
              e.preventDefault();
              e.stopPropagation();
              onOpenInEditor(chip.filePath);
            }}
          >
            <ExternalLink size={10} />
            Open
          </button>
        ) : null}
      </div>
    </div>
  );
};

const ChipCodePreview = ({ chip }: { chip: InlineChip }): React.JSX.Element => {
  const containerRef = React.useRef<HTMLDivElement>(null);
  const allLines = chip.codeText.split('\n');
  const truncated = allLines.length > MAX_PREVIEW_LINES;
  const visibleCode = truncated ? allLines.slice(0, MAX_PREVIEW_LINES).join('\n') : chip.codeText;
  const label = chipDisplayLabel(chip);
  const lineRef =
    chip.fromLine === chip.toLine
      ? `line ${String(chip.fromLine)}`
      : `lines ${String(chip.fromLine)}-${String(chip.toLine)}`;

  React.useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const langExt = getSyncLanguageExtension(chip.fileName);

    const state = EditorState.create({
      doc: visibleCode,
      extensions: [
        chipPreviewTheme,
        syntaxHighlighting(oneDarkHighlightStyle),
        EditorView.editable.of(false),
        EditorState.readOnly.of(true),
        ...(langExt ? [langExt] : []),
      ],
    });

    const view = new EditorView({ state, parent: container });

    return () => {
      view.destroy();
    };
  }, [visibleCode, chip.fileName]);

  return (
    <div className="max-w-md overflow-hidden rounded-md">
      <div className="flex items-center justify-between border-b border-[var(--color-border)] bg-[var(--code-bg,#1e1e2e)] px-2.5 py-1.5">
        <span className="text-[11px] font-medium text-[var(--color-text)]">{label}</span>
        <span className="text-[10px] text-[var(--color-text-muted)]">{lineRef}</span>
      </div>
      <div ref={containerRef} />
      {truncated ? (
        <div className="border-t border-[var(--color-border)] bg-[var(--code-bg,#1e1e2e)] px-2.5 py-1">
          <span className="text-[10px] text-[var(--color-text-muted)]">
            ({allLines.length - MAX_PREVIEW_LINES} more lines...)
          </span>
        </div>
      ) : null}
    </div>
  );
};

// =============================================================================
// Interaction layer
// =============================================================================

interface ChipInteractionLayerProps {
  chips: InlineChip[];
  value: string;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
  scrollTop: number;
  onRemove: (chipId: string) => void;
}

export const ChipInteractionLayer = ({
  chips,
  value,
  textareaRef,
  scrollTop,
  onRemove,
}: ChipInteractionLayerProps): React.JSX.Element | null => {
  const [positions, setPositions] = React.useState<ChipPosition[]>([]);
  const revealFileInEditor = useStore((s) => s.revealFileInEditor);
  const revealFolderInEditor = useStore((s) => s.revealFolderInEditor);

  React.useLayoutEffect(() => {
    if (chips.length === 0) {
      setPositions([]);
      return;
    }
    const textarea = textareaRef.current;
    if (!textarea) return;
    setPositions(calculateChipPositions(textarea, value, chips));
  }, [chips, value, textareaRef]);

  if (positions.length === 0) return null;

  return (
    <div className="pointer-events-none absolute inset-0 z-20 overflow-hidden">
      <div style={{ transform: `translateY(-${scrollTop}px)` }}>
        {positions.map((pos) => {
          const isFileChip = pos.chip.fromLine == null;
          const isFolderChip = pos.chip.isFolder === true;
          return (
            <Tooltip key={pos.chip.id}>
              <TooltipTrigger asChild>
                <div
                  className={`group pointer-events-auto absolute ${isFileChip ? 'cursor-pointer' : 'cursor-default'}`}
                  style={{
                    top: pos.top,
                    left: pos.left,
                    width: pos.width,
                    height: pos.height,
                  }}
                  onClick={
                    isFileChip
                      ? (e) => {
                          e.preventDefault();
                          e.stopPropagation();
                          if (isFolderChip) {
                            revealFolderInEditor(pos.chip.filePath);
                          } else {
                            revealFileInEditor(pos.chip.filePath);
                          }
                        }
                      : undefined
                  }
                >
                  <button
                    type="button"
                    className="pointer-events-none absolute -right-1 -top-1.5 z-30 flex size-3.5 items-center justify-center rounded-full border border-[var(--color-border-emphasis)] bg-[var(--color-surface-raised)] opacity-0 transition-opacity group-hover:pointer-events-auto group-hover:opacity-100"
                    onClick={(e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      onRemove(pos.chip.id);
                    }}
                  >
                    <X size={8} className="text-[var(--color-text-muted)]" />
                  </button>
                </div>
              </TooltipTrigger>
              <TooltipContent side="top" className="max-w-md p-0">
                {isFileChip ? (
                  <ChipFilePreview
                    chip={pos.chip}
                    onOpenInEditor={revealFileInEditor}
                    onRevealFolder={revealFolderInEditor}
                  />
                ) : (
                  <ChipCodePreview chip={pos.chip} />
                )}
              </TooltipContent>
            </Tooltip>
          );
        })}
      </div>
    </div>
  );
};
