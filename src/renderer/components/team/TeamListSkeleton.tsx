export const TeamListSkeleton = ({ label }: { label: string }) => (
  <div role="status" aria-busy="true" className="motion-safe:animate-pulse">
    <span className="sr-only">{label}</span>
    <div aria-hidden="true">
      <div className="mb-4">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="h-5 w-28 rounded bg-[var(--color-surface-raised)]" />
          <div
            data-testid="team-list-skeleton-header-actions"
            className="flex min-w-0 flex-wrap items-center gap-2"
          >
            {['w-44', 'w-24', 'w-20', 'w-32'].map((width) => (
              <div
                key={width}
                className={`h-8 ${width} rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)]`}
              />
            ))}
          </div>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <div
            data-testid="team-list-skeleton-search"
            className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-[var(--color-border)] px-2.5"
          >
            <div className="size-3.5 rounded-full bg-[var(--color-surface-raised)]" />
            <div className="h-3 w-28 rounded bg-[var(--color-surface-raised)]" />
          </div>
          <div
            data-testid="team-list-skeleton-filter"
            className="size-8 shrink-0 rounded-md bg-[var(--color-surface-raised)]"
          />
        </div>
      </div>
      <div className="team-row-zebra-grid grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {Array.from({ length: 6 }, (_, index) => (
          <div
            key={index}
            data-testid="team-list-skeleton-card"
            className="team-row-zebra-card rounded-lg border border-[var(--color-border)] p-4"
          >
            <div className="flex items-start gap-2.5">
              <div className="size-8 shrink-0 rounded-md bg-[var(--color-surface-raised)]" />
              <div className="mt-1 h-4 w-2/5 rounded bg-[var(--color-surface-raised)]" />
              <div className="ml-auto h-5 w-14 rounded-full bg-[var(--color-surface-raised)]" />
            </div>
            <div className="mt-2 flex h-6 items-center">
              <div className="h-4 w-20 rounded bg-[var(--color-surface-raised)]" />
            </div>
            <div className="mt-2 min-h-10 space-y-1.5">
              <div className="h-3 w-4/5 rounded bg-[var(--color-surface-raised)]" />
              <div className="h-3 w-3/5 rounded bg-[var(--color-surface-raised)]" />
            </div>
            <div className="mt-3 flex h-5 items-center gap-3">
              <div className="h-4 w-16 rounded-full bg-[var(--color-surface-raised)]" />
              <div className="h-4 w-12 rounded-full bg-[var(--color-surface-raised)]" />
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
);
