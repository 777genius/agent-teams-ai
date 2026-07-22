import React from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { FileIcon } from '@renderer/components/team/editor/FileIcon';
import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { shortcutLabel } from '@renderer/utils/platformKeys';
import { ChevronDown, ChevronRight, FilePlus, GitBranch, Loader2, Save, Undo2 } from 'lucide-react';

import {
  getResolvedReviewModifiedContent,
  getReviewRejectBlockReason,
  isReviewAcceptDisabled,
  isReviewFileMissingOnDisk,
  isReviewTextContentUnavailable,
  requiresManualLedgerReview,
} from './reviewContentPreview';

import type { FileChangeWithContent, HunkDecision } from '@shared/types';
import type { FileChangeSummary } from '@shared/types/review';

interface FileSectionHeaderProps {
  file: FileChangeSummary;
  fileContent: FileChangeWithContent | null;
  contentResolved: boolean;
  fileDecision: HunkDecision | undefined;
  externalChange?: { type: 'change' | 'add' | 'unlink' };
  pathChangeLabel?:
    | { kind: 'deleted' }
    | { kind: 'copied' | 'moved' | 'renamed'; direction: 'from' | 'to'; otherPath: string };
  hasEdits: boolean;
  applying: boolean;
  isCollapsed: boolean;
  onToggleCollapse: (filePath: string) => void;
  onDiscard: (filePath: string) => void;
  onSave: (filePath: string) => void;
  onReloadFromDisk?: (filePath: string) => void;
  onKeepDraft?: (filePath: string) => void;
  onRestoreMissingFile?: (filePath: string, content: string) => void;
  onAcceptFile?: (filePath: string) => void;
  onRejectFile?: (filePath: string) => void;
}

