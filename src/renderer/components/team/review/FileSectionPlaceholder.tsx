import React from 'react';

import { FileDiff, LoaderCircle } from 'lucide-react';

interface FileSectionPlaceholderProps {
  fileName: string;
}

export const FileSectionPlaceholder = ({
  fileName,
}: FileSectionPlaceholderProps): React.ReactElement => (
  <div className="bg-surface-raised/70 overflow-hidden rounded-xl border border-border shadow-sm">
    <div className="bg-surface-sidebar/80 flex items-center gap-3 border-b border-border px-4 py-3">
      <div className="flex size-9 items-center justify-center rounded-xl border border-border bg-surface">
        <LoaderCircle className="size-4 animate-spin text-text-secondary" strokeWidth={1.8} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-text">{fileName}</span>
          <span className="inline-flex items-center gap-1 rounded-full border border-border bg-surface px-2 py-0.5 text-[10px] uppercase tracking-[0.14em] text-text-muted">
            <FileDiff className="size-3" strokeWidth={1.8} />
            Loading
          </span>
        </div>
        <p className="mt-1 text-xs text-text-muted">Preparing a full editor diff for this file.</p>
      </div>
    </div>

    <div className="space-y-3 p-4">
      <div className="h-3 w-28 animate-pulse rounded-full bg-surface-sidebar" />
      <div className="space-y-2">
        <div className="h-4 w-3/4 animate-pulse rounded bg-surface-sidebar" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-surface-sidebar" />
        <div className="h-4 w-5/6 animate-pulse rounded bg-surface-sidebar" />
        <div className="h-4 w-2/3 animate-pulse rounded bg-surface-sidebar" />
      </div>
    </div>
  </div>
);
