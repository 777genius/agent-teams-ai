import React, { useMemo, useState } from 'react';

import { Button } from '@renderer/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { cn } from '@renderer/lib/utils';
import { AlertTriangle, Check, CircleDot, History, Loader2, RotateCcw, X } from 'lucide-react';

import { describeReviewAction, takeRecentReviewActions } from './reviewActionPresentation';

import type { ReviewActionTone, ReviewFileLabelResolver } from './reviewActionPresentation';
import type { ReviewActionPersistenceStatus } from './reviewActionState';
import type { ReviewRedoAction, ReviewUndoAction } from '@shared/types';

const HISTORY_INITIAL_LIMIT = 12;
const HISTORY_REVEAL_BATCH = 50;

interface ReviewActionHistoryPopoverProps {
  undoHistory: readonly ReviewUndoAction[];
  redoHistory: readonly ReviewRedoAction[];
  resolveFileLabel?: ReviewFileLabelResolver;
  persistenceStatus?: ReviewActionPersistenceStatus;
  onRetryPersistence?: () => void;
}

interface ReviewHistorySectionProps {
  stackName: 'undo' | 'redo';
  title: string;
  emptyLabel: string;
  actions: readonly ReviewUndoAction[];
  totalCount: number;
  nextLabel: string;
  resolveFileLabel?: ReviewFileLabelResolver;
  onShowOlder: () => void;
}

