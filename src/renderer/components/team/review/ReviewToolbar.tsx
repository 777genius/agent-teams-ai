import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { cn } from '@renderer/lib/utils';
import { shortcutLabel } from '@renderer/utils/platformKeys';
import { Check, Eye, EyeOff, GitMerge, Loader2, Pencil, Redo2, Undo2, X } from 'lucide-react';

import { ReviewActionHistoryPopover } from './ReviewActionHistoryPopover';
import { describeReviewAction } from './reviewActionPresentation';

import type { ReviewFileLabelResolver } from './reviewActionPresentation';
import type { ReviewActionPersistenceStatus } from './reviewActionState';
import type { ChangeStats, ReviewRedoAction, ReviewUndoAction } from '@shared/types';

interface ReviewToolbarProps {
  stats: { pending: number; accepted: number; rejected: number };
  changeStats: ChangeStats;
  collapseUnchanged: boolean;
  applying: boolean;
  autoViewed: boolean;
  instantApply?: boolean;
  onAutoViewedChange: (auto: boolean) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onApply: () => void;
  onCollapseUnchangedChange: (collapse: boolean) => void;
  canRejectAll?: boolean;
  canAcceptAll?: boolean;
  editedCount?: number;
  canUndo?: boolean;
  onUndo?: () => void;
  canRedo?: boolean;
  onRedo?: () => void;
  mutationBlocked?: boolean;
  undoHistory?: readonly ReviewUndoAction[];
  redoHistory?: readonly ReviewRedoAction[];
  resolveFileLabel?: ReviewFileLabelResolver;
  undoDisabledReason?: string;
  redoDisabledReason?: string;
  historyPersistenceStatus?: ReviewActionPersistenceStatus;
  onRetryHistoryPersistence?: () => void;
}

