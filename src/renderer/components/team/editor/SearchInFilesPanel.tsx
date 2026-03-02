/**
 * Search in files panel (Cmd+Shift+F).
 *
 * Debounced literal string search with cancellation.
 * Results are clickable to open the file at the matched line.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

import { api } from '@renderer/api';
import { Button } from '@renderer/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { Loader2, Search, X } from 'lucide-react';

import { FileIcon } from './FileIcon';

import type { SearchFileResult, SearchInFilesResult } from '@shared/types/editor';

// =============================================================================
// Types
// =============================================================================

interface SearchInFilesPanelProps {
  projectPath: string;
  onClose: () => void;
  onSelectMatch: (filePath: string, line: number) => void;
}

// =============================================================================
// Constants
// =============================================================================

const DEBOUNCE_MS = 300;

// =============================================================================
// Component
// =============================================================================

export const SearchInFilesPanel = ({
  projectPath,
  onClose,
  onSelectMatch,
}: SearchInFilesPanelProps): React.ReactElement => {
  const [query, setQuery] = useState('');
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [results, setResults] = useState<SearchInFilesResult | null>(null);
  const [searching, setSearching] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [expandedFiles, setExpandedFiles] = useState<Set<string>>(new Set());

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<ReturnType<typeof setTimeout>>();
  // Monotonic request ID — prevents stale results from overwriting fresh ones
  const requestIdRef = useRef(0);

  // Focus input on mount
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Escape closes panel (capture phase to prevent overlay close)
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown, true);
    return () => window.removeEventListener('keydown', handleKeyDown, true);
  }, [onClose]);

  const doSearch = useCallback(async (searchQuery: string, isCaseSensitive: boolean) => {
    if (!searchQuery.trim()) {
      setResults(null);
      setSearching(false);
      setError(null);
      return;
    }

    // Bump request ID — any in-flight request with a lower ID is stale
    const myRequestId = ++requestIdRef.current;

    setSearching(true);
    setError(null);

    try {
      const result = await api.editor.searchInFiles({
        query: searchQuery,
        caseSensitive: isCaseSensitive,
      });

      // Discard result if a newer request was fired while we were waiting
      if (requestIdRef.current !== myRequestId) return;

      setResults(result);

      // Auto-expand first few files
      const firstFiles = new Set(result.results.slice(0, 5).map((r) => r.filePath));
      setExpandedFiles(firstFiles);
    } catch (err) {
      if (requestIdRef.current !== myRequestId) return;
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
    } finally {
      if (requestIdRef.current === myRequestId) {
        setSearching(false);
      }
    }
  }, []);

  const handleQueryChange = useCallback(
    (value: string) => {
      setQuery(value);
      if (debounceRef.current) clearTimeout(debounceRef.current);

      debounceRef.current = setTimeout(() => {
        void doSearch(value, caseSensitive);
      }, DEBOUNCE_MS);
    },
    [caseSensitive, doSearch]
  );

  const handleCaseSensitiveToggle = useCallback(() => {
    const newValue = !caseSensitive;
    setCaseSensitive(newValue);
    if (query.trim()) {
      if (debounceRef.current) clearTimeout(debounceRef.current);
      void doSearch(query, newValue);
    }
  }, [caseSensitive, query, doSearch]);

  const toggleFileExpanded = useCallback((filePath: string) => {
    setExpandedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) {
        next.delete(filePath);
      } else {
        next.add(filePath);
      }
      return next;
    });
  }, []);

  const getRelativePath = useCallback(
    (filePath: string) => {
      return filePath.startsWith(projectPath) ? filePath.slice(projectPath.length + 1) : filePath;
    },
    [projectPath]
  );

  return (
    <div className="flex h-full flex-col border-r border-border bg-surface-sidebar">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border px-3 py-2">
        <span className="text-xs font-medium text-text-secondary">Search in Files</span>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className="size-6 text-text-muted"
              onClick={onClose}
              aria-label="Close search"
            >
              <X className="size-3.5" />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom">Close search (Esc)</TooltipContent>
        </Tooltip>
      </div>

      {/* Search input */}
      <div className="border-b border-border p-2">
        <div className="flex items-center gap-1 rounded border border-border bg-surface px-2 py-1">
          <Search className="size-3.5 shrink-0 text-text-muted" />
          <input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => handleQueryChange(e.target.value)}
            placeholder="Search..."
            className="flex-1 bg-transparent text-xs text-text outline-none placeholder:text-text-muted"
          />
          {searching && <Loader2 className="size-3 shrink-0 animate-spin text-text-muted" />}
        </div>
        <div className="mt-1.5 flex items-center gap-2">
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={handleCaseSensitiveToggle}
                className={`rounded px-1.5 py-0.5 text-[10px] font-medium transition-colors ${
                  caseSensitive
                    ? 'bg-blue-500/20 text-blue-400'
                    : 'text-text-muted hover:bg-surface-raised'
                }`}
                aria-label="Match Case"
                aria-pressed={caseSensitive}
              >
                Aa
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Match Case</TooltipContent>
          </Tooltip>
        </div>
      </div>

      {/* Results */}
      <div className="flex-1 overflow-y-auto">
        {error && <div className="p-3 text-xs text-red-400">{error}</div>}

        {results?.totalMatches === 0 && query.trim() && (
          <div className="p-4 text-center text-xs text-text-muted">No results found</div>
        )}

        {results && results.totalMatches > 0 && (
          <>
            <div className="border-b border-border px-3 py-1.5 text-[10px] text-text-muted">
              {results.totalMatches} match{results.totalMatches !== 1 ? 'es' : ''} in{' '}
              {results.results.length} file{results.results.length !== 1 ? 's' : ''}
              {results.truncated && ' (truncated)'}
            </div>
            {results.results.map((fileResult) => (
              <SearchFileGroup
                key={fileResult.filePath}
                fileResult={fileResult}
                relativePath={getRelativePath(fileResult.filePath)}
                expanded={expandedFiles.has(fileResult.filePath)}
                onToggle={() => toggleFileExpanded(fileResult.filePath)}
                onSelectMatch={(line) => onSelectMatch(fileResult.filePath, line)}
                query={query}
                caseSensitive={caseSensitive}
              />
            ))}
          </>
        )}
      </div>
    </div>
  );
};

