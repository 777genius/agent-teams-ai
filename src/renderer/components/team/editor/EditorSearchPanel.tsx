/**
 * Custom CodeMirror search/replace panel using the project UI Kit.
 *
 * Replaces the default CodeMirror search panel with a styled version
 * that uses our Input, Button, and Tooltip components for consistent
 * design language across the app.
 */

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';

import {
  closeSearchPanel,
  findNext,
  findPrevious,
  getSearchQuery,
  replaceAll,
  replaceNext,
  SearchQuery,
  setSearchQuery,
} from '@codemirror/search';
import { EditorView, type Panel } from '@codemirror/view';
import { Button } from '@renderer/components/ui/button';
import { Input } from '@renderer/components/ui/input';
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import {
  ArrowDown,
  ArrowUp,
  CaseSensitive,
  ChevronDown,
  ChevronRight,
  Regex,
  WholeWord,
  X,
} from 'lucide-react';

import type { EditorState } from '@codemirror/state';
import type { ViewUpdate } from '@codemirror/view';

// =============================================================================
// Constants
// =============================================================================

const MAX_MATCH_COUNT = 999;

// =============================================================================
// SearchToggleButton
// =============================================================================

interface SearchToggleButtonProps {
  active: boolean;
  onClick: () => void;
  tooltip: string;
  shortcut?: string;
  children: React.ReactNode;
}

const SearchToggleButton = React.memo(function SearchToggleButton({
  active,
  onClick,
  tooltip,
  shortcut,
  children,
}: SearchToggleButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className={cn(
            'flex size-[22px] items-center justify-center rounded transition-colors',
            active
              ? 'bg-blue-500/20 text-blue-400'
              : 'text-[var(--color-text-muted)] hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text-secondary)]'
          )}
          onClick={onClick}
          tabIndex={-1}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">
        <span>{tooltip}</span>
        {shortcut && <span className="ml-1.5 text-[var(--color-text-muted)]">{shortcut}</span>}
      </TooltipContent>
    </Tooltip>
  );
});

// =============================================================================
// Match counter
// =============================================================================

function countMatches(query: SearchQuery, state: EditorState): number {
  if (!query.valid || !query.search) return 0;

  try {
    const cursor = query.getCursor(state);
    let count = 0;
    while (!cursor.next().done) {
      count++;
      if (count > MAX_MATCH_COUNT) return -1;
    }
    return count;
  } catch {
    return 0;
  }
}

// =============================================================================
// EditorSearchPanelContent
// =============================================================================

interface EditorSearchPanelContentProps {
  view: EditorView;
  initialSearch: string;
  initialReplace: string;
  initialCaseSensitive: boolean;
  initialRegexp: boolean;
  initialWholeWord: boolean;
  registerUpdateNotifier: (cb: () => void) => void;
}