export const ReviewToolbar = ({
  stats,
  changeStats,
  collapseUnchanged: _collapseUnchanged,
  applying,
  autoViewed,
  onAutoViewedChange,
  onAcceptAll,
  onRejectAll,
  onApply,
  onCollapseUnchangedChange: _onCollapseUnchangedChange,
  canRejectAll = true,
  canAcceptAll = true,
  instantApply = false,
  editedCount = 0,
  canUndo = false,
  onUndo,
  canRedo = false,
  onRedo,
  mutationBlocked = false,
  undoHistory = [],
  redoHistory = [],
  resolveFileLabel,
  undoDisabledReason,
  redoDisabledReason,
  historyPersistenceStatus = 'saved',
  onRetryHistoryPersistence,
}: ReviewToolbarProps): React.ReactElement => {
  const { t } = useAppTranslation('team');
  const hasRejected = stats.rejected > 0;
  const canApply = hasRejected && !applying && !mutationBlocked;
  const totalChanges = stats.pending + stats.accepted + stats.rejected;
  const reviewedCount = stats.accepted + stats.rejected;
  const rejectAllDisabled = applying || mutationBlocked || !canRejectAll;
  const acceptAllDisabled = applying || mutationBlocked || !canAcceptAll;
  const externalMutationBlockedLabel =
    'Reload files changed outside Changes before continuing review actions.';
  const nextUndo = undoHistory.at(-1);
  const nextRedo = redoHistory.at(-1)?.action;
  const undoPreview = nextUndo ? describeReviewAction(nextUndo, resolveFileLabel) : null;
  const redoPreview = nextRedo ? describeReviewAction(nextRedo, resolveFileLabel) : null;
  const formatPreview = (
    direction: 'Undo' | 'Redo',
    preview: ReturnType<typeof describeReviewAction> | null,
    shortcut: string
  ): string => {
    if (!preview) return `${direction} last review operation (${shortcut})`;
    return `${direction}: ${preview.title}${preview.detail ? ` · ${preview.detail}` : ''} (${shortcut})`;
  };

  return (
    <div className="flex items-center gap-3 border-b border-border bg-surface-sidebar px-4 py-2">
      {/* Decision stats */}
      <div className="flex items-center gap-2 text-xs">
        {stats.pending > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-zinc-500/20 px-2 py-0.5 text-zinc-400">
            {t('review.toolbar.stats.pending', { count: stats.pending })}
          </span>
        )}
        {stats.accepted > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-500/20 px-2 py-0.5 text-green-400">
            <Check className="size-3" />
            {t('review.toolbar.stats.accepted', { count: stats.accepted })}
          </span>
        )}
        {stats.rejected > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-2 py-0.5 text-red-400">
            <X className="size-3" />
            {t('review.toolbar.stats.rejected', { count: stats.rejected })}
          </span>
        )}
      </div>

      {/* Change stats */}
      <div className="flex items-center gap-1 text-xs text-text-muted">
        <span className="text-green-400">+{changeStats.linesAdded}</span>
        <span className="text-red-400">-{changeStats.linesRemoved}</span>
        <span className="ml-1">
          {t('review.toolbar.stats.acrossFiles', { count: changeStats.filesChanged })}
        </span>
      </div>

      {/* Review progress */}
      {totalChanges > 0 && (
        <div className="flex items-center gap-2 text-xs">
          <div className="h-1.5 w-20 overflow-hidden rounded-full bg-zinc-700/50">
            <div
              className="h-full rounded-full bg-blue-500/70 transition-all duration-300"
              style={{ width: `${(reviewedCount / totalChanges) * 100}%` }}
            />
          </div>
          <span className="text-text-muted">
            {reviewedCount}/{totalChanges}
          </span>
        </div>
      )}

      <div className="flex-1" />

      {/* <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => onCollapseUnchangedChange(!collapseUnchanged)}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
              collapseUnchanged ? 'bg-surface-raised text-text' : 'text-text-muted hover:text-text'
            )}
          >
            {collapseUnchanged ? (
              <FoldVertical className="size-3.5" />
            ) : (
              <UnfoldVertical className="size-3.5" />
            )}
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {collapseUnchanged ? 'Show all lines' : 'Collapse unchanged regions'}
        </TooltipContent>
      </Tooltip> */}

      <Tooltip>
        <TooltipTrigger asChild>
          <button
            onClick={() => onAutoViewedChange(!autoViewed)}
            className={cn(
              'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
              autoViewed ? 'bg-surface-raised text-text' : 'text-text-muted hover:text-text'
            )}
          >
            {autoViewed ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
            <span className="text-[10px]">{t('review.toolbar.actions.auto')}</span>
          </button>
        </TooltipTrigger>
        <TooltipContent side="bottom">
          {autoViewed ? t('review.toolbar.tooltips.autoOn') : t('review.toolbar.tooltips.autoOff')}
        </TooltipContent>
      </Tooltip>

      <div className="h-4 w-px bg-border" />

      {editedCount > 0 && (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-400">
          <Pencil className="size-3" /> {t('review.toolbar.stats.edited', { count: editedCount })}
        </span>
      )}

      {editedCount > 0 && <div className="h-4 w-px bg-border" />}

      <ReviewActionHistoryPopover
        undoHistory={undoHistory}
        redoHistory={redoHistory}
        resolveFileLabel={resolveFileLabel}
        persistenceStatus={historyPersistenceStatus}
        onRetryPersistence={onRetryHistoryPersistence}
      />

      {canUndo && onUndo && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onUndo}
              disabled={applying || mutationBlocked || Boolean(undoDisabledReason)}
              className="flex items-center gap-1 rounded bg-zinc-500/15 px-2.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-500/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Undo2 className="size-3" />
              {t('review.toolbar.actions.undo')}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {mutationBlocked
              ? externalMutationBlockedLabel
              : undoDisabledReason
                ? undoDisabledReason
              : formatPreview('Undo', undoPreview, shortcutLabel('⌘ Z', 'Ctrl+Z'))}
          </TooltipContent>
        </Tooltip>
      )}

      {canRedo && onRedo && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onRedo}
              disabled={applying || mutationBlocked || Boolean(redoDisabledReason)}
              className="flex items-center gap-1 rounded bg-zinc-500/15 px-2.5 py-1 text-xs text-zinc-300 transition-colors hover:bg-zinc-500/25 disabled:cursor-not-allowed disabled:opacity-50"
            >
              <Redo2 className="size-3" />
              {t('review.toolbar.actions.redo')}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {mutationBlocked
              ? externalMutationBlockedLabel
              : redoDisabledReason
                ? redoDisabledReason
              : formatPreview('Redo', redoPreview, shortcutLabel('⌘ ⇧ Z', 'Ctrl+Shift+Z'))}
          </TooltipContent>
        </Tooltip>
      )}

      {/* Actions hidden when all hunks are already decided */}
      {stats.pending > 0 && (
        <>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={onAcceptAll}
                disabled={acceptAllDisabled}
                className="flex items-center gap-1 rounded bg-green-500/15 px-2.5 py-1 text-xs text-green-400 transition-colors hover:bg-green-500/25 disabled:cursor-not-allowed disabled:opacity-50"
              >
                <Check className="size-3" />
                {t('review.toolbar.actions.acceptAll')}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {mutationBlocked
                ? externalMutationBlockedLabel
                : canAcceptAll
                ? t('review.toolbar.tooltips.acceptAll')
                : 'Wait until every file has a safe, complete review snapshot.'}
            </TooltipContent>
          </Tooltip>

          <Tooltip>
            <TooltipTrigger asChild>
              <span>
                <button
                  onClick={onRejectAll}
                  disabled={rejectAllDisabled}
                  className={cn(
                    'flex items-center gap-1 rounded px-2.5 py-1 text-xs transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                    rejectAllDisabled
                      ? 'bg-red-500/10 text-red-500'
                      : 'bg-red-500/15 text-red-400 hover:bg-red-500/25'
                  )}
                >
                  <X className="size-3" />
                  {t('review.toolbar.actions.rejectAll')}
                </button>
              </span>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {mutationBlocked
                ? externalMutationBlockedLabel
                : canRejectAll
                ? t('review.toolbar.tooltips.rejectAll')
                : t('review.toolbar.tooltips.rejectAllDisabled')}
            </TooltipContent>
          </Tooltip>
        </>
      )}

      {!instantApply && (
        <Tooltip>
          <TooltipTrigger asChild>
            <button
              onClick={onApply}
              disabled={!canApply}
              className={cn(
                'flex items-center gap-1 rounded px-3 py-1 text-xs font-medium transition-colors',
                canApply
                  ? 'bg-blue-500/20 text-blue-400 hover:bg-blue-500/30'
                  : 'cursor-not-allowed bg-zinc-500/10 text-zinc-600'
              )}
            >
              {applying ? (
                <Loader2 className="size-3 animate-spin" />
              ) : (
                <GitMerge className="size-3" />
              )}
              {applying
                ? t('review.toolbar.actions.applying')
                : t('review.toolbar.actions.applyRejections')}
            </button>
          </TooltipTrigger>
          <TooltipContent side="bottom">
            {mutationBlocked
              ? externalMutationBlockedLabel
              : t('review.toolbar.tooltips.applyRejections')}
          </TooltipContent>
        </Tooltip>
      )}
    </div>
  );
};
