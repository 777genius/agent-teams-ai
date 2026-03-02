import { useMemo } from 'react';

import { highlightLines } from '@renderer/utils/syntaxHighlighter';
import { diffLines } from 'diff';

import type { FileChangeSummary, SnippetDiff } from '@shared/types/review';

// =============================================================================
// Types
// =============================================================================

interface ReviewDiffContentProps {
  file: FileChangeSummary;
}

interface DiffLine {
  type: 'added' | 'removed' | 'unchanged';
  html: string;
}

// =============================================================================
// Helpers
// =============================================================================

/** Build highlighted diff lines by mapping diff parts onto pre-highlighted old/new lines. */
function buildHighlightedDiffLines(snippet: SnippetDiff, fileName: string): DiffLine[] {
  const isFullNew = snippet.type === 'write-new' || snippet.type === 'write-update';
  const oldCode = isFullNew ? '' : snippet.oldString;
  const diffResult = diffLines(oldCode, snippet.newString);

  const oldHighlighted = highlightLines(oldCode, fileName);
  const newHighlighted = highlightLines(snippet.newString, fileName);

  const result: DiffLine[] = [];
  let oldIdx = 0;
  let newIdx = 0;

  for (const part of diffResult) {
    const lineCount = part.value.replace(/\n$/, '').split('\n').length;
    for (let i = 0; i < lineCount; i++) {
      if (part.removed) {
        result.push({
          type: 'removed',
          html: oldHighlighted[oldIdx++] ?? '',
        });
      } else if (part.added) {
        result.push({
          type: 'added',
          html: newHighlighted[newIdx++] ?? '',
        });
      } else {
        result.push({
          type: 'unchanged',
          html: oldHighlighted[oldIdx++] ?? '',
        });
        newIdx++;
      }
    }
  }

  return result;
}

// =============================================================================
// SnippetDiffView
// =============================================================================

const SnippetDiffView = ({
  snippet,
  index,
  fileName,
}: {
  snippet: SnippetDiff;
  index: number;
  fileName: string;
}) => {
  const lines = useMemo(() => buildHighlightedDiffLines(snippet, fileName), [snippet, fileName]);

  const toolLabel =
    snippet.type === 'write-new'
      ? 'New file'
      : snippet.type === 'write-update'
        ? 'Full rewrite'
        : snippet.type === 'multi-edit'
          ? 'Multi-edit'
          : 'Edit';

  return (
    <div className="overflow-hidden rounded-lg border border-border">
      {/* Snippet header */}
      <div className="flex items-center justify-between border-b border-border bg-surface-raised px-3 py-1.5">
        <span className="text-xs text-text-muted">
          #{index + 1} {toolLabel}
        </span>
        <span className="text-xs text-text-muted">
          {snippet.timestamp ? new Date(snippet.timestamp).toLocaleTimeString() : ''}
        </span>
      </div>

      {/* Diff lines with syntax highlighting (hljs HTML — safe, all input is escaped) */}
      <div className="overflow-x-auto font-mono text-xs leading-5">
        {lines.map((line, i) => {
          let bgClass = '';
          let prefix = ' ';

          if (line.type === 'added') {
            bgClass = 'bg-[var(--diff-added-bg,rgba(46,160,67,0.15))]';
            prefix = '+';
          } else if (line.type === 'removed') {
            bgClass = 'bg-[var(--diff-removed-bg,rgba(248,81,73,0.15))]';
            prefix = '-';
          }

          return (
            <div key={i} className={`flex px-3 ${bgClass}`}>
              <span className="inline-block w-4 shrink-0 select-none text-text-muted opacity-50">
                {prefix}
              </span>
              {/* highlight.js escapes all input text — only produces <span class="hljs-*"> tags */}
              <span
                className="whitespace-pre text-text-secondary"
                dangerouslySetInnerHTML={{ __html: line.html }}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
};

// =============================================================================
// ReviewDiffContent
// =============================================================================

export const ReviewDiffContent = ({ file }: ReviewDiffContentProps) => {
  const nonErrorSnippets = useMemo(() => file.snippets.filter((s) => !s.isError), [file.snippets]);

  return (
    <div className="space-y-4 p-4">
      {nonErrorSnippets.map((snippet, index) => (
        <SnippetDiffView
          key={snippet.toolUseId}
          snippet={snippet}
          index={index}
          fileName={file.relativePath}
        />
      ))}

      {nonErrorSnippets.length === 0 && (
        <div className="py-8 text-center text-sm text-text-muted">No changes to display</div>
      )}
    </div>
  );
};
