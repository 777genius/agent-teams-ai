import React from 'react';

import { Tooltip, TooltipContent, TooltipTrigger } from '@renderer/components/ui/tooltip';
import { shortcutLabel } from '@renderer/utils/platformKeys';
import { ChevronDown, ChevronRight, FilePlus, Loader2, Save, Undo2 } from 'lucide-react';

import type { FileChangeWithContent, HunkDecision } from '@shared/types';
import type { FileChangeSummary } from '@shared/types/review';

const CONTENT_SOURCE_LABELS: Record<string, string> = {
  'file-history': 'File History',
  'snippet-reconstruction': 'Reconstructed',
  'disk-current': 'Current Disk',
  'git-fallback': 'Git Fallback',
  unavailable: 'Missing on disk',
};

interface FileSectionHeaderProps {
  file: FileChangeSummary;
  fileContent: FileChangeWithContent | null;
  fileDecision: HunkDecision | undefined;
  hasEdits: boolean;
  applying: boolean;
  isCollapsed: boolean;
  onToggleCollapse: (filePath: string) => void;
  onDiscard: (filePath: string) => void;
  onSave: (filePath: string) => void;
  onRestoreMissingFile?: (filePath: string, content: string) => void;
}

export const FileSectionHeader = ({
  file,
  fileContent,
  fileDecision,
  hasEdits,
  applying,
  isCollapsed,
  onToggleCollapse,
  onDiscard,
  onSave,
  onRestoreMissingFile,
}: FileSectionHeaderProps): React.ReactElement => {
  const isMissingOnDisk = fileContent?.contentSource === 'unavailable';
  const restoreContent =
    fileContent?.modifiedFullContent ??
    (() => {
      const writeSnippets = file.snippets.filter(
        (s) => !s.isError && (s.type === 'write-new' || s.type === 'write-update')
      );
      if (writeSnippets.length === 0) return null;
      return writeSnippets[writeSnippets.length - 1].newString;
    })();
  const canRestore =
    !!onRestoreMissingFile && isMissingOnDisk && !hasEdits && restoreContent != null;

  const handleHeaderClick = (e: React.MouseEvent): void => {
    // Don't collapse when clicking action buttons
    if ((e.target as HTMLElement).closest('[data-no-collapse]')) return;
    onToggleCollapse(file.filePath);
  };

  const handleHeaderKeyDown = (e: React.KeyboardEvent): void => {
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      onToggleCollapse(file.filePath);
    }
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={handleHeaderClick}
      onKeyDown={handleHeaderKeyDown}
      className="hover:bg-surface-raised/50 sticky top-0 z-10 flex cursor-pointer select-none items-center gap-2 border-b border-border bg-surface-sidebar px-4 py-2"
    >
      <span className="flex shrink-0 items-center text-text-muted">
        {isCollapsed ? <ChevronRight className="size-3.5" /> : <ChevronDown className="size-3.5" />}
      </span>
      <span className="text-xs font-medium text-text">{file.relativePath}</span>

      {file.isNewFile && (
        <span className="rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] text-green-400">
          NEW
        </span>
      )}

      {fileContent?.contentSource && (
        <Tooltip>
          <TooltipTrigger asChild>
            <span
              className={[
                'rounded px-1.5 py-0.5 text-[10px]',
                fileContent.contentSource === 'unavailable'
                  ? 'bg-red-500/20 text-red-300'
                  : 'bg-surface-raised text-text-muted',
              ].join(' ')}
            >
              {CONTENT_SOURCE_LABELS[fileContent.contentSource] ?? fileContent.contentSource}
            </span>
          </TooltipTrigger>
          <TooltipContent side="bottom" className="max-w-xs">
            {fileContent.contentSource === 'unavailable' ? (
              <div className="space-y-1">
                <div className="font-medium text-text">File is missing on disk</div>
                <div className="text-text-muted">
                  We can still show a preview from agent logs, but your filesystem is out of sync.
                </div>
                {restoreContent != null ? (
                  <div className="text-text-muted">
                    Use <span className="font-medium text-text">Restore</span> to write the preview
                    content back to disk.
                  </div>
                ) : (
                  <div className="text-text-muted">
                    Full file content is not available to restore automatically.
                  </div>
                )}
              </div>
            ) : (
              <span>
                {CONTENT_SOURCE_LABELS[fileContent.contentSource] ?? fileContent.contentSource}
              </span>
            )}
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

      <div className="ml-auto flex items-center gap-1.5" data-no-collapse>
        {canRestore && restoreContent != null && (
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                onClick={() => onRestoreMissingFile?.(file.filePath, restoreContent)}
                disabled={applying}
                className="flex items-center gap-1 rounded bg-blue-500/15 px-2 py-1 text-xs text-blue-300 transition-colors hover:bg-blue-500/25 disabled:opacity-50"
              >
                <FilePlus className="size-3" />
                Restore
              </button>
            </TooltipTrigger>
            <TooltipContent side="bottom">
              Create/restore this file on disk from the preview
            </TooltipContent>
          </Tooltip>
        )}
        {hasEdits && (
          <>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onDiscard(file.filePath)}
                  className="flex items-center gap-1 rounded bg-orange-500/15 px-2 py-1 text-xs text-orange-400 transition-colors hover:bg-orange-500/25"
                >
                  <Undo2 className="size-3" />
                  Discard
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">Discard all edits for this file</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <button
                  onClick={() => onSave(file.filePath)}
                  disabled={applying}
                  className="flex items-center gap-1 rounded bg-green-500/15 px-2 py-1 text-xs text-green-400 transition-colors hover:bg-green-500/25 disabled:opacity-50"
                >
                  {applying ? (
                    <Loader2 className="size-3 animate-spin" />
                  ) : (
                    <Save className="size-3" />
                  )}
                  Save File
                </button>
              </TooltipTrigger>
              <TooltipContent side="bottom">
                <span>Save file to disk</span>
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
