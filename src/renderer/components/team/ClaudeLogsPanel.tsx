/**
 * ClaudeLogsPanel
 *
 * Shared rendering surface for Claude logs — used both in the compact sidebar
 * section and the fullscreen dialog. Renders the toolbar (search, filter,
 * pending button), the rich log viewer, and empty/error states.
 */

import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
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
  viewerMaxHeight?: number;
  /** Extra className for the panel wrapper. */
  className?: string;
  compactMetaInTooltip?: boolean;
  toolbarAccessory?: React.ReactNode;
  toolbarControlsStart?: React.ReactNode;
}

type ClaudeLogsToolbarProps = Pick<
  ClaudeLogsController,
  'searchQuery' | 'setSearchQuery' | 'filter' | 'setFilter' | 'filterOpen' | 'setFilterOpen'
> & {
  metadata?: React.ReactNode;
  hasContent?: boolean;
  compactMetaInTooltip?: boolean;
  toolbarAccessory?: React.ReactNode;
  toolbarControlsStart?: React.ReactNode;
  pendingAction?: React.ReactNode;
};

/** Presentation shared by captured Host facts and the original raw log reader. */
export const ClaudeLogsToolbar = ({
  searchQuery,
  setSearchQuery,
  filter,
  setFilter,
  filterOpen,
  setFilterOpen,
  metadata,
  hasContent = true,
  compactMetaInTooltip = false,
  toolbarAccessory,
  toolbarControlsStart,
  pendingAction,
}: ClaudeLogsToolbarProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <div className="flex shrink-0 items-center justify-between gap-2 pb-2">
      <span className="text-[11px] text-[var(--color-text-muted)]">{metadata}</span>
      <div className="flex min-w-0 items-center justify-end gap-2">
        {toolbarControlsStart ? (
          <div className="min-w-0 shrink-0">{toolbarControlsStart}</div>
        ) : null}
        {hasContent ? (
          <div
            className={cn(
              'flex items-center gap-1.5 rounded-md border border-[var(--color-border)] bg-[var(--color-form-control-bg)] px-2 py-1',
              compactMetaInTooltip ? 'min-w-0 max-w-48 flex-1' : 'w-48'
            )}
          >
            <Search size={12} className="shrink-0 text-[var(--color-text-muted)]" />
            <input
              type="text"
              placeholder={t('claudeLogs.searchPlaceholder')}
              value={searchQuery}
              onChange={(event) => setSearchQuery(event.target.value)}
              className="min-w-0 flex-1 bg-transparent text-xs text-[var(--color-text)] placeholder:text-[var(--color-text-muted)] focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                className="shrink-0 rounded p-0.5 text-[var(--color-text-muted)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
                onClick={() => setSearchQuery('')}
                aria-label={t('claudeLogs.clearSearch')}
              >
                <X size={14} />
              </button>
            )}
          </div>
        ) : null}
        {toolbarAccessory}
        {hasContent ? (
          <ClaudeLogsFilterPopover
            filter={filter}
            open={filterOpen}
            onOpenChange={setFilterOpen}
            onApply={setFilter}
          />
        ) : null}
        {pendingAction}
      </div>
    </div>
  );
};

// =============================================================================
// Component
// =============================================================================

export const ClaudeLogsPanel = ({
  ctrl,
  viewerClassName,
  viewerMaxHeight,
  className,
  compactMetaInTooltip = false,
  toolbarAccessory,
  toolbarControlsStart,
}: ClaudeLogsPanelProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
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

  const rawLineLabel = t('claudeLogs.rawLineCount', {
    count: data.total,
    formattedCount: data.total.toLocaleString(),
  });
  const rawLinesCapturedLabel = t('claudeLogs.rawLinesCaptured', { count: rawLineLabel });
  const emptyRawLogsMessage =
    data.total > 0 ? t('claudeLogs.emptyRawLogs', { count: rawLinesCapturedLabel }) : undefined;

  return (
    <div className={cn('min-w-0', className)}>
      <ClaudeLogsToolbar
        searchQuery={searchQuery}
        setSearchQuery={setSearchQuery}
        filter={filter}
        setFilter={setFilter}
        filterOpen={filterOpen}
        setFilterOpen={setFilterOpen}
        metadata={
          data.total > 0
            ? rawLinesCapturedLabel
            : isAlive
              ? t('claudeLogs.noLogsYet')
              : t('claudeLogs.teamNotRunning')
        }
        hasContent={data.total > 0}
        compactMetaInTooltip={compactMetaInTooltip}
        toolbarAccessory={toolbarAccessory}
        toolbarControlsStart={toolbarControlsStart}
        pendingAction={
          pendingNewCount > 0 ? (
            <Button
              variant="outline"
              size="sm"
              className="h-7 border-blue-500/30 bg-blue-600 px-2 text-xs text-white hover:bg-blue-500"
              onClick={applyPending}
            >
              {t('claudeLogs.newCount', { count: pendingNewCount })}
            </Button>
          ) : null
        }
      />

      {/* Log viewer */}
      <div className={cn('rounded', loading && 'opacity-80')}>
        {error ? <p className="p-2 text-xs text-red-300">{error}</p> : null}
        {!error && filteredText.trim().length > 0 ? (
          <CliLogsRichView
            cliLogsTail={filteredText}
            order="newest-first"
            searchQueryOverride={searchQuery.trim() ? searchQuery : undefined}
            className={cn('p-2', viewerClassName)}
            style={
              viewerMaxHeight
                ? { height: `${viewerMaxHeight}px`, maxHeight: `${viewerMaxHeight}px` }
                : undefined
            }
            containerRefCallback={containerRefCallback}
            onScroll={handleScroll}
            compactMetaInTooltip={compactMetaInTooltip}
            emptyMessageOverride={emptyRawLogsMessage}
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
                    {loadingMore ? t('claudeLogs.loading') : t('claudeLogs.showMore')}
                  </Button>
                </div>
              ) : null
            }
          />
        ) : null}
        {!error && data.lines.length === 0 && isAlive ? (
          <p className="p-2 text-xs text-[var(--color-text-muted)]">
            {loading ? t('claudeLogs.loading') : t('claudeLogs.noLogsCaptured')}
          </p>
        ) : null}
        {!error && data.lines.length > 0 && filteredText.trim().length === 0 ? (
          <p className="p-2 text-xs text-[var(--color-text-muted)]">
            {t('claudeLogs.noMatchingLogs')}
          </p>
        ) : null}
      </div>
    </div>
  );
};
