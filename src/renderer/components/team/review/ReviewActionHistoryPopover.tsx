import React, { useMemo, useRef, useState } from 'react';

import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@renderer/components/ui/alert-dialog';
import { Button } from '@renderer/components/ui/button';
import { Popover, PopoverContent, PopoverTrigger } from '@renderer/components/ui/popover';
import { cn } from '@renderer/lib/utils';
import { AlertTriangle, Check, CircleDot, History, Loader2, RotateCcw, X } from 'lucide-react';

import { ChangeStatsBadge } from './ChangeStatsBadge';
import {
  describeReviewAction,
  getReviewActionFilePath,
  takeRecentReviewActions,
} from './reviewActionPresentation';

import type { ReviewActionTone, ReviewFileLabelResolver } from './reviewActionPresentation';
import type { ReviewActionPersistenceStatus } from './reviewActionState';
import type { ReviewHistoryDiskTransition } from '@features/review-mutations';
import type { ReviewHistoryRestoreTarget, ReviewRedoAction, ReviewUndoAction } from '@shared/types';

const HISTORY_INITIAL_LIMIT = 12;
const HISTORY_REVEAL_BATCH = 50;

interface ReviewActionHistoryPopoverProps {
  undoHistory: readonly ReviewUndoAction[];
  redoHistory: readonly ReviewRedoAction[];
  resolveFileLabel?: ReviewFileLabelResolver;
  persistenceStatus?: ReviewActionPersistenceStatus;
  onRetryPersistence?: () => void;
  onNavigateToAction?: (action: ReviewUndoAction) => void;
  onRestoreToTarget?: (target: ReviewHistoryRestoreTarget) => Promise<void>;
  onRecoverFailedRestore?: (target: ReviewHistoryRestoreTarget) => Promise<void>;
  getRestorePreview?: (target: ReviewHistoryRestoreTarget) => ReviewHistoryRestorePreview;
  restoreDisabled?: boolean;
}

export interface ReviewHistoryRestorePreview {
  direction: 'undo' | 'redo';
  actions: readonly ReviewUndoAction[];
  diskTransitions: readonly ReviewHistoryDiskTransition[];
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
  onNavigateToAction?: (action: ReviewUndoAction) => void;
  getRestoreCount?: (action: ReviewUndoAction) => number;
  onRequestRestore?: (action: ReviewUndoAction, actionCount: number) => void;
  restoreDisabled?: boolean;
}