const EditorSearchPanelContent = ({
  view,
  initialSearch,
  initialReplace,
  initialCaseSensitive,
  initialRegexp,
  initialWholeWord,
  registerUpdateNotifier,
}: EditorSearchPanelContentProps) => {
  const [searchText, setSearchText] = useState(initialSearch);
  const [replaceText, setReplaceText] = useState(initialReplace);
  const [caseSensitive, setCaseSensitive] = useState(initialCaseSensitive);
  const [useRegexp, setUseRegexp] = useState(initialRegexp);
  const [wholeWord, setWholeWord] = useState(initialWholeWord);
  const [showReplace, setShowReplace] = useState(false);
  const [updateTick, setUpdateTick] = useState(0);

  const searchInputRef = useRef<HTMLInputElement>(null);

  // Focus search input on mount
  useEffect(() => {
    requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });
  }, []);

  // Build query object (memoized)
  const query = useMemo(
    () =>
      new SearchQuery({
        search: searchText,
        replace: replaceText,
        caseSensitive,
        regexp: useRegexp,
        wholeWord,
      }),
    [searchText, replaceText, caseSensitive, useRegexp, wholeWord]
  );

  // Dispatch search query to CodeMirror for highlighting
  useEffect(() => {
    view.dispatch({ effects: setSearchQuery.of(query) });
  }, [query, view]);

  // Register for editor updates (doc changes → recount via updateTick)
  useEffect(() => {
    registerUpdateNotifier(() => setUpdateTick((t) => t + 1));
  }, [registerUpdateNotifier]);

  // Match count — derived from query + document state
  // updateTick triggers recount on document changes (e.g. after replace)
  const matchCount = useMemo(
    () => countMatches(query, view.state),
    // eslint-disable-next-line react-hooks/exhaustive-deps -- updateTick is a proxy dep for view.state changes
    [query, view, updateTick]
  );

  // Navigation
  const handleFindNext = useCallback(() => {
    findNext(view);
  }, [view]);

  const handleFindPrev = useCallback(() => {
    findPrevious(view);
  }, [view]);

  // Replace
  const handleReplaceNext = useCallback(() => {
    replaceNext(view);
  }, [view]);

  const handleReplaceAll = useCallback(() => {
    replaceAll(view);
  }, [view]);

  // Close
  const handleClose = useCallback(() => {
    closeSearchPanel(view);
    view.focus();
  }, [view]);

  // Keyboard handlers
  const handleSearchKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (e.shiftKey) {
          findPrevious(view);
        } else {
          findNext(view);
        }
      }
    },
    [view, handleClose]
  );

  const handleReplaceKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handleClose();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleReplaceNext();
      }
    },
    [handleClose, handleReplaceNext]
  );

  // Match count display
  const matchCountText = searchText
    ? matchCount === -1
      ? `${MAX_MATCH_COUNT}+`
      : matchCount === 0
        ? 'No results'
        : `${matchCount} found`
    : '';

  return (
    <TooltipProvider delayDuration={400}>
      <div className="flex flex-col gap-1 px-2 py-1.5">
        {/* Search row */}
        <div className="flex items-center gap-1">
          {/* Toggle replace visibility */}
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                className="flex h-[22px] w-5 items-center justify-center rounded text-[var(--color-text-muted)] transition-colors hover:text-[var(--color-text-secondary)]"
                onClick={() => setShowReplace((prev) => !prev)}
                tabIndex={-1}
              >
                {showReplace ? (
                  <ChevronDown className="size-3.5" />
                ) : (
                  <ChevronRight className="size-3.5" />
                )}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">Toggle Replace</TooltipContent>
          </Tooltip>

          {/* Search input */}
          <Input
            ref={searchInputRef}
            className="h-[26px] min-w-[180px] flex-1 rounded border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs"
            placeholder="Search"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            onKeyDown={handleSearchKeyDown}
            spellCheck={false}
          />

          {/* Toggle buttons */}
          <SearchToggleButton
            active={caseSensitive}
            onClick={() => setCaseSensitive((prev) => !prev)}
            tooltip="Match Case"
          >
            <CaseSensitive className="size-[14px]" />
          </SearchToggleButton>

          <SearchToggleButton
            active={wholeWord}
            onClick={() => setWholeWord((prev) => !prev)}
            tooltip="Match Whole Word"
          >
            <WholeWord className="size-[14px]" />
          </SearchToggleButton>

          <SearchToggleButton
            active={useRegexp}
            onClick={() => setUseRegexp((prev) => !prev)}
            tooltip="Use Regular Expression"
          >
            <Regex className="size-[14px]" />
          </SearchToggleButton>

          {/* Separator */}
          <div className="mx-0.5 h-4 w-px bg-[var(--color-border)]" />

          {/* Match count */}
          {matchCountText && (
            <span
              className={cn(
                'min-w-[60px] whitespace-nowrap text-center text-xs tabular-nums',
                matchCount === 0 && searchText ? 'text-red-400' : 'text-[var(--color-text-muted)]'
              )}
            >
              {matchCountText}
            </span>
          )}

          {/* Navigation */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-[22px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                onClick={handleFindPrev}
                disabled={matchCount === 0}
                tabIndex={-1}
              >
                <ArrowUp className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Previous Match <span className="text-[var(--color-text-muted)]">⇧Enter</span>
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-[22px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                onClick={handleFindNext}
                disabled={matchCount === 0}
                tabIndex={-1}
              >
                <ArrowDown className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Next Match <span className="text-[var(--color-text-muted)]">Enter</span>
            </TooltipContent>
          </Tooltip>

          {/* Close */}
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="size-[22px] text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                onClick={handleClose}
                tabIndex={-1}
              >
                <X className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Close <span className="text-[var(--color-text-muted)]">Esc</span>
            </TooltipContent>
          </Tooltip>
        </div>

        {/* Replace row */}
        {showReplace && (
          <div className="flex items-center gap-1">
            {/* Spacer to align with search input */}
            <div className="w-5 shrink-0" />

            <Input
              className="h-[26px] min-w-[180px] flex-1 rounded border-[var(--color-border)] bg-[var(--color-surface)] px-2 text-xs"
              placeholder="Replace"
              value={replaceText}
              onChange={(e) => setReplaceText(e.target.value)}
              onKeyDown={handleReplaceKeyDown}
              spellCheck={false}
            />

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-[22px] px-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  onClick={handleReplaceNext}
                  disabled={matchCount === 0}
                  tabIndex={-1}
                >
                  Replace
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Replace Next</TooltipContent>
            </Tooltip>

            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="sm"
                  className="h-[22px] px-2 text-xs text-[var(--color-text-muted)] hover:text-[var(--color-text)]"
                  onClick={handleReplaceAll}
                  disabled={matchCount === 0}
                  tabIndex={-1}
                >
                  All
                </Button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Replace All</TooltipContent>
            </Tooltip>
          </div>
        )}
      </div>
    </TooltipProvider>
  );
};

// =============================================================================
// Panel factory for CodeMirror
// =============================================================================

export function createSearchPanel(view: EditorView): Panel {
  const dom = document.createElement('div');

  const root = createRoot(dom);

  // Get initial values
  const existingQuery = getSearchQuery(view.state);
  const sel = view.state.selection.main;
  const selText = sel.empty ? '' : view.state.sliceDoc(sel.from, sel.to);
  const initialSearch = selText && !selText.includes('\n') ? selText : existingQuery.search;

  // Mutable ref for update notifications from CodeMirror
  let notifyUpdate: (() => void) | null = null;

  root.render(
    <EditorSearchPanelContent
      view={view}
      initialSearch={initialSearch}
      initialReplace={existingQuery.replace}
      initialCaseSensitive={existingQuery.caseSensitive}
      initialRegexp={existingQuery.regexp}
      initialWholeWord={existingQuery.wholeWord}
      registerUpdateNotifier={(cb) => {
        notifyUpdate = cb;
      }}
    />
  );

  return {
    dom,
    top: true,
    update(update: ViewUpdate) {
      if (update.docChanged) {
        notifyUpdate?.();
      }
    },
    destroy() {
      notifyUpdate = null;
      root.unmount();
    },
  };
}

// =============================================================================
// Theme: panel container + search match highlighting
// =============================================================================

export const editorSearchPanelTheme = EditorView.theme({
  '.cm-panels': {
    backgroundColor: 'var(--color-surface)',
    color: 'var(--color-text)',
    fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
  },
  '.cm-panels-top': {
    borderBottom: '1px solid var(--color-border)',
  },
  '.cm-panels-bottom': {
    borderTop: '1px solid var(--color-border)',
  },
  // Search match highlighting in editor content
  '.cm-searchMatch': {
    backgroundColor: 'var(--highlight-bg-inactive)',
    borderRadius: '2px',
  },
  '.cm-searchMatch-selected': {
    backgroundColor: 'var(--highlight-bg) !important',
    borderRadius: '2px',
  },
});
