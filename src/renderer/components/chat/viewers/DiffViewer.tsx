import React, { useMemo } from 'react';

import {
  CODE_BG,
  CODE_BORDER,
  CODE_FILENAME,
  CODE_HEADER_BG,
  CODE_LINE_NUMBER,
  COLOR_TEXT_MUTED,
  COLOR_TEXT_SECONDARY,
  DIFF_ADDED_BG,
  DIFF_ADDED_BORDER,
  DIFF_ADDED_TEXT,
  DIFF_REMOVED_BG,
  DIFF_REMOVED_BORDER,
  DIFF_REMOVED_TEXT,
  TAG_BG,
  TAG_BORDER,
  TAG_TEXT,
} from '@renderer/constants/cssVariables';
import { getBaseName } from '@renderer/utils/pathUtils';
import { highlightLines } from '@renderer/utils/syntaxHighlighter';
import { formatTokens } from '@shared/utils/tokenFormatting';
import { diffLines as semanticDiffLines } from 'diff';

import { FileIcon } from '../../team/editor/FileIcon';

// =============================================================================
// Types
// =============================================================================

interface DiffViewerProps {
  fileName: string; // The file being edited
  oldString: string; // The original text being replaced
  newString: string; // The new text
  maxHeight?: string; // CSS max-height class (default: "max-h-96")
  tokenCount?: number; // Optional token count to display in header
  syntaxHighlight?: boolean; // Enable syntax highlighting via highlight.js
}

interface DiffLine {
  type: 'removed' | 'added' | 'context';
  content: string;
  lineNumber: number;
}

// =============================================================================
// Diff Algorithm (LCS-based, with semantic fallback for large files)
// =============================================================================

/** Max LCS matrix cells before falling back to semantic diff.
 *  1M cells ≈ 8MB RAM — safe for all platforms. */
const MAX_LCS_CELLS = 1_000_000;

/**
 * Fallback diff using semantic line-diffing from npm `diff` package.
 * Used when LCS matrix would exceed memory threshold.
 */
function generateDiffFallback(oldLines: string[], newLines: string[]): DiffLine[] {
  const oldText = oldLines.join('\n');
  const newText = newLines.join('\n');
  const changes = semanticDiffLines(oldText, newText);

  const result: DiffLine[] = [];
  let lineNumber = 1;

  for (const change of changes) {
    const changeLines = change.value.replace(/\r?\n$/, '').split(/\r?\n/);
    for (const content of changeLines) {
      if (change.added) {
        result.push({ type: 'added', content, lineNumber: lineNumber++ });
      } else if (change.removed) {
        result.push({ type: 'removed', content, lineNumber: lineNumber++ });
      } else {
        result.push({ type: 'context', content, lineNumber: lineNumber++ });
      }
    }
  }

  return result;
}

/**
 * Computes the Longest Common Subsequence matrix for two arrays of strings.
 */
function computeLCSMatrix(oldLines: string[], newLines: string[]): number[][] {
  const m = oldLines.length;
  const n = newLines.length;
  const matrix: number[][] = Array.from({ length: m + 1 }, () =>
    Array.from({ length: n + 1 }, () => 0)
  );

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) {
        matrix[i][j] = matrix[i - 1][j - 1] + 1;
      } else {
        matrix[i][j] = Math.max(matrix[i - 1][j], matrix[i][j - 1]);
      }
    }
  }

  return matrix;
}

/**
 * Backtrack through LCS matrix to generate diff lines.
 * Falls back to semantic diffing for large files to prevent OOM.
 */
function generateDiff(oldLines: string[], newLines: string[]): DiffLine[] {
  if (oldLines.length * newLines.length > MAX_LCS_CELLS) {
    return generateDiffFallback(oldLines, newLines);
  }

  const matrix = computeLCSMatrix(oldLines, newLines);
  const result: DiffLine[] = [];

  let i = oldLines.length;
  let j = newLines.length;
  let lineNumber = 1;

  // Temporary storage for backtracking
  const temp: DiffLine[] = [];

  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      // Lines are the same - context
      temp.push({ type: 'context', content: oldLines[i - 1], lineNumber: 0 });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || matrix[i][j - 1] >= matrix[i - 1][j])) {
      // Line was added
      temp.push({ type: 'added', content: newLines[j - 1], lineNumber: 0 });
      j--;
    } else if (i > 0) {
      // Line was removed
      temp.push({ type: 'removed', content: oldLines[i - 1], lineNumber: 0 });
      i--;
    }
  }

  // Reverse and assign line numbers
  temp.reverse();
  for (const line of temp) {
    line.lineNumber = lineNumber++;
    result.push(line);
  }

  return result;
}

