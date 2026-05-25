import React, { memo, useMemo, useState } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { getBaseName } from '@renderer/utils/pathUtils';
import { createLogger } from '@shared/utils/logger';
import { Check, Copy, FileCode } from 'lucide-react';

const logger = createLogger('Component:CodeBlockViewer');

import { highlightLine } from './syntaxHighlighter';

// =============================================================================
// Types
// =============================================================================

interface CodeBlockViewerProps {
  fileName: string; // e.g., "src/components/Header.tsx"
  content: string; // The actual file content
  language?: string; // Inferred from file extension if not provided
  startLine?: number; // If partial read, starting line
  endLine?: number; // If partial read, ending line
  maxHeight?: string; // CSS max-height class (default: "max-h-96")
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
// Component
// =============================================================================

export const CodeBlockViewer = memo(function CodeBlockViewer({
  fileName,
  content,
  language,
  startLine = 1,
  endLine,
  maxHeight = 'max-h-96',
}: CodeBlockViewerProps): React.JSX.Element {
  const { t } = useAppTranslation('common');
  const [isCopied, setIsCopied] = useState(false);

  // Infer language from file extension if not provided
  const detectedLanguage = language ?? inferLanguage(fileName);

  // Split content into lines
  const lines = useMemo(() => content.split('\n'), [content]);
  const totalLines = lines.length;

  // Calculate the actual line range for display
  const actualEndLine = endLine ?? startLine + totalLines - 1;

  // Handle copy
  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(content);
      setIsCopied(true);
      setTimeout(() => setIsCopied(false), 2000);
    } catch {
      logger.error('Failed to copy to clipboard');
    }
  };

  // Extract just the filename for display
  const displayFileName = getBaseName(fileName) || fileName;

  return (
    <div
      className="overflow-hidden rounded-lg shadow-sm"
      style={{
        backgroundColor: 'var(--code-bg)',
        border: '1px solid var(--code-border)',
      }}
    >
      {/* Header */}
      <div
        className="flex items-center justify-between px-3 py-2"
        style={{
          backgroundColor: 'var(--code-header-bg)',
          borderBottom: '1px solid var(--code-border)',
        }}
      >
        <div className="flex min-w-0 items-center gap-2">
          <FileCode className="size-4 shrink-0" style={{ color: 'var(--color-text-muted)' }} />
          <span
            className="truncate font-mono text-sm"
            title={fileName}
            style={{ color: 'var(--code-filename)' }}
          >
            {displayFileName}
          </span>
          {(startLine > 1 || endLine) && (
            <span className="shrink-0 text-xs" style={{ color: 'var(--color-text-muted)' }}>
              {t('code.linesParenthesized', { from: startLine, to: actualEndLine })}
            </span>
          )}
          <span
            className="shrink-0 rounded px-1.5 py-0.5 text-xs"
            style={{
              backgroundColor: 'var(--tag-bg)',
              color: 'var(--tag-text)',
              border: '1px solid var(--tag-border)',
            }}
          >
            {detectedLanguage}
          </span>
        </div>

        {/* Copy button */}
        <button
          onClick={handleCopy}
          className="rounded p-1 transition-colors hover:opacity-80"
          title={t('actions.copyToClipboard')}
          style={{ backgroundColor: 'transparent' }}
        >
          {isCopied ? (
            <Check className="size-4" style={{ color: 'var(--badge-success-bg)' }} />
          ) : (
            <Copy className="size-4" style={{ color: 'var(--color-text-muted)' }} />
          )}
        </button>
      </div>

      {/* Code content */}
      <div className={`overflow-auto ${maxHeight}`}>
        <pre className="m-0 bg-transparent p-0">
          <code className="block font-mono text-xs leading-relaxed">
            {lines.map((line, index) => {
              const lineNumber = startLine + index;
              return (
                <div key={index} className="flex hover:bg-[var(--color-surface-overlay)]">
                  {/* Line number */}
                  <span
                    className="w-12 shrink-0 select-none px-3 py-0.5 text-right"
                    style={{
                      color: 'var(--code-line-number)',
                      borderRight: '1px solid var(--code-border)',
                    }}
                  >
                    {lineNumber}
                  </span>
                  {/* Code line */}
                  <span
                    className="flex-1 whitespace-pre px-4 py-0.5"
                    style={{ color: 'var(--color-text)' }}
                  >
                    {highlightLine(line, detectedLanguage)}
                  </span>
                </div>
              );
            })}
          </code>
        </pre>
      </div>
    </div>
  );
});
