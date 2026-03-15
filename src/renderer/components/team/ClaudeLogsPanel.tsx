/**
 * ClaudeLogsPanel
 *
 * Shared rendering surface for Claude logs — used both in the compact sidebar
 * section and the fullscreen dialog. Renders the toolbar (search, filter,
 * pending button), the rich log viewer, and empty/error states.
 */

import React from 'react';

import { Button } from '@renderer/components/ui/button';
import { cn } from '@renderer/lib/utils';
import { Search, X } from 'lucide-react';

import { ClaudeLogsFilterPopover } from './ClaudeLogsFilterPopover';
import { CliLogsRichView } from './CliLogsRichView';

import type { ClaudeLogsController } from './useClaudeLogsController';

// =============================================================================
// Props
// =============================================================================

interface ClaudeLogsPanelProps {
  ctrl: ClaudeLogsController;
  /** Maximum height class for the log viewer (e.g. "max-h-[213px]" for compact). */
  viewerClassName?: string;
  /** Extra className for the panel wrapper. */
  className?: string;
}

// =============================================================================
// Component
// =============================================================================

export const ClaudeLogsPanel = ({
  ctrl,
  viewerClassName,
  className,
}: ClaudeLogsPanelProps): React.JSX.Element => {
  const {
    data,
    loading,
    loadingMore,
    error,
    pendingNewCount,
    isAlive,
    filteredText,
    showMoreVisible,
    searchQuery,
    setSearchQuery,
    filter,
    setFilter,
    filterOpen,
    setFilterOpen,
    viewerState,
    onViewerStateChange,
    applyPending,
    loadOlderLogs,
    containerRefCallback,
    handleScroll,
  } = ctrl;

  return (
    <div className={cn('min-w-0', className)}>
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-2 pb-2">
        <span className="text-[11px] text-[var(--color-text-muted)]">
          {data.total > 0 ? (
            <>
              <span className="font-mono">{Math.min(data.total, data.lines.length)}</span> of{' '}
              <span className="font-mono">{data.total}</span>
            </>
          ) : isAlive ? (
            'No logs yet.'
          ) : (
            'Team is not running.'
          )}
        </span>
        <div className="flex items-center gap-2">
          {data.total > 0 ? (
            <>
              <div className="flex w-48 items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-transparent px-2 py-1">
                <Search size={12} className="shrink-0 text-[var(--color-text-muted)]" />
                <input
                  type="text"
                  placeholder="Search logs..."
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  className="min-w-0 flex-1 bg-transparent text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
                    onClick={() => setSearchQuery('')}
                    aria-label="Clear search"
                  >
                    <X size={14} />
                  </button>
                )}
              </div>
              <ClaudeLogsFilterPopover
                filter={filter}
                open={filterOpen}
                onOpenChange={setFilterOpen}
                onApply={setFilter}
              />
            </>
          ) : null}
          {pendingNewCount > 0 && (
            <Button
              variant="outline"
              size="sm"
              className="h-7 border-blue-500/30 bg-blue-600 px-2 text-xs text-white hover:bg-blue-500"
              onClick={applyPending}
            >
              +{pendingNewCount} new
            </Button>
          )}
        </div>
      </div>

      {/* Log viewer */}
      <div className={cn('rounded', loading && 'opacity-80')}>
        {error ? <p className="p-2 text-xs text-red-300">{error}</p> : null}
        {!error && filteredText.trim().length > 0 ? (
          <CliLogsRichView
            cliLogsTail={filteredText}
            order="newest-first"
            searchQueryOverride={searchQuery.trim() ? searchQuery : undefined}
            className={cn('p-2', viewerClassName)}
            containerRefCallback={containerRefCallback}
            onScroll={handleScroll}
            viewerState={viewerState}
            onViewerStateChange={onViewerStateChange}
            footer={
              showMoreVisible ? (
                <div className="flex justify-center py-1.5">
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-7 px-2 text-xs"
                    onClick={() => void loadOlderLogs()}
                    disabled={loadingMore}
                  >
                    {loadingMore ? 'Loading…' : 'Show more'}
                  </Button>
                </div>
              ) : null
            }
          />
        ) : null}
        {!error && data.lines.length === 0 && isAlive ? (
          <p className="p-2 text-xs text-[var(--color-text-muted)]">
            {loading ? 'Loading…' : 'No logs captured.'}
          </p>
        ) : null}
        {!error && data.lines.length > 0 && filteredText.trim().length === 0 ? (
          <p className="p-2 text-xs text-[var(--color-text-muted)]">No matching logs.</p>
        ) : null}
      </div>
    </div>
  );
};
