import type { ReactElement } from 'react';

interface KanbanTaskCardSkeletonProps {
  height: number;
  showSeparator?: boolean;
}

export const KanbanTaskCardSkeleton = ({
  height,
  showSeparator = false,
}: KanbanTaskCardSkeletonProps): ReactElement => (
  <div
    className="kanban-task-card-skeleton kanban-task-card-flat relative shrink-0 overflow-hidden bg-transparent py-3 pl-3 pr-1.5"
    data-task-separator={showSeparator ? 'true' : undefined}
    style={{ height }}
  >
    <div className="absolute left-3 right-1.5 top-1.5 flex min-w-0 items-center justify-between gap-2">
      <div className="flex min-w-0 items-center gap-1.5">
        <div className="h-2 w-14 rounded bg-[var(--skeleton-base-dim)]" />
        <div className="size-3 rounded bg-[var(--skeleton-base-dim)]" />
        <div className="size-3 rounded-full bg-blue-500/25" />
        <div className="h-2 w-2 rounded bg-[var(--skeleton-base-dim)]" />
      </div>
      <div className="flex shrink-0 items-center gap-1" data-kanban-skeleton-owner>
        <div className="size-4 rounded-full bg-[var(--skeleton-base)]" />
        <div className="h-2 w-8 rounded bg-[var(--skeleton-base-dim)]" />
      </div>
    </div>
    <div className="flex h-full flex-col">
      <div className="mb-2 pt-5">
        <div className="h-4 w-[84%] rounded bg-[var(--skeleton-base)]" />
        <div className="mt-2 h-4 w-[68%] rounded bg-[var(--skeleton-base-dim)]" />
      </div>
      {height > 110 ? (
        <div className="mt-3 flex items-center gap-1.5">
          <div className="size-3 rounded bg-[var(--skeleton-base-dim)]" />
          <div className="h-2 w-16 rounded bg-[var(--skeleton-base-dim)]" />
          <div className="h-2 flex-1 rounded bg-[var(--skeleton-base-dim)]" />
        </div>
      ) : null}
    </div>
  </div>
);