/**
 * Computes diff statistics from old/new strings using the same algorithm as DiffViewer.
 */
export function computeDiffLineStats(
  oldString: string,
  newString: string
): { added: number; removed: number } {
  const oldLines = oldString.split(/\r?\n/);
  const newLines = newString.split(/\r?\n/);
  const diffLines = generateDiff(oldLines, newLines);
  return computeStats(diffLines);
}

/**
 * Computes diff statistics.
 */
function computeStats(diffLines: DiffLine[]): { added: number; removed: number } {
  let added = 0;
  let removed = 0;

  for (const line of diffLines) {
    if (line.type === 'added') added++;
    if (line.type === 'removed') removed++;
  }

  return { added, removed };
}

// =============================================================================
// Language Detection
// =============================================================================

const EXTENSION_LANGUAGE_MAP: Record<string, string> = {
  // JavaScript/TypeScript
  '.ts': 'typescript',
  '.tsx': 'tsx',
  '.js': 'javascript',
  '.jsx': 'jsx',
  '.mjs': 'javascript',
  '.cjs': 'javascript',

  // Python
  '.py': 'python',
  '.pyw': 'python',
  '.pyx': 'python',

  // Web
  '.html': 'html',
  '.htm': 'html',
  '.css': 'css',
  '.scss': 'scss',
  '.sass': 'sass',
  '.less': 'less',

  // Data formats
  '.json': 'json',
  '.jsonl': 'json',
  '.yaml': 'yaml',
  '.yml': 'yaml',
  '.toml': 'toml',
  '.xml': 'xml',

  // Shell
  '.sh': 'bash',
  '.bash': 'bash',
  '.zsh': 'zsh',
  '.fish': 'fish',

  // Systems
  '.rs': 'rust',
  '.go': 'go',
  '.c': 'c',
  '.h': 'c',
  '.cpp': 'cpp',
  '.cc': 'cpp',
  '.hpp': 'hpp',
  '.java': 'java',
  '.kt': 'kotlin',
  '.swift': 'swift',

  // Config
  '.env': 'env',
  '.gitignore': 'gitignore',
  '.dockerignore': 'dockerignore',
  '.md': 'markdown',
  '.mdx': 'mdx',

  // Other
  '.sql': 'sql',
  '.graphql': 'graphql',
  '.gql': 'graphql',
  '.vue': 'vue',
  '.svelte': 'svelte',
  '.rb': 'ruby',
  '.php': 'php',
  '.lua': 'lua',
  '.r': 'r',
  '.R': 'r',
};

/**
 * Infer language from file name/extension.
 */
function inferLanguage(fileName: string): string {
  // Check for dotfiles with specific names
  const baseName = getBaseName(fileName);
  if (baseName === 'Dockerfile') return 'dockerfile';
  if (baseName === 'Makefile') return 'makefile';
  if (baseName.startsWith('.env')) return 'env';

  // Extract extension
  const extMatch = /(\.[^./]+)$/.exec(fileName);
  if (extMatch) {
    const ext = extMatch[1].toLowerCase();
    return EXTENSION_LANGUAGE_MAP[ext] ?? 'text';
  }

  return 'text';
}

// =============================================================================
// Diff Line Component
// =============================================================================

interface DiffLineRowProps {
  line: DiffLine;
  highlightedHtml?: string;
}

const DiffLineRow: React.FC<DiffLineRowProps> = ({ line, highlightedHtml }): React.JSX.Element => {
  // Theme-aware styles using CSS variables
  const getStyles = (
    type: DiffLine['type']
  ): { bg: string; text: string; border: string; prefix: string } => {
    switch (type) {
      case 'removed':
        return {
          bg: DIFF_REMOVED_BG,
          text: DIFF_REMOVED_TEXT,
          border: DIFF_REMOVED_BORDER,
          prefix: '-',
        };
      case 'added':
        return {
          bg: DIFF_ADDED_BG,
          text: DIFF_ADDED_TEXT,
          border: DIFF_ADDED_BORDER,
          prefix: '+',
        };
      default:
        return {
          bg: 'transparent',
          text: COLOR_TEXT_SECONDARY,
          border: 'transparent',
          prefix: ' ',
        };
    }
  };

  const style = getStyles(line.type);

  return (
    <div
      className="flex min-w-full"
      style={{
        backgroundColor: style.bg,
        borderLeft: `3px solid ${style.border}`,
      }}
    >
      {/* Line number */}
      <span
        className="w-10 shrink-0 select-none px-2 text-right"
        style={{ color: CODE_LINE_NUMBER }}
      >
        {line.lineNumber}
      </span>
      {/* Prefix */}
      <span className="w-6 shrink-0 select-none" style={{ color: style.text }}>
        {style.prefix}
      </span>
      {/* Content — optionally syntax-highlighted via hljs (HTML-escaped, safe) */}
      {highlightedHtml !== undefined ? (
        <span
          className="flex-1 whitespace-pre"
          style={{ color: style.text }}
          dangerouslySetInnerHTML={{ __html: highlightedHtml || ' ' }}
        />
      ) : (
        <span className="flex-1 whitespace-pre" style={{ color: style.text }}>
          {line.content ?? ' '}
        </span>
      )}
    </div>
  );
};