function formatActionTime(createdAt: string): string | null {
  const timestamp = new Date(createdAt);
  if (Number.isNaN(timestamp.getTime())) return null;
  return timestamp.toLocaleString([], {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function areRestorePreviewsEqual(
  previous: ReviewHistoryRestorePreview | null,
  next: ReviewHistoryRestorePreview
): boolean {
  if (!previous || previous.direction !== next.direction) return false;
  if (
    previous.actions.length !== next.actions.length ||
    previous.actions.some((action, index) => action.id !== next.actions[index]?.id)
  ) {
    return false;
  }
  return (
    previous.diskTransitions.length === next.diskTransitions.length &&
    previous.diskTransitions.every((transition, index) => {
      const candidate = next.diskTransitions[index];
      return (
        candidate?.filePath === transition.filePath &&
        candidate.kind === transition.kind &&
        candidate.lineStatsStatus === transition.lineStatsStatus &&
        candidate.linesAdded === transition.linesAdded &&
        candidate.linesRemoved === transition.linesRemoved
      );
    })
  );
}

const ToneIcon = ({ tone }: { tone: ReviewActionTone }): React.ReactElement => {
  if (tone === 'accept') return <Check className="size-3.5 text-green-400" />;
  if (tone === 'reject') return <X className="size-3.5 text-red-400" />;
  if (tone === 'restore') return <RotateCcw className="size-3.5 text-blue-400" />;
  return <CircleDot className="size-3.5 text-text-muted" />;
};

const ReviewHistorySection = ({
  stackName,
  title,
  emptyLabel,
  actions,
  totalCount,
  nextLabel,
  resolveFileLabel,
  onShowOlder,
  onNavigateToAction,
  getRestoreCount,
  onRequestRestore,
  restoreDisabled,
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
            const canNavigate = Boolean(onNavigateToAction && getReviewActionFilePath(action));
            const restoreCount = getRestoreCount?.(action) ?? 0;
            const actionContent = (
              <>
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
              </>
            );
            return (
              <div
                key={action.id}
                data-review-history-row={action.id}
                className={cn(
                  'flex w-full min-w-0 items-stretch rounded',
                  index === 0 && 'bg-surface-raised'
                )}
              >
                {canNavigate ? (
                  <button
                    type="button"
                    data-review-history-action={action.id}
                    onClick={() => onNavigateToAction?.(action)}
                    className="hover:bg-surface-raised/70 flex min-w-0 flex-1 items-start gap-2 rounded-l px-2 py-1.5 text-left"
                  >
                    {actionContent}
                  </button>
                ) : (
                  <div
                    data-review-history-action={action.id}
                    className="flex min-w-0 flex-1 items-start gap-2 px-2 py-1.5 text-left"
                  >
                    {actionContent}
                  </div>
                )}
                {onRequestRestore && (
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    data-review-history-restore={action.id}
                    aria-label={
                      restoreCount === 0
                        ? 'Current review checkpoint'
                        : `Restore ${restoreCount} action${restoreCount === 1 ? '' : 's'} to this checkpoint`
                    }
                    disabled={restoreDisabled || restoreCount === 0}
                    className="h-auto shrink-0 rounded-l-none px-2 text-[10px] text-blue-300"
                    onClick={() => onRequestRestore(action, restoreCount)}
                  >
                    {restoreCount === 0 ? 'Current' : 'Restore'}
                  </Button>
                )}
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
};

export const ReviewActionHistoryPopover = ({
  undoHistory,
  redoHistory,
  resolveFileLabel,
  persistenceStatus = 'saved',
  onRetryPersistence,
  onNavigateToAction,
  onRestoreToTarget,
  onRecoverFailedRestore,
  getRestorePreview,
  restoreDisabled = false,
}: ReviewActionHistoryPopoverProps): React.ReactElement | null => {
  const historyPositionKey = JSON.stringify([
    undoHistory.map((action) => action.id),
    redoHistory.map((entry) => entry.action.id),
  ]);
  const historyPositionToken = useMemo(
    () => Symbol(`review-history-position:${historyPositionKey}`),
    [historyPositionKey]
  );
  const [openForHistoryPosition, setOpenForHistoryPosition] = useState<symbol | null>(null);
  const open = openForHistoryPosition === historyPositionToken;
  const setOpen = (nextOpen: boolean): void => {
    setOpenForHistoryPosition(nextOpen ? historyPositionToken : null);
  };
  const [undoVisibleLimit, setUndoVisibleLimit] = useState(HISTORY_INITIAL_LIMIT);
  const [redoVisibleLimit, setRedoVisibleLimit] = useState(HISTORY_INITIAL_LIMIT);
  const [restoreRequest, setRestoreRequest] = useState<{
    target: ReviewHistoryRestoreTarget;
    actionCount: number;
    preview: ReviewHistoryRestorePreview | null;
    preparationError: string | null;
  } | null>(null);
  const [restoreRunning, setRestoreRunning] = useState(false);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const cancelRestoreRef = useRef<HTMLButtonElement | null>(null);
  const restoreRunningRef = useRef(false);
  const restoreRecoveryPendingRef = useRef(false);
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

  const requestRestore = (target: ReviewHistoryRestoreTarget, actionCount: number): void => {
    setOpen(false);
    setRestoreError(null);
    restoreRecoveryPendingRef.current = false;
    try {
      setRestoreRequest({
        target,
        actionCount,
        preview: getRestorePreview?.(target) ?? null,
        preparationError: null,
      });
    } catch (error) {
      setRestoreRequest({
        target,
        actionCount,
        preview: null,
        preparationError: error instanceof Error ? error.message : String(error),
      });
    }
  };
  const runRestore = async (): Promise<void> => {
    if (
      !restoreRequest ||
      restoreRequest.preparationError ||
      !onRestoreToTarget ||
      restoreRunningRef.current
    ) {
      return;
    }
    restoreRunningRef.current = true;
    setRestoreRunning(true);
    setRestoreError(null);
    try {
      if (restoreRecoveryPendingRef.current && onRecoverFailedRestore) {
        await onRecoverFailedRestore(restoreRequest.target);
        restoreRecoveryPendingRef.current = false;
        setRestoreRequest(null);
        return;
      }
      if (getRestorePreview) {
        let latestPreview: ReviewHistoryRestorePreview;
        try {
          latestPreview = getRestorePreview(restoreRequest.target);
        } catch (error) {
          setRestoreRequest({
            ...restoreRequest,
            preview: null,
            preparationError: error instanceof Error ? error.message : String(error),
          });
          return;
        }
        if (!areRestorePreviewsEqual(restoreRequest.preview, latestPreview)) {
          setRestoreRequest({
            ...restoreRequest,
            actionCount: latestPreview.actions.length,
            preview: latestPreview,
            preparationError: null,
          });
          setRestoreError(
            'Review history changed. Check the updated impact, then confirm Restore again.'
          );
          return;
        }
      }
      await onRestoreToTarget(restoreRequest.target);
      restoreRecoveryPendingRef.current = false;
      setRestoreRequest(null);
    } catch (error) {
      restoreRecoveryPendingRef.current = true;
      setRestoreError(error instanceof Error ? error.message : String(error));
    } finally {
      restoreRunningRef.current = false;
      setRestoreRunning(false);
    }
  };

  return (
    <>
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
        {open && (
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
            <div className="flex items-center justify-between gap-2">
              <div className="text-xs font-medium text-text">Review action history</div>
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Close review history"
                className="size-6 shrink-0 text-text-muted hover:text-text"
                onClick={() => setOpen(false)}
              >
                <X className="size-3.5" aria-hidden="true" />
              </Button>
            </div>
            <div
              data-review-history-persistence={persistenceStatus}
              className={cn(
                'mt-1 flex items-center gap-1.5 text-[10px]',
                persistenceStatus === 'error' ? 'text-red-300' : 'text-text-muted'
              )}
            >
              {persistenceStatus === 'saving' && (
                <Loader2
                  className="size-3 shrink-0 animate-spin text-blue-400"
                  aria-hidden="true"
                />
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
            onNavigateToAction={
              onNavigateToAction
                ? (action) => {
                    setOpen(false);
                    onNavigateToAction(action);
                  }
                : undefined
            }
            getRestoreCount={(action) => {
              const index = undoHistory.findIndex((candidate) => candidate.id === action.id);
              return index < 0 ? 0 : undoHistory.length - index - 1;
            }}
            onRequestRestore={
              onRestoreToTarget
                ? (action, actionCount) =>
                    requestRestore(
                      { kind: 'after-action', stack: 'undo', actionId: action.id },
                      actionCount
                    )
                : undefined
            }
            restoreDisabled={restoreDisabled}
            onShowOlder={() => {
              setUndoVisibleLimit((current) =>
                Math.min(undoHistory.length, current + HISTORY_REVEAL_BATCH)
              );
            }}
          />
          {onRestoreToTarget && (
            <div className="border-t border-border px-1.5 py-1.5">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-review-history-restore="start"
                className="h-8 w-full justify-between px-2 text-xs"
                disabled={restoreDisabled || undoHistory.length === 0}
                onClick={() => requestRestore({ kind: 'start' }, undoHistory.length)}
              >
                <span>Start of review</span>
                <span className="text-[10px] text-blue-300">Restore</span>
              </Button>
            </div>
          )}
          <div className="border-t border-border" />
          <ReviewHistorySection
            stackName="redo"
            title="Redo stack"
            emptyLabel="No actions available to redo."
            actions={redoActions}
            totalCount={redoHistory.length}
            nextLabel="Next redo"
            resolveFileLabel={resolveFileLabel}
            onNavigateToAction={
              onNavigateToAction
                ? (action) => {
                    setOpen(false);
                    onNavigateToAction(action);
                  }
                : undefined
            }
            getRestoreCount={(action) => {
              const index = redoHistory.findIndex((entry) => entry.action.id === action.id);
              return index < 0 ? 0 : redoHistory.length - index;
            }}
            onRequestRestore={
              onRestoreToTarget
                ? (action, actionCount) =>
                    requestRestore(
                      { kind: 'after-action', stack: 'redo', actionId: action.id },
                      actionCount
                    )
                : undefined
            }
            restoreDisabled={restoreDisabled}
            onShowOlder={() => {
              setRedoVisibleLimit((current) =>
                Math.min(redoHistory.length, current + HISTORY_REVEAL_BATCH)
              );
            }}
          />
          </PopoverContent>
        )}
      </Popover>
      <AlertDialog
        open={restoreRequest !== null}
        onOpenChange={(nextOpen) => {
          if (!nextOpen && !restoreRunningRef.current) setRestoreRequest(null);
        }}
      >
        <AlertDialogContent
          onEscapeKeyDown={(event) => {
            if (restoreRunning) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            cancelRestoreRef.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>Restore this review checkpoint?</AlertDialogTitle>
            <AlertDialogDescription>
              This will{' '}
              {restoreRequest?.target.kind === 'after-action' &&
              restoreRequest.target.stack === 'redo'
                ? 'redo'
                : 'undo'}{' '}
              {restoreRequest?.actionCount ?? 0} review action
              {(restoreRequest?.actionCount ?? 0) === 1 ? '' : 's'}. Files changed by Reject or
              Restore actions may be updated on disk.
            </AlertDialogDescription>
          </AlertDialogHeader>
          {restoreRequest?.preview && (
            <div
              data-review-history-impact
              className="bg-surface-raised/40 max-h-64 space-y-3 overflow-y-auto rounded-md border border-border p-3 text-xs"
            >
              <div>
                <div className="font-medium text-text">Actions in this jump</div>
                <div className="mt-1 space-y-1 text-text-muted">
                  {restoreRequest.preview.actions.slice(0, 5).map((action) => {
                    const presentation = describeReviewAction(action, resolveFileLabel);
                    return (
                      <div key={action.id} className="flex min-w-0 items-center gap-1.5">
                        <ToneIcon tone={presentation.tone} />
                        <span className="shrink-0 text-text">{presentation.title}</span>
                        {presentation.detail && (
                          <span className="truncate">{presentation.detail}</span>
                        )}
                      </div>
                    );
                  })}
                  {restoreRequest.preview.actions.length > 5 && (
                    <div>+{restoreRequest.preview.actions.length - 5} more actions</div>
                  )}
                </div>
              </div>
              <div className="border-t border-border pt-2">
                <div className="font-medium text-text">Net disk impact</div>
                {restoreRequest.preview.diskTransitions.length === 0 ? (
                  <div className="mt-1 text-text-muted">No files will be changed on disk.</div>
                ) : (
                  <div className="mt-1 space-y-1">
                    <div className="text-text-muted">
                      {restoreRequest.preview.diskTransitions.length} net disk transition
                      {restoreRequest.preview.diskTransitions.length === 1 ? '' : 's'}
                    </div>
                    {restoreRequest.preview.diskTransitions.slice(0, 5).map((transition) => (
                      <div
                        key={`${transition.kind}:${transition.filePath}`}
                        data-review-history-disk-transition={transition.kind}
                        className="flex min-w-0 items-center gap-2"
                      >
                        {(transition.kind === 'delete' || transition.kind === 'rename') && (
                          <AlertTriangle className="size-3 shrink-0 text-amber-400" />
                        )}
                        <span className="w-12 shrink-0 text-text">
                          {transition.kind.charAt(0).toUpperCase() + transition.kind.slice(1)}
                        </span>
                        <span className="truncate text-text-muted">
                          {resolveFileLabel?.(transition.filePath) || transition.filePath}
                        </span>
                        {transition.linesAdded !== undefined &&
                          transition.linesRemoved !== undefined && (
                            <ChangeStatsBadge
                              linesAdded={transition.linesAdded}
                              linesRemoved={transition.linesRemoved}
                              className="ml-auto shrink-0"
                            />
                          )}
                        {transition.lineStatsStatus === 'omitted-large-update' && (
                          <span className="ml-auto shrink-0 text-[10px] text-text-muted">
                            Large diff
                          </span>
                        )}
                        {transition.lineStatsStatus === 'unavailable-rename' && (
                          <span className="ml-auto shrink-0 text-[10px] text-text-muted">
                            Counts unavailable
                          </span>
                        )}
                      </div>
                    ))}
                    {restoreRequest.preview.diskTransitions.length > 5 && (
                      <div className="text-text-muted">
                        +{restoreRequest.preview.diskTransitions.length - 5} more files
                      </div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}
          {restoreRequest?.preparationError && (
            <p className="text-xs text-red-300">{restoreRequest.preparationError}</p>
          )}
          {restoreError && <p className="text-xs text-red-300">{restoreError}</p>}
          {restoreRunning && (
            <div role="status" aria-live="polite" className="flex items-center gap-2 text-xs">
              <Loader2 className="size-3.5 animate-spin" />
              Restoring {restoreRequest?.actionCount ?? 0} actions...
            </div>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel ref={cancelRestoreRef} disabled={restoreRunning}>
              Cancel
            </AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={restoreRunning || Boolean(restoreRequest?.preparationError)}
              onClick={() => void runRestore()}
            >
              {restoreRunning
                ? 'Restoring...'
                : restoreRecoveryPendingRef.current && onRecoverFailedRestore
                  ? 'Recover restore'
                  : restoreError
                    ? 'Retry restore'
                    : 'Restore'}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
};