function formatActionTime(createdAt: string): string | null {
  const timestamp = new Date(createdAt);
  if (Number.isNaN(timestamp.getTime())) return null;
  return timestamp.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

const ToneIcon = ({ tone }: { tone: ReviewActionTone }): React.ReactElement => {
  if (tone === 'accept') return <Check className="size-3.5 text-green-400" />;
  if (tone === 'reject') return <X className="size-3.5 text-red-400" />;
  if (tone === 'restore') return <RotateCcw className="size-3.5 text-blue-400" />;
  return <CircleDot className="size-3.5 text-text-muted" />;
}

const ReviewHistorySection = ({
  stackName,
  title,
  emptyLabel,
  actions,
  totalCount,
  nextLabel,
  resolveFileLabel,
  onShowOlder,
}: ReviewHistorySectionProps): React.ReactElement => {
  const hiddenCount = Math.max(0, totalCount - actions.length);
  const revealCount = Math.min(hiddenCount, HISTORY_REVEAL_BATCH);
  return (
    <section>
      <div className="flex items-center justify-between px-3 py-2 text-[11px] font-medium uppercase tracking-wide text-text-muted">
        <span>{title}</span>
        <span>{totalCount}</span>
      </div>
      {actions.length === 0 ? (
        <div className="px-3 pb-3 text-xs text-text-muted">{emptyLabel}</div>
      ) : (
        <div className="space-y-0.5 px-1.5 pb-2">
          {actions.map((action, index) => {
            const presentation = describeReviewAction(action, resolveFileLabel);
            const timestamp = formatActionTime(action.createdAt);
            return (
              <div
                key={action.id}
                data-review-history-action={action.id}
                className={cn(
                  'flex min-w-0 items-start gap-2 rounded px-2 py-1.5',
                  index === 0 && 'bg-surface-raised'
                )}
              >
                <span className="mt-0.5 shrink-0">
                  <ToneIcon tone={presentation.tone} />
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <span className="truncate text-xs text-text">{presentation.title}</span>
                    {index === 0 && (
                      <span className="shrink-0 rounded bg-blue-500/15 px-1 py-0.5 text-[9px] font-medium uppercase text-blue-400">
                        {nextLabel}
                      </span>
                    )}
                  </div>
                  {(presentation.detail || timestamp) && (
                    <div className="flex min-w-0 items-center gap-1 text-[10px] text-text-muted">
                      {presentation.detail && (
                        <span className="truncate" aria-label={presentation.detail}>
                          {presentation.detail}
                        </span>
                      )}
                      {presentation.detail && timestamp && <span aria-hidden="true">·</span>}
                      {timestamp && <time dateTime={action.createdAt}>{timestamp}</time>}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
          {hiddenCount > 0 && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="h-7 w-full justify-center px-2 text-[10px] text-text-muted"
              aria-label={`Show ${revealCount} older ${stackName} action${revealCount === 1 ? '' : 's'}`}
              onClick={onShowOlder}
            >
              Show {revealCount} older action{revealCount === 1 ? '' : 's'}
              <span className="ml-1 opacity-70">({hiddenCount} retained)</span>
            </Button>
          )}
        </div>
      )}
    </section>
  );
}

export const ReviewActionHistoryPopover = ({
  undoHistory,
  redoHistory,
  resolveFileLabel,
  persistenceStatus = 'saved',
  onRetryPersistence,
}: ReviewActionHistoryPopoverProps): React.ReactElement | null => {
  const [open, setOpen] = useState(false);
  const [undoVisibleLimit, setUndoVisibleLimit] = useState(HISTORY_INITIAL_LIMIT);
  const [redoVisibleLimit, setRedoVisibleLimit] = useState(HISTORY_INITIAL_LIMIT);
  const undoActions = useMemo(
    () => takeRecentReviewActions(undoHistory, undoVisibleLimit),
    [undoHistory, undoVisibleLimit]
  );
  const redoActions = useMemo(
    () =>
      takeRecentReviewActions(
        redoHistory.slice(-redoVisibleLimit).map((entry) => entry.action),
        redoVisibleLimit
      ),
    [redoHistory, redoVisibleLimit]
  );
  const totalCount = undoHistory.length + redoHistory.length;
  if (totalCount === 0) return null;

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={`Review history: ${undoHistory.length} undo, ${redoHistory.length} redo; ${persistenceStatus}`}
          className="flex items-center gap-1 rounded px-2 py-1 text-xs text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
        >
          <History className="size-3.5" />
          <span>History</span>
          <span className="rounded bg-zinc-500/15 px-1 text-[10px] text-zinc-300">
            {totalCount}
          </span>
          {persistenceStatus === 'saving' && (
            <Loader2 className="size-3 animate-spin text-blue-400" aria-hidden="true" />
          )}
          {persistenceStatus === 'error' && (
            <AlertTriangle className="size-3 text-red-400" aria-hidden="true" />
          )}
        </button>
      </PopoverTrigger>
      <PopoverContent
        align="end"
        className="max-h-[min(70vh,32rem)] w-[22rem] p-0"
        onEscapeKeyDown={(event) => {
          event.preventDefault();
          event.stopPropagation();
          setOpen(false);
        }}
      >
        <div className="sticky top-0 z-10 border-b border-border bg-surface px-3 py-2.5">
          <div className="text-xs font-medium text-text">Review action history</div>
          <div
            data-review-history-persistence={persistenceStatus}
            className={cn(
              'mt-1 flex items-center gap-1.5 text-[10px]',
              persistenceStatus === 'error' ? 'text-red-300' : 'text-text-muted'
            )}
          >
            {persistenceStatus === 'saving' && (
              <Loader2 className="size-3 shrink-0 animate-spin text-blue-400" aria-hidden="true" />
            )}
            {persistenceStatus === 'error' && (
              <AlertTriangle className="size-3 shrink-0" aria-hidden="true" />
            )}
            <span>
              {persistenceStatus === 'saving'
                ? 'Saving latest action...'
                : persistenceStatus === 'error'
                  ? 'Latest action is not saved yet.'
                  : 'Saved actions are restored after restart.'}{' '}
              The highlighted action runs next.
            </span>
            {persistenceStatus === 'error' && onRetryPersistence && (
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="ml-auto h-6 shrink-0 px-2 text-[10px]"
                onClick={onRetryPersistence}
              >
                Retry
              </Button>
            )}
          </div>
        </div>
        <ReviewHistorySection
          stackName="undo"
          title="Undo stack"
          emptyLabel="No actions available to undo."
          actions={undoActions}
          totalCount={undoHistory.length}
          nextLabel="Next undo"
          resolveFileLabel={resolveFileLabel}
          onShowOlder={() => {
            setUndoVisibleLimit((current) =>
              Math.min(undoHistory.length, current + HISTORY_REVEAL_BATCH)
            );
          }}
        />
        <div className="border-t border-border" />
        <ReviewHistorySection
          stackName="redo"
          title="Redo stack"
          emptyLabel="No actions available to redo."
          actions={redoActions}
          totalCount={redoHistory.length}
          nextLabel="Next redo"
          resolveFileLabel={resolveFileLabel}
          onShowOlder={() => {
            setRedoVisibleLimit((current) =>
              Math.min(redoHistory.length, current + HISTORY_REVEAL_BATCH)
            );
          }}
        />
      </PopoverContent>
    </Popover>
  );
};