// =============================================================================
// Main Component
// =============================================================================

export const DiffViewer: React.FC<DiffViewerProps> = ({
  fileName,
  oldString,
  newString,
  maxHeight = 'max-h-96',
  tokenCount,
  syntaxHighlight = false,
}): React.JSX.Element => {
  // Compute diff
  const oldLines = oldString.split(/\r?\n/);
  const newLines = newString.split(/\r?\n/);
  const diffLines = generateDiff(oldLines, newLines);
  const stats = computeStats(diffLines);

  // Syntax highlighting: build a map from content line → highlighted HTML
  const highlightMap = useMemo(() => {
    if (!syntaxHighlight) return null;
    const oldHtml = highlightLines(oldString, fileName);
    const newHtml = highlightLines(newString, fileName);
    // Map each diff line to its highlighted HTML by tracking old/new line indices
    const map = new Map<number, string>();
    let oldIdx = 0;
    let newIdx = 0;
    for (let i = 0; i < diffLines.length; i++) {
      const line = diffLines[i];
      if (line.type === 'removed') {
        map.set(i, oldHtml[oldIdx++] ?? '');
      } else if (line.type === 'added') {
        map.set(i, newHtml[newIdx++] ?? '');
      } else {
        map.set(i, oldHtml[oldIdx++] ?? '');
        newIdx++;
      }
    }
    return map;
  }, [syntaxHighlight, oldString, newString, fileName, diffLines]);

  // Infer language from file extension
  const detectedLanguage = inferLanguage(fileName);

  // Format summary
  const displayName = getBaseName(fileName);

  return (
    <div
      className="overflow-hidden rounded-lg shadow-sm"
      style={{
        backgroundColor: CODE_BG,
        border: `1px solid ${CODE_BORDER}`,
      }}
    >
      {/* Header - matches CodeBlockViewer style */}
      <div
        className="flex items-center gap-2 px-3 py-2"
        style={{
          backgroundColor: CODE_HEADER_BG,
          borderBottom: `1px solid ${CODE_BORDER}`,
        }}
      >
        <FileIcon fileName={fileName} className="size-4 shrink-0" />
        <span className="truncate font-mono text-sm" style={{ color: CODE_FILENAME }}>
          {displayName}
        </span>
        <span
          className="shrink-0 rounded px-1.5 py-0.5 text-xs"
          style={{
            backgroundColor: TAG_BG,
            color: TAG_TEXT,
            border: `1px solid ${TAG_BORDER}`,
          }}
        >
          {detectedLanguage}
        </span>
        <span style={{ color: COLOR_TEXT_MUTED }}>-</span>
        <span className="shrink-0 text-sm">
          {stats.added > 0 && (
            <span className="mr-1" style={{ color: DIFF_ADDED_TEXT }}>
              +{stats.added}
            </span>
          )}
          {stats.removed > 0 && <span style={{ color: DIFF_REMOVED_TEXT }}>-{stats.removed}</span>}
          {stats.added === 0 && stats.removed === 0 && (
            <span style={{ color: COLOR_TEXT_MUTED }}>Changed</span>
          )}
        </span>
        {tokenCount !== undefined && tokenCount > 0 && (
          <span className="ml-auto text-xs" style={{ color: COLOR_TEXT_MUTED }}>
            ~{formatTokens(tokenCount)} tokens
          </span>
        )}
      </div>

      {/* Diff content */}
      <div className={`overflow-auto font-mono text-xs ${maxHeight}`}>
        <div className="inline-block min-w-full">
          {diffLines.map((line, index) => (
            <DiffLineRow key={index} line={line} highlightedHtml={highlightMap?.get(index)} />
          ))}
          {diffLines.length === 0 && (
            <div className="px-3 py-2 italic" style={{ color: COLOR_TEXT_MUTED }}>
              No changes detected
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