export const FileSectionHeader = ({
  file,
  fileContent,
  contentResolved,
  fileDecision,
  externalChange,
  pathChangeLabel,
  hasEdits,
  applying,
  isCollapsed,
  onToggleCollapse,
  onDiscard,
  onSave,
  onReloadFromDisk,
  onKeepDraft,
  onRestoreMissingFile,
  onAcceptFile,
  onRejectFile,
}: FileSectionHeaderProps): React.ReactElement => {
  const { t } = useAppTranslation('team');
  const restoreContent = getResolvedReviewModifiedContent(file, fileContent);
  const isNewFile = fileContent?.isNewFile ?? file.isNewFile;
  const isMissingOnDisk = isReviewFileMissingOnDisk(fileContent);
  const isContentUnavailable = isReviewTextContentUnavailable(file, fileContent);
  const isPreviewOnly = isMissingOnDisk || isContentUnavailable;
  const manualLedgerReviewRequired = requiresManualLedgerReview(file);
  const rejectBlockReason = getReviewRejectBlockReason(file, fileContent);
  const rejectDisabled =
    !contentResolved ||
    rejectBlockReason !== null ||
    hasEdits ||
    !!externalChange ||
    fileDecision === 'rejected';
  const acceptDisabled =
    !contentResolved ||
    !!externalChange ||
    isReviewAcceptDisabled({
      hasEdits,
      isMissingOnDisk,
      isContentUnavailable,
      fileDecision,
    });
  const draftDecisionDisabledLabel = t('review.fileHeader.disabled.saveOrDiscardDraft', {
    defaultValue: 'Save or discard manual edits before accepting or rejecting.',
  });
  const canRestore =
    !!onRestoreMissingFile &&
    isMissingOnDisk &&
    !hasEdits &&
    !externalChange &&
    restoreContent != null;
  const externalMutationDisabledLabel =
    'Reload the external file change before continuing review actions.';
  const externalChangeLabel =
    externalChange?.type === 'unlink'
      ? t('review.fileHeader.externalChange.deletedOnDisk')
      : externalChange?.type === 'add'
        ? t('review.fileHeader.externalChange.recreatedOnDisk')
        : externalChange?.type === 'change'
          ? t('review.fileHeader.externalChange.changedOnDisk')
          : null;
  const contentSourceLabel =
    fileContent?.contentSource != null
      ? t(`review.fileHeader.contentSource.${fileContent.contentSource}`, {
          defaultValue: fileContent.contentSource,
        })
      : null;

  const handleHeaderClick = (e: React.MouseEvent): void => {
    // Don't collapse when clicking action buttons
    if (applying || (e.target as HTMLElement).closest('[data-no-collapse]')) return;
    onToggleCollapse(file.filePath);
  };

  const handleHeaderKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (applying) return;
      onToggleCollapse(file.filePath);
    }
  };

  return (
    <div
      role="button"
      tabIndex={applying ? -1 : 0}
      aria-disabled={applying}
      onClick={handleHeaderClick}
      onKeyDown={handleHeaderKeyDown}
      className="hover:bg-surface-raised/50 sticky top-0 z-10 flex cursor-pointer select-none items-center gap-2 border-b border-border bg-surface-sidebar px-4 py-2"
    >
      <span className="flex shrink-0 items-center text-text-muted">
        {isCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
      </span>
      <FileIcon fileName={file.relativePath} className="size-3.5" />
      <span className="text-xs font-medium text-text">{file.relativePath}</span>

      {isNewFile && (
        <span className="rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] text-green-400">
          {t('review.fileHeader.badges.new')}
        </span>
      )}

      {pathChangeLabel?.kind === 'deleted' && (
        <span className="rounded bg-red-500/20 px-1.5 py-0.5 text-[10px] text-red-300">
          {t('review.fileHeader.badges.deleted')}
        </span>
      )}

      {pathChangeLabel && pathChangeLabel.kind !== 'deleted' && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="rounded bg-purple-500/20 px-1.5 py-0.5 text-[10px] text-purple-300">
              {pathChangeLabel.kind.toUpperCase()}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            {pathChangeLabel.direction === 'from'
              ? t('review.fileHeader.pathChange.from', { path: pathChangeLabel.otherPath })
              : t('review.fileHeader.pathChange.to', { path: pathChangeLabel.otherPath })}
          </TooltipContent>
        </Tooltip>
      )}

      {fileContent?.contentSource && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={[
                'rounded px-1.5 py-0.5 text-[10px]',
                isPreviewOnly ? 'bg-red-500/20 text-red-300' : 'bg-surface-raised text-text-muted',
              ].join(' ')}
            >
              {isContentUnavailable
                ? t('review.fileHeader.contentUnavailable.badge')
                : isMissingOnDisk
                  ? t('review.fileHeader.missingOnDisk.badge')
                  : contentSourceLabel}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            {isContentUnavailable ? (
              <div className="space-y-1">
                <div className="font-medium text-text">
                  {t('review.fileHeader.contentUnavailable.title')}
                </div>
                <div className="text-text-muted">
                  {t('review.fileHeader.contentUnavailable.description')}
                </div>
                <div className="text-text-muted">
                  {t('review.fileHeader.contentUnavailable.safety')}
                </div>
              </div>
            ) : isMissingOnDisk ? (
              <div className="space-y-1">
                <div className="font-medium text-text">
                  {t('review.fileHeader.missingOnDisk.title')}
                </div>
                <div className="text-text-muted">
                  {t('review.fileHeader.missingOnDisk.description')}
                </div>
                {restoreContent != null ? (
                  <div className="text-text-muted">
                    {t('review.fileHeader.missingOnDisk.restorePrefix')}{' '}
                    <span className="font-medium text-text">
                      {t('review.fileHeader.actions.restore')}
                    </span>{' '}
                    {t('review.fileHeader.missingOnDisk.restoreSuffix')}
                  </div>
                ) : (
                  <div className="text-text-muted">
                    {t('review.fileHeader.missingOnDisk.restoreUnavailable')}
                  </div>
                )}
              </div>
            ) : (
              <span>{contentSourceLabel}</span>
            )}
          </TooltipContent>
        </Tooltip>
      )}

      {file.ledgerSummary?.worktreePath && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="inline-flex items-center gap-1 rounded bg-blue-500/15 px-1.5 py-0.5 text-[10px] text-blue-300">
              <GitBranch className="size-3" />
              {t('review.fileHeader.badges.worktree')}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-sm">
            <div className="space-y-1">
              <div className="font-medium text-text">
                {file.ledgerSummary.worktreeBranch ?? t('review.fileHeader.worktree.isolated')}
              </div>
              <div className="break-all text-text-muted">{file.ledgerSummary.worktreePath}</div>
              {file.ledgerSummary.dirtyLeaderWarning && (
                <div className="text-amber-300">{file.ledgerSummary.dirtyLeaderWarning}</div>
              )}
            </div>
          </TooltipContent>
        </Tooltip>
      )}

      {fileDecision && (
        <span
          className={`rounded px-1.5 py-0.5 text-[10px] ${
            fileDecision === 'accepted'
              ? 'bg-green-500/20 text-green-400'
              : fileDecision === 'rejected'
                ? 'bg-red-500/20 text-red-400'
                : 'bg-zinc-500/20 text-zinc-400'
          }`}
        >
          {fileDecision}
        </span>
      )}

      {externalChangeLabel && (
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
          {externalChangeLabel}
        </span>
      )}

      {manualLedgerReviewRequired && (
        <span className="rounded bg-amber-500/15 px-1.5 py-0.5 text-[10px] text-amber-300">
          {t('review.fileHeader.badges.manualReview')}
        </span>
      )}

      <div className="ml-auto flex items-center gap-1.5" data-no-collapse>
        {externalChange && onReloadFromDisk && (
          <div className="mr-1 flex items-center gap-1.5">
            <button
              onClick={() => onReloadFromDisk(file.filePath)}
              disabled={applying}
              className="rounded bg-blue-500/15 px-2 py-1 text-xs font-medium text-blue-300 transition-colors hover:bg-blue-500/25 disabled:opacity-50"
            >
              {t('review.fileHeader.actions.reloadFromDisk')}
            </button>
            {hasEdits && onKeepDraft && (
              <button
                onClick={() => onKeepDraft(file.filePath)}
                disabled={applying}
                className="rounded bg-amber-500/15 px-2 py-1 text-xs font-medium text-amber-300 transition-colors hover:bg-amber-500/25 disabled:opacity-50"
              >
                {t('review.fileHeader.actions.keepMyDraft')}
              </button>
            )}
          </div>
        )}

        {(onAcceptFile || onRejectFile) && (
          <div className="mr-1 flex items-center gap-1.5">
            {onAcceptFile && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <button
                      onClick={() => onAcceptFile(file.filePath)}
                      disabled={applying || acceptDisabled}
                      className={[
                        'rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50',
                        fileDecision === 'accepted'
                          ? 'bg-green-500/25 text-green-300'
                          : 'bg-green-500/15 text-green-400 hover:bg-green-500/25',
                      ].join(' ')}
                    >
                      {t('review.fileHeader.actions.accept')}
                    </button>
                  </span>
                </TooltipTrigger>
                {acceptDisabled && (
                  <TooltipContent side="bottom">
                    {externalChange
                      ? externalMutationDisabledLabel
                      : hasEdits
                        ? draftDecisionDisabledLabel
                        : isContentUnavailable
                          ? t('review.fileHeader.disabled.acceptRejectContentUnavailable')
                          : t('review.fileHeader.disabled.acceptRejectMissingOnDisk')}
                  </TooltipContent>
                )}
              </Tooltip>
            )}
            {onRejectFile && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <span>
                    <button
                      onClick={() => onRejectFile(file.filePath)}
                      disabled={applying || rejectDisabled}
                      className={[
                        'rounded px-2 py-1 text-xs font-medium transition-colors disabled:opacity-50',
                        fileDecision === 'rejected'
                          ? 'bg-red-500/25 text-red-300'
                          : 'bg-red-500/15 text-red-400 hover:bg-red-500/25',
                      ].join(' ')}
                    >
                      {t('review.fileHeader.actions.reject')}
                    </button>
                  </span>
                </TooltipTrigger>
                {rejectDisabled && fileDecision !== 'rejected' && (
                  <TooltipContent side="bottom">
                    {externalChange
                      ? externalMutationDisabledLabel
                      : hasEdits
                        ? draftDecisionDisabledLabel
                        : rejectBlockReason === 'manual-ledger-review'
                          ? t('review.fileHeader.disabled.rejectManualLedgerReview')
                          : rejectBlockReason === 'content-unavailable'
                            ? t('review.fileHeader.disabled.rejectContentUnavailable')
                            : rejectBlockReason === 'missing-on-disk'
                              ? t('review.fileHeader.disabled.acceptRejectMissingOnDisk')
                              : t('review.fileHeader.disabled.rejectBaselineUnavailable')}
                  </TooltipContent>
                )}
              </Tooltip>
            )}
          </div>
        )}
        {canRestore && restoreContent != null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => onRestoreMissingFile?.(file.filePath, restoreContent)}
                disabled={applying}
                className="flex items-center gap-1 rounded bg-blue-500/15 px-2 py-1 text-xs text-blue-300 transition-colors hover:bg-blue-500/25 disabled:opacity-50"
              >
                <FilePlus className="size-3" />
                {t('review.fileHeader.actions.restore')}
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              {t('review.fileHeader.actions.restoreTooltip')}
            </TooltipContent>
          </Tooltip>
        )}
        {hasEdits && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onDiscard(file.filePath)}
                  disabled={applying}
                  className="flex items-center gap-1 rounded bg-orange-500/15 px-2 py-1 text-xs text-orange-400 transition-colors hover:bg-orange-500/25 disabled:opacity-50"
                >
                  <Undo2 className="size-3" />
                  {t('review.fileHeader.actions.discard')}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                {t('review.fileHeader.actions.discardTooltip')}
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onSave(file.filePath)}
                  disabled={applying || !!externalChange}
                  className="flex items-center gap-1 rounded bg-green-500/15 px-2 py-1 text-xs text-green-400 transition-colors hover:bg-green-500/25 disabled:opacity-50"
                >
                  {applying ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Save className="size-3" />
                  )}
                  {t('review.fileHeader.actions.saveFile')}
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <span>
                  {externalChange
                    ? `${t('review.fileHeader.actions.reloadFromDisk')} / ${t('review.fileHeader.actions.keepMyDraft')}`
                    : t('review.fileHeader.actions.saveFileTooltip')}
                </span>
                <kbd className="ml-2 rounded border border-border bg-surface-raised px-1 py-0.5 font-mono text-[10px] text-text-muted">
                  {shortcutLabel('⌘ S', 'Ctrl+S')}
                </kbd>
              </TooltipContent>
            </Tooltip>
          </>
        )}
      </div>
    </div>
  );
};