// =============================================================================
// File group
// =============================================================================

interface SearchFileGroupProps {
  fileResult: SearchFileResult;
  relativePath: string;
  expanded: boolean;
  onToggle: () => void;
  onSelectMatch: (line: number) => void;
  query: string;
  caseSensitive: boolean;
}

const SearchFileGroup = ({
  fileResult,
  relativePath,
  expanded,
  onToggle,
  onSelectMatch,
  query,
  caseSensitive,
}: SearchFileGroupProps): React.ReactElement => {
  const fileName = relativePath.split('/').pop() ?? relativePath;
  const dirPath = relativePath.includes('/')
    ? relativePath.slice(0, relativePath.lastIndexOf('/'))
    : '';
  return (
    <div className="border-border/50 border-b">
      <button
        onClick={onToggle}
        className="flex w-full items-center gap-1.5 px-3 py-1 text-left transition-colors hover:bg-surface-raised"
      >
        <span className="text-[10px] text-text-muted">{expanded ? '▼' : '▶'}</span>
        <FileIcon fileName={fileName} className="size-3.5" />
        <span className="truncate text-xs font-medium text-text">{fileName}</span>
        {dirPath && <span className="ml-1 truncate text-[10px] text-text-muted">{dirPath}</span>}
        <span className="ml-auto shrink-0 text-[10px] text-text-muted">
          {fileResult.matches.length}
        </span>
      </button>
      {expanded && (
        <div className="pb-1">
          {fileResult.matches.map((match, idx) => (
            <button
              key={`${match.line}-${idx}`}
              onClick={() => onSelectMatch(match.line)}
              className="flex w-full items-center gap-2 px-6 py-0.5 text-left transition-colors hover:bg-surface-raised"
            >
              <span className="w-8 shrink-0 text-right text-[10px] text-text-muted">
                {match.line}
              </span>
              <HighlightedLine
                text={match.lineContent}
                query={query}
                caseSensitive={caseSensitive}
              />
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// =============================================================================
// Highlighted line
// =============================================================================

interface HighlightedLineProps {
  text: string;
  query: string;
  caseSensitive: boolean;
}

const HighlightedLine = React.memo(function HighlightedLine({
  text,
  query,
  caseSensitive,
}: HighlightedLineProps): React.ReactElement {
  if (!query) {
    return <span className="truncate text-[11px] text-text-secondary">{text}</span>;
  }

  const searchText = caseSensitive ? text : text.toLowerCase();
  const searchQuery = caseSensitive ? query : query.toLowerCase();
  const parts: React.ReactNode[] = [];
  let lastIndex = 0;

  let idx = searchText.indexOf(searchQuery);
  while (idx !== -1) {
    if (idx > lastIndex) {
      parts.push(
        <span key={`t-${lastIndex}`} className="text-text-secondary">
          {text.slice(lastIndex, idx)}
        </span>
      );
    }
    parts.push(
      <span key={`h-${idx}`} className="rounded bg-yellow-500/30 text-yellow-200">
        {text.slice(idx, idx + query.length)}
      </span>
    );
    lastIndex = idx + query.length;
    idx = searchText.indexOf(searchQuery, lastIndex);
  }

  if (lastIndex < text.length) {
    parts.push(
      <span key={`t-${lastIndex}`} className="text-text-secondary">
        {text.slice(lastIndex)}
      </span>
    );
  }

  return <span className="truncate text-[11px]">{parts}</span>;
});
