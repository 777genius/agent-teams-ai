import React from 'react';

import { Clock3, FileDiff, LoaderCircle, Sparkles } from 'lucide-react';

interface FullDiffLoadingBannerProps {
  totalFilesCount: number;
  readyFilesCount: number;
  loadingFilesCount: number;
  snippetCount: number;
  activeFileName?: string;
}

export const FullDiffLoadingBanner = ({
  totalFilesCount,
  readyFilesCount,
  loadingFilesCount,
  snippetCount,
  activeFileName,
}: FullDiffLoadingBannerProps): React.ReactElement => {
  const title =
    loadingFilesCount === 1 ? 'Preparing Full Diff' : `Preparing ${loadingFilesCount} Full Diffs`;
  const subtitle =
    loadingFilesCount === 1
      ? activeFileName
        ? `Finalizing the exact editor diff for ${activeFileName}.`
        : 'Finalizing the exact editor diff for the current file.'
      : 'Resolving exact before/after baselines for the files currently loading.';
  const showFileProgress = totalFilesCount > 1;
  const progressPercent =
    totalFilesCount > 0 ? Math.max(0, Math.min(100, (readyFilesCount / totalFilesCount) * 100)) : 0;

  return (
    <div className="bg-surface/95 border-b border-border px-4 py-3">
      <div className="bg-surface-raised/80 rounded-xl border border-border shadow-sm">
        <div className="flex items-start gap-3 p-3">
          <div className="relative mt-0.5 flex size-9 shrink-0 items-center justify-center rounded-xl border border-border bg-surface-sidebar">
            <div className="absolute inset-1 rounded-lg bg-emerald-500/10 blur-sm" />
            <LoaderCircle
              className="relative size-4 animate-spin text-emerald-400"
              strokeWidth={1.8}
            />
          </div>

          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="inline-flex items-center gap-1 rounded-full border border-emerald-500/20 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-medium uppercase tracking-[0.14em] text-emerald-300">
                <Sparkles className="size-3" strokeWidth={1.8} />
                {title}
              </span>
              {activeFileName ? (
                <span className="truncate text-sm font-medium text-text">{activeFileName}</span>
              ) : null}
            </div>

            <p className="mt-1 text-xs leading-5 text-text-secondary">{subtitle}</p>

            <div className="mt-2 flex flex-wrap gap-2">
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-sidebar px-2 py-1 text-[11px] text-text-secondary">
                <FileDiff className="size-3.5" strokeWidth={1.8} />
                {snippetCount} preview{snippetCount === 1 ? '' : 's'} ready
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-sidebar px-2 py-1 text-[11px] text-text-secondary">
                <Clock3 className="size-3.5" strokeWidth={1.8} />
                Editor view loading
              </span>
              <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-sidebar px-2 py-1 text-[11px] text-text-secondary">
                <FileDiff className="size-3.5" strokeWidth={1.8} />
                {loadingFilesCount} file{loadingFilesCount === 1 ? '' : 's'} in progress
              </span>
              {showFileProgress ? (
                <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface-sidebar px-2 py-1 text-[11px] text-text-secondary">
                  <FileDiff className="size-3.5" strokeWidth={1.8} />
                  {readyFilesCount}/{totalFilesCount} files ready
                </span>
              ) : null}
            </div>
          </div>
        </div>

        <div className="px-3 pb-3">
          <div className="h-2 overflow-hidden rounded-full bg-surface-sidebar">
            <div
              className="relative h-full rounded-full bg-emerald-500/20 transition-[width] duration-500 ease-out"
              style={{ width: `${showFileProgress ? progressPercent : 100}%` }}
            >
              <div
                className="absolute inset-0 rounded-full bg-gradient-to-r from-emerald-400/20 via-emerald-300/80 to-emerald-400/20"
                style={{ animation: 'full-diff-loader-slide 1.6s ease-in-out infinite' }}
              />
            </div>
          </div>
          <p className="mt-2 text-[11px] text-text-muted">
            {showFileProgress
              ? `${readyFilesCount} ready, ${loadingFilesCount} still loading. Preview diffs stay visible below while the remaining baselines are resolved.`
              : 'Preview diffs stay visible below while the exact baseline is resolved.'}
          </p>
        </div>
      </div>

      <style>{`
        @keyframes full-diff-loader-slide {
          0% { transform: translateX(-110%); }
          50% { transform: translateX(110%); }
          100% { transform: translateX(320%); }
        }
      `}</style>
    </div>
  );
};
