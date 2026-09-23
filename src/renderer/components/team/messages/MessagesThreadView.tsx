import { cn } from '@renderer/lib/utils';

interface MessagesThreadViewProps {
  variant: 'sidebar' | 'wide';
  header?: React.ReactNode;
  search?: React.ReactNode;
  composer: React.ReactNode;
  status: React.ReactNode;
  timeline: React.ReactNode;
  scrollRef: React.Ref<HTMLDivElement>;
  composerRef?: React.Ref<HTMLDivElement>;
  searchRef?: React.Ref<HTMLDivElement>;
  latestControl?: React.ReactNode;
  onScroll?: React.UIEventHandler<HTMLDivElement>;
}

/** Shared, fixed thread tree used by sidebar, Full Screen, and Bottom Sheet. */
export const MessagesThreadView = ({
  variant,
  header,
  search,
  composer,
  status,
  timeline,
  scrollRef,
  composerRef,
  searchRef,
  latestControl,
  onScroll,
}: Readonly<MessagesThreadViewProps>): React.JSX.Element => {
  const wide = variant === 'wide';
  return (
    <div
      className={cn(
        'flex size-full min-h-0 min-w-0 flex-col overflow-hidden bg-[var(--color-surface-sidebar)]',
        wide && 'bg-[var(--color-surface)]'
      )}
      data-messages-thread-layout={variant}
    >
      {header ? (
        <div className="shrink-0 border-b border-[var(--color-border)] px-4 py-2.5">{header}</div>
      ) : null}
      {search ? (
        <div ref={searchRef} className="shrink-0 border-b border-[var(--color-border)] px-3 py-1.5">
          {search}
        </div>
      ) : null}
      <div className="relative min-h-0 min-w-0 flex-1">
        <div
          ref={scrollRef}
          className={cn(
            'size-full overflow-y-auto overflow-x-hidden',
            wide ? 'touch-pan-y overscroll-contain px-4 py-2' : 'px-3 py-2'
          )}
          onScroll={onScroll}
          data-messages-thread-scroll="true"
        >
          {status}
          <div className="min-w-0">{timeline}</div>
        </div>
        {latestControl ? (
          <div className="pointer-events-none absolute bottom-3 right-3 z-10">
            <div className="pointer-events-auto">{latestControl}</div>
          </div>
        ) : null}
      </div>
      <div
        ref={composerRef}
        data-messages-thread-footer="true"
        className="max-h-full min-h-0 overflow-y-auto border-t border-[var(--color-border)] px-3 py-2"
      >
        <div data-messages-composer-content="true">{composer}</div>
      </div>
    </div>
  );
};
