import { cn } from '@renderer/lib/utils';
import {
  Check,
  Columns2,
  Eye,
  EyeOff,
  GitMerge,
  Loader2,
  Pencil,
  Rows2,
  Save,
  Undo2,
  X,
} from 'lucide-react';

import type { ChangeStats } from '@shared/types';

interface ReviewToolbarProps {
  stats: { pending: number; accepted: number; rejected: number };
  changeStats: ChangeStats;
  diffViewMode: 'unified' | 'split';
  collapseUnchanged: boolean;
  applying: boolean;
  autoViewed: boolean;
  onAutoViewedChange: (auto: boolean) => void;
  onAcceptAll: () => void;
  onRejectAll: () => void;
  onApply: () => void;
  onDiffViewModeChange: (mode: 'unified' | 'split') => void;
  onCollapseUnchangedChange: (collapse: boolean) => void;
  // Editable diff props
  editedCount?: number;
  hasCurrentFileEdits?: boolean;
  saving?: boolean;
  onSaveCurrentFile?: () => void;
  onDiscardCurrentFile?: () => void;
}

export const ReviewToolbar = ({
  stats,
  changeStats,
  diffViewMode,
  collapseUnchanged,
  applying,
  autoViewed,
  onAutoViewedChange,
  onAcceptAll,
  onRejectAll,
  onApply,
  onDiffViewModeChange,
  onCollapseUnchangedChange,
  editedCount = 0,
  hasCurrentFileEdits = false,
  saving = false,
  onSaveCurrentFile,
  onDiscardCurrentFile,
}: ReviewToolbarProps) => {
  const hasRejected = stats.rejected > 0;
  const canApply = hasRejected && !applying;

  return (
    <div className="flex items-center gap-3 border-b border-border bg-surface-sidebar px-4 py-2">
      {/* Decision stats */}
      <div className="flex items-center gap-2 text-xs">
        {stats.pending > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-zinc-500/20 px-2 py-0.5 text-zinc-400">
            {stats.pending} pending
          </span>
        )}
        {stats.accepted > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-green-500/20 px-2 py-0.5 text-green-400">
            <Check className="size-3" />
            {stats.accepted} accepted
          </span>
        )}
        {stats.rejected > 0 && (
          <span className="inline-flex items-center gap-1 rounded-full bg-red-500/20 px-2 py-0.5 text-red-400">
            <X className="size-3" />
            {stats.rejected} rejected
          </span>
        )}
      </div>

      {/* Change stats */}
      <div className="flex items-center gap-1 text-xs text-text-muted">
        <span className="text-green-400">+{changeStats.linesAdded}</span>
        <span className="text-red-400">-{changeStats.linesRemoved}</span>
        <span className="ml-1">across {changeStats.filesChanged} files</span>
      </div>

      <div className="flex-1" />

      {/* View toggles */}
      <div className="flex items-center gap-1 rounded-md border border-border bg-surface p-0.5">
        <button
          onClick={() => onDiffViewModeChange('unified')}
          className={cn(
            'rounded px-2 py-1 text-xs transition-colors',
            diffViewMode === 'unified'
              ? 'bg-surface-raised text-text'
              : 'text-text-muted hover:text-text'
          )}
          title="Unified view"
        >
          <Rows2 className="size-3.5" />
        </button>
        <button
          onClick={() => onDiffViewModeChange('split')}
          className={cn(
            'rounded px-2 py-1 text-xs transition-colors',
            diffViewMode === 'split'
              ? 'bg-surface-raised text-text'
              : 'text-text-muted hover:text-text'
          )}
          title="Split view"
        >
          <Columns2 className="size-3.5" />
        </button>
      </div>

      <button
        onClick={() => onCollapseUnchangedChange(!collapseUnchanged)}
        className={cn(
          'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
          collapseUnchanged ? 'bg-surface-raised text-text' : 'text-text-muted hover:text-text'
        )}
        title={collapseUnchanged ? 'Show all lines' : 'Collapse unchanged'}
      >
        {collapseUnchanged ? <EyeOff className="size-3.5" /> : <Eye className="size-3.5" />}
      </button>

      <button
        onClick={() => onAutoViewedChange(!autoViewed)}
        className={cn(
          'flex items-center gap-1 rounded px-2 py-1 text-xs transition-colors',
          autoViewed ? 'bg-surface-raised text-text' : 'text-text-muted hover:text-text'
        )}
        title={autoViewed ? 'Auto-mark viewed: ON' : 'Auto-mark viewed: OFF'}
      >
        {autoViewed ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
        <span className="text-[10px]">Auto</span>
      </button>

      <div className="h-4 w-px bg-border" />

      {/* Edited files indicator + actions */}
      {hasCurrentFileEdits && (
        <>
          <button
            onClick={onSaveCurrentFile}
            disabled={saving}
            className="flex items-center gap-1 rounded bg-green-500/15 px-2 py-1 text-xs text-green-400 transition-colors hover:bg-green-500/25 disabled:opacity-50"
            title="Save file to disk (Cmd+Enter)"
          >
            {saving ? <Loader2 className="size-3 animate-spin" /> : <Save className="size-3" />}
            Save File
          </button>
          <button
            onClick={onDiscardCurrentFile}
            className="flex items-center gap-1 rounded bg-orange-500/15 px-2 py-1 text-xs text-orange-400 transition-colors hover:bg-orange-500/25"
            title="Discard edits for this file"
          >
            <Undo2 className="size-3" /> Discard
          </button>
        </>
      )}
      {editedCount > 0 && (
        <span className="inline-flex items-center gap-1 rounded-full bg-amber-500/20 px-2 py-0.5 text-xs text-amber-400">
          <Pencil className="size-3" /> {editedCount} edited
        </span>
      )}

      {(hasCurrentFileEdits || editedCount > 0) && <div className="h-4 w-px bg-border" />}

      {/* Actions */}
      <button
        onClick={onAcceptAll}
        className="flex items-center gap-1 rounded bg-green-500/15 px-2.5 py-1 text-xs text-green-400 transition-colors hover:bg-green-500/25"
      >
        <Check className="size-3" />
        Accept All
      </button>

      <button
        onClick={onRejectAll}
        className="flex items-center gap-1 rounded bg-red-500/15 px-2.5 py-1 text-xs text-red-400 transition-colors hover:bg-red-500/25"
      >
        <X className="size-3" />
        Reject All
      </button>

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
        {applying ? <Loader2 className="size-3 animate-spin" /> : <GitMerge className="size-3" />}
        {applying ? 'Applying...' : 'Apply Changes'}
      </button>
    </div>
  );
};
